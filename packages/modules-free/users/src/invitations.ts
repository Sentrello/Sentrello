import { createHash, randomBytes } from "node:crypto";
import { auth, clientIp } from "@sentrello/auth";
import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, schema } from "@sentrello/db";
import { record } from "@sentrello/db/security-events";
import {
  emailAdapter,
  mailConfigured,
  systemFrom,
  systemReplyTo,
} from "@sentrello/email";
import { invitationEmail } from "@sentrello/email/templates";
import { type ModuleContext, rateLimit } from "@sentrello/module-sdk";
import { and, eq } from "drizzle-orm";

/**
 * Invitations that actually admit somebody.
 *
 * The screen has always been able to write an invitation down; what was
 * missing was every way for the invited person to use it. Three parts land
 * here:
 *
 * **A link that is a credential.** The invitation record is Better Auth's —
 * its accept endpoint is what marks it used, checks its expiry and creates
 * the membership — but the URL carries a token of our own: 32 random bytes,
 * shown once in the link handed back at creation, kept only as a SHA-256
 * hash on the row. Whoever holds the link joins the business, so the link is
 * stored the way a password is, and a copy of the database is not a way in.
 *
 * **A first-class copyable link.** A fresh instance usually has no mail
 * server yet, and that is exactly when the first colleague is invited. The
 * create route always answers with the link and says honestly whether an
 * email went — never "sent" when nothing was.
 *
 * **A public accept path.** The invited person lands on `/accept-invitation`,
 * proves they are the address the invitation names — a new account with a
 * password of their own, their existing password, or the session they are
 * already signed in with — and Better Auth's own accept endpoint does the
 * rest: recipient check, expiry check, single use, the membership with the
 * role the inviter chose, and the session pointed at the right organization.
 */

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** What the server said, when Better Auth refused something. */
const refusalMessage = (e: unknown): string =>
  (e as { body?: { message?: string } })?.body?.message ??
  (e instanceof Error ? e.message : "refused");

type TokenLookup =
  | { state: "missing" }
  | {
      state: "ok" | "used" | "withdrawn" | "expired";
      invitation: {
        id: string;
        organizationId: string;
        email: string;
        role: string | null;
        status: string;
        expiresAt: Date;
      };
    };

/**
 * The invitation a link names, and whether it still admits anybody.
 *
 * Looked up by the hash of the presented token — the token itself is nowhere
 * in the database. The states are distinct because the person on the other
 * end needs different words for each: a mistyped link, one already used, one
 * an administrator withdrew, and one that sat in an inbox too long.
 */
async function byToken(token: string): Promise<TokenLookup> {
  if (!token || token.length < 20) return { state: "missing" };
  const [invitation] = await db
    .select({
      id: schema.invitation.id,
      organizationId: schema.invitation.organizationId,
      email: schema.invitation.email,
      role: schema.invitation.role,
      status: schema.invitation.status,
      expiresAt: schema.invitation.expiresAt,
    })
    .from(schema.invitation)
    .where(eq(schema.invitation.tokenHash, sha256(token)))
    .limit(1);
  if (!invitation) return { state: "missing" };
  if (invitation.status === "accepted") return { state: "used", invitation };
  if (invitation.status !== "pending")
    return { state: "withdrawn", invitation };
  if (invitation.expiresAt < new Date())
    return { state: "expired", invitation };
  return { state: "ok", invitation };
}

/** 410 for a link that once worked, with the reason in plain words. */
function goneBody(state: "used" | "withdrawn" | "expired") {
  return {
    error: state,
    message: {
      used: "This invitation has already been accepted.",
      withdrawn: "This invitation was withdrawn. Ask to be invited again.",
      expired: "This invitation has expired. Ask to be invited again.",
    }[state],
  };
}

export function registerInvitations(ctx: ModuleContext) {
  /**
   * Inviting somebody, with a link that works.
   *
   * The record and its permission check are Better Auth's `createInvitation`,
   * called as the administrator making the request. Re-inviting an address
   * that already holds a pending invitation refreshes it — and mints a new
   * token, so the old link stops working the moment a new one exists.
   */
  ctx.app.post(
    "/api/users/invitations",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c) => {
      const session = c.get("session");
      const orgId = activeOrganizationId(session);
      const body = (await c.req.json().catch(() => ({}))) as {
        email?: unknown;
        role?: unknown;
      };
      const email = String(body.email ?? "")
        .trim()
        .toLowerCase();
      const role = String(body.role ?? "").trim();
      if (!email || !role) {
        return c.json({ error: "an email and a role are required" }, 400);
      }

      let invitation: { id: string; expiresAt: Date };
      try {
        invitation = await auth.api.createInvitation({
          body: {
            email,
            // Better Auth types the role as its own union; dynamic roles
            // ("staff", "admins") are checked at runtime against the table.
            role: role as "member",
            organizationId: orgId,
            resend: true,
          },
          headers: c.req.raw.headers,
        });
      } catch (e) {
        return c.json({ error: refusalMessage(e) }, 400);
      }

      // The credential. Shown once, in the link below; only its hash is kept.
      const token = randomBytes(32).toString("base64url");
      await db
        .update(schema.invitation)
        .set({ tokenHash: sha256(token) })
        .where(
          and(
            eq(schema.invitation.id, invitation.id),
            eq(schema.invitation.organizationId, orgId),
          ),
        );

      const base = process.env.SENTRELLO_BASE_URL ?? new URL(c.req.url).origin;
      const link = `${base}/accept-invitation?token=${token}`;

      // Through the platform's one mail path, and honestly: a fresh instance
      // often has no mail server at all, and "sent" must never be claimed
      // when nothing was. The link above is the answer either way.
      let emailSent = false;
      if (mailConfigured()) {
        const [org] = await db
          .select({ name: schema.organizations.name })
          .from(schema.organizations)
          .where(eq(schema.organizations.id, orgId))
          .limit(1);
        const mail = invitationEmail({
          url: link,
          organizationName: org?.name ?? "a business",
          inviterName: session.user.name,
          expiresAt: invitation.expiresAt,
        });
        try {
          await emailAdapter().send({
            from: systemFrom(),
            to: email,
            subject: mail.subject,
            html: mail.html,
            headers: systemReplyTo(),
          });
          emailSent = true;
        } catch {
          // The response says so; the administrator has the link to send.
        }
      }

      await record({
        organizationId: orgId,
        actor: session.user,
        subject: { id: null, name: email },
        action: "member.invited",
        detail: { role },
      });

      return c.json(
        {
          id: invitation.id,
          email,
          role,
          expiresAt: invitation.expiresAt,
          link,
          emailSent,
        },
        201,
      );
    },
  );

  /**
   * What a link points at, before anybody commits to a password.
   *
   * Public: the person holding the link has no account yet. It answers with
   * what the accept screen needs to ask the right questions — whose
   * invitation, to which business, and whether this address already has an
   * account here — and nothing else.
   */
  ctx.app.get("/api/invitations/:token", async (c) => {
    // Guessing tokens is limited as well as futile: 32 random bytes make
    // guessing hopeless, and the limit keeps a scanner from burning the
    // database on lookups — the same shape as the bootstrap route's guard.
    const limit = rateLimit(`invitation:${clientIp(c)}`, 30, 15 * 60_000);
    if (!limit.allowed) {
      return c.json({ error: "too_many_attempts" }, 429, {
        "retry-after": String(limit.retryAfterSeconds),
      });
    }

    const found = await byToken(c.req.param("token"));
    if (found.state === "missing") return c.json({ error: "not_found" }, 404);
    if (found.state !== "ok") return c.json(goneBody(found.state), 410);

    const { invitation } = found;
    const [org] = await db
      .select({ name: schema.organizations.name })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, invitation.organizationId))
      .limit(1);
    const [existing] = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, invitation.email))
      .limit(1);
    const session = await auth.api
      .getSession({ headers: c.req.raw.headers })
      .catch(() => null);

    return c.json({
      email: invitation.email,
      role: invitation.role,
      organization: org?.name ?? "this business",
      expiresAt: invitation.expiresAt,
      userExists: Boolean(existing),
      signedInAsInvitee:
        session?.user.email.toLowerCase() === invitation.email.toLowerCase(),
    });
  });

  /**
   * Accepting: the invited person becomes a member, signed in.
   *
   * The token says which invitation; proving you are its recipient is
   * separate, because the recipient check belongs to Better Auth's accept
   * endpoint and works on a session. Three ways to hold one: already signed
   * in as the invited address; an existing account and its password; or a
   * new account, created here — the one door `signUpAllowed` opens for a
   * pending invitation on an otherwise closed instance.
   */
  ctx.app.post("/api/invitations/:token/accept", async (c) => {
    // Guessing tokens is limited as well as futile: 32 random bytes make
    // guessing hopeless, and the limit keeps a scanner from burning the
    // database on lookups — the same shape as the bootstrap route's guard.
    const limit = rateLimit(`invitation:${clientIp(c)}`, 30, 15 * 60_000);
    if (!limit.allowed) {
      return c.json({ error: "too_many_attempts" }, 429, {
        "retry-after": String(limit.retryAfterSeconds),
      });
    }

    const found = await byToken(c.req.param("token"));
    if (found.state === "missing") return c.json({ error: "not_found" }, 404);
    if (found.state !== "ok") return c.json(goneBody(found.state), 410);
    const { invitation } = found;

    const body = (await c.req.json().catch(() => ({}))) as {
      name?: unknown;
      password?: unknown;
    };
    const password = typeof body.password === "string" ? body.password : "";
    const name = String(body.name ?? "").trim();

    // A session as the invited address, however they can honestly get one.
    let cookie: string | null = null;
    let acceptHeaders: Headers;
    const current = await auth.api
      .getSession({ headers: c.req.raw.headers })
      .catch(() => null);
    if (current?.user.email.toLowerCase() === invitation.email.toLowerCase()) {
      acceptHeaders = c.req.raw.headers;
    } else {
      const [existing] = await db
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(eq(schema.user.email, invitation.email))
        .limit(1);
      if (!password) {
        return c.json(
          {
            error: existing
              ? "your password is required"
              : "a name and a password are required",
          },
          400,
        );
      }
      try {
        if (existing) {
          const signIn = await auth.api.signInEmail({
            body: { email: invitation.email, password },
            returnHeaders: true,
          });
          if ("twoFactorRedirect" in signIn.response) {
            // Half a sign-in is not a session. Their normal sign-in page
            // handles the second factor; the link works again afterwards.
            return c.json(
              {
                error:
                  "this account uses two-factor sign-in — sign in first, then open the link again",
              },
              409,
            );
          }
          cookie = signIn.headers.get("set-cookie");
        } else {
          if (!name) {
            return c.json({ error: "a name and a password are required" }, 400);
          }
          const signUp = await auth.api.signUpEmail({
            body: { email: invitation.email, password, name },
            returnHeaders: true,
          });
          cookie = signUp.headers.get("set-cookie");
        }
      } catch (e) {
        return c.json({ error: refusalMessage(e) }, 400);
      }
      if (!cookie) return c.json({ error: "could not sign you in" }, 500);
      acceptHeaders = new Headers({ cookie });
    }

    // Better Auth's own accept: recipient must match, invitation must still
    // be pending and unexpired, the flip to "accepted" is atomic — single
    // use — and the membership lands in the invitation's organization with
    // the invitation's role. A token can only ever admit to the organization
    // its own row names.
    try {
      await auth.api.acceptInvitation({
        body: { invitationId: invitation.id },
        headers: acceptHeaders,
      });
    } catch (e) {
      return c.json({ error: refusalMessage(e) }, 403);
    }

    const joined = await auth.api.getSession({ headers: acceptHeaders });
    if (joined) {
      await record({
        organizationId: invitation.organizationId,
        actor: joined.user,
        action: "member.joined",
        detail: { role: invitation.role },
      });
    }

    // The session cookie, so they land signed in rather than at a login form.
    if (cookie) c.header("set-cookie", cookie);
    return c.json({ joined: true });
  });
}
