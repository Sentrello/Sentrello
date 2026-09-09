import { asActor } from "@sentrello/db";
import { hipaaRulesFor } from "@sentrello/db/security-events";
import type { SentrelloEnv, SentrelloSession } from "@sentrello/module-sdk";
import type { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { auth } from "./index";

export type Session = NonNullable<
  Awaited<ReturnType<typeof auth.api.getSession>>
>;

/** The Hono environment every Sentrello route runs in. */
export type AppEnv = SentrelloEnv;

/**
 * "Invalid origin" is the right refusal and a useless explanation.
 *
 * Better Auth rejects a sign-in whose Origin is not the configured baseURL,
 * which is correct — it is what stops another site posting credentials here.
 * But the person reading it is almost always the owner of a self-hosted
 * instance who reached their own app by a name `SENTRELLO_BASE_URL` does not
 * mention: an IP, `localhost`, `www.` where the setting has the bare domain.
 * Two words with no pointer to the setting turns a one-line fix into a support
 * conversation, so the reply names the setting, what it is, and what was
 * actually asked for.
 *
 * Exported for its own test: Better Auth skips the origin check entirely under
 * NODE_ENV=test, so the suite cannot reach this through the handler. The
 * rewriting is tested here and the refusal itself verified against a running
 * instance by hand.
 */
export async function explainOrigin(res: Response, origin: string | undefined) {
  if (res.status !== 403) return res;

  const body = await res.clone().text();
  if (!body.includes("Invalid origin")) return res;

  const configured =
    process.env.SENTRELLO_BASE_URL ?? "http://localhost:3000 (the default)";
  return Response.json(
    {
      message: `This instance only accepts sign-ins from ${configured}, and this request came from ${origin ?? "an unknown origin"}. Set SENTRELLO_BASE_URL to the address people actually use to reach it, then restart.`,
      code: "INVALID_ORIGIN",
    },
    { status: 403, headers: res.headers },
  );
}

export function mountAuth(app: Hono<AppEnv>) {
  app.on(["POST", "GET"], "/api/auth/*", async (c) =>
    explainOrigin(await auth.handler(c.req.raw), c.req.header("origin")),
  );
}

/** Route guard: requires a session, attaches it to context. */
export function requireSession() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "unauthorized" }, 401);
    c.set("session", session as SentrelloSession);
    /**
     * Everything this request does is attributed to whoever made it.
     *
     * Set here, in the one place that already knows who they are, and read by
     * `postJournalEntry` — which is several calls below every route that posts
     * and cannot be told any other way without threading an actor through
     * thirty functions that have no other reason to know about sessions.
     */
    /**
     * HIPAA safeguards, where a business has switched them on.
     *
     * Enforced here rather than in each route because here is the one place
     * every guarded request already passes through, and a safeguard applied in
     * most places is not a safeguard. It costs one indexed lookup per request
     * on organisations that have the row, and nothing at all on the ones that
     * do not.
     */
    const refusal = await hipaaRefusal(session, c.req.path);
    if (refusal) return c.json({ error: refusal.error }, refusal.status);

    await asActor(session.user.id, () => next());
  });
}

/**
 * Why this request must not proceed under HIPAA safeguards, if it must not.
 *
 * Two rules, both from §164.312, and both meaningless unless the server is the
 * one applying them — a timeout the browser enforces is a timeout anybody can
 * turn off with the developer tools open.
 */
/**
 * The routes a safeguard must never lock anybody out of.
 *
 * The way back. Requiring a second factor from everybody is correct and it is
 * also a door that closes behind you: an administrator who switches it on
 * without having set one up is refused by every route in the product, including
 * the one that would switch it off again. That is not a hypothetical — it is
 * what this rule did the first time it was tested, and it is the same mistake
 * as closing a firewall port from the far side of the firewall.
 *
 * So the compliance settings themselves stay reachable. It is a narrow
 * exemption: the routes still require a session and the settings permission, so
 * this is an administrator with a password, not the public.
 */
const ALWAYS_REACHABLE = ["/api/compliance", "/api/users/me/security"];

async function hipaaRefusal(
  session: {
    session: {
      activeOrganizationId?: string | null;
      updatedAt?: Date | string;
    };
    user: { twoFactorEnabled?: boolean | null };
  },
  path: string,
): Promise<{ error: string; status: 401 | 403 } | null> {
  const orgId = session.session.activeOrganizationId;
  if (!orgId) return null;

  const rules = await hipaaRulesFor(orgId);
  if (!rules) return null;

  /**
   * Automatic logoff, §164.312(a)(2)(iii).
   *
   * Measured from the session's own last update, which better-auth refreshes as
   * the person uses it. The scenario is not an attacker: it is a receptionist's
   * screen left open in a room patients walk through, and fifteen minutes is
   * the number most practices settle on.
   */
  /*
   * Absent `updatedAt` is not treated as "idle for ever". A session shape that
   * does not carry the field would sign everybody out on every request, which
   * is a broken product rather than a safe one — and the failure would look
   * like the safeguard working.
   */
  const lastSeen = session.session.updatedAt
    ? new Date(session.session.updatedAt).getTime()
    : Date.now();
  if (Date.now() - lastSeen > rules.idleTimeoutMinutes * 60_000) {
    return {
      error: `signed out after ${rules.idleTimeoutMinutes} minutes of inactivity`,
      status: 401,
    };
  }

  /**
   * Person or entity authentication, §164.312(d).
   *
   * Refused rather than nagged. A prompt somebody can dismiss is a prompt
   * everybody dismisses, and the whole point of switching this on is that the
   * business has decided a password alone is not enough for these records.
   * The message says what to do, because a flat "forbidden" on every screen
   * with no explanation is how a practice turns the safeguards back off.
   */
  if (
    rules.requireTwoFactor &&
    !session.user.twoFactorEnabled &&
    !ALWAYS_REACHABLE.some((p) => path.startsWith(p))
  ) {
    return {
      error:
        "this business requires a second factor before you can sign in. Set one up in your profile.",
      status: 403,
    };
  }

  return null;
}

/**
 * Permission guard: e.g. requirePermission({ invoicing: ["send"] }).
 *
 * `auth.api.hasPermission` resolves to `{ error, success }`, never a bare
 * boolean — truthiness-testing the response would let every check pass, so the
 * `success` flag is read explicitly and anything else denies.
 */
export function requirePermission(permissions: Record<string, string[]>) {
  return createMiddleware<AppEnv>(async (c, next) => {
    let granted = false;
    try {
      const result = await auth.api.hasPermission({
        headers: c.req.raw.headers,
        body: { permissions },
      });
      granted = result?.success === true;
    } catch {
      granted = false; // not a member, no active org, malformed request
    }
    if (!granted) return c.json({ error: "forbidden" }, 403);
    await next();
  });
}

/**
 * Whether this request may do something, without refusing it.
 *
 * `requirePermission` answers 403 and stops. This answers the same question so
 * a handler can decide what to *include* — the dashboard asks it once per
 * module summary, because a bookkeeper's first screen should not be missing
 * everything an owner sees, and an owner's should not 403 because one panel
 * was not theirs.
 */
export async function mayAccess(
  headers: Headers,
  permissions: Record<string, string[]>,
): Promise<boolean> {
  try {
    const result = await auth.api.hasPermission({
      headers,
      body: { permissions },
    });
    return result?.success === true;
  } catch {
    return false;
  }
}

/**
 * The organization every business query must be scoped by. Throws rather than
 * returning undefined: a business query that silently loses its org filter is
 * a cross-tenant data leak.
 */
export function activeOrganizationId(session: SentrelloSession): string {
  const orgId = session.session.activeOrganizationId;
  if (!orgId) throw new Error("session has no active organization");
  return orgId;
}
