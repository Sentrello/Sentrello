import { auth } from "@sentrello/auth";
import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, schema } from "@sentrello/db";
import { record } from "@sentrello/db/security-events";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";

/**
 * Signing in with the account a business already has.
 *
 * A firm on Google Workspace or Microsoft 365 has already decided who works
 * there and who has left. Asking them to keep a second list of people here is
 * asking them to forget to remove somebody — which is the way most accounts
 * outlive the person who held them.
 *
 * Three ways in, and the differences are worth naming because a business will
 * pick by what their provider is called rather than by protocol:
 *
 * - **Google Workspace** and **Microsoft 365** are OpenID Connect. The
 *   business creates an application at their provider, pastes back a client id
 *   and secret, and the rest is discovered from the issuer.
 * - **Anything else** — Okta, Entra with SAML, a university's provider — is
 *   SAML, which needs a sign-in URL and the provider's certificate.
 *
 * Whichever it is, arriving through it makes somebody a **member** and nothing
 * more. An identity provider says who a person is; it does not say what they
 * may do in this business's books, and letting it decide would put roles in
 * the hands of whoever administers the email system.
 */

/** What a business picks from, and what each needs. */
const KINDS = {
  google: {
    label: "Google Workspace",
    issuer: "https://accounts.google.com",
    kind: "oidc" as const,
  },
  microsoft: {
    label: "Microsoft 365",
    // The tenant-independent endpoint: a business signs in with whatever
    // Microsoft account their organisation uses, and the app registration is
    // what limits it to them.
    issuer: "https://login.microsoftonline.com/common/v2.0",
    kind: "oidc" as const,
  },
  oidc: {
    label: "Another OpenID provider",
    issuer: null,
    kind: "oidc" as const,
  },
  saml: { label: "SAML", issuer: null, kind: "saml" as const },
};

type Kind = keyof typeof KINDS;

const isKind = (value: unknown): value is Kind =>
  typeof value === "string" && value in KINDS;

/** A domain, as somebody would type it: `example.com`, never an address. */
export function cleanDomain(input: unknown): string | null {
  const raw = String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^@/, "");
  // An email address here is the most likely mistake, and it is one somebody
  // would not notice until nobody could sign in.
  const domain = raw.includes("@") ? (raw.split("@")[1] ?? "") : raw;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) ? domain : null;
}

export function registerSso(ctx: ModuleContext) {
  /** What is connected, and what could be. */
  ctx.app.get(
    "/api/users/sso",
    requireSession(),
    requirePermission({ settings: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const rows = await db
        .select({
          id: schema.ssoProvider.id,
          providerId: schema.ssoProvider.providerId,
          issuer: schema.ssoProvider.issuer,
          domain: schema.ssoProvider.domain,
          oidcConfig: schema.ssoProvider.oidcConfig,
          samlConfig: schema.ssoProvider.samlConfig,
        })
        .from(schema.ssoProvider)
        .where(eq(schema.ssoProvider.organizationId, orgId));

      return c.json({
        kinds: Object.entries(KINDS).map(([id, k]) => ({
          id,
          label: k.label,
          protocol: k.kind,
          needsIssuer: k.issuer === null,
        })),
        connections: rows.map((row) => ({
          id: row.id,
          providerId: row.providerId,
          issuer: row.issuer,
          domain: row.domain,
          protocol: row.samlConfig ? "saml" : "oidc",
          // Never the config itself: it holds the client secret, and a screen
          // that can show it is a screen a screenshot can leak.
          configured: Boolean(row.oidcConfig ?? row.samlConfig),
        })),
      });
    },
  );

  /**
   * Connecting one.
   *
   * Through Better Auth's own registration rather than by writing the row:
   * it discovers what an OpenID provider supports, and a hand-written row
   * would be a connection that fails at the moment somebody first tries it.
   */
  ctx.app.post(
    "/api/users/sso",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c: RouteContext) => {
      const session = c.get("session");
      const orgId = activeOrganizationId(session);
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      if (!isKind(body.kind)) {
        return c.json({ error: "choose a kind of provider" }, 400);
      }
      const kind = KINDS[body.kind];

      const domain = cleanDomain(body.domain);
      if (!domain) {
        return c.json({ error: "a domain like example.com is needed" }, 400);
      }

      const issuer = kind.issuer ?? String(body.issuer ?? "").trim();
      if (!issuer) {
        return c.json({ error: "that provider needs an issuer URL" }, 400);
      }

      // One connection per domain: two providers claiming the same email
      // domain is a sign-in that goes to whichever row was found first.
      const [taken] = await db
        .select({ id: schema.ssoProvider.id })
        .from(schema.ssoProvider)
        .where(eq(schema.ssoProvider.domain, domain))
        .limit(1);
      if (taken) {
        return c.json({ error: `${domain} is already connected` }, 409);
      }

      const providerId = `${body.kind}-${domain.replace(/[^a-z0-9]+/g, "-")}`;

      try {
        if (kind.kind === "oidc") {
          const clientId = String(body.clientId ?? "").trim();
          const clientSecret = String(body.clientSecret ?? "").trim();
          if (!clientId || !clientSecret) {
            return c.json(
              { error: "a client id and secret are both needed" },
              400,
            );
          }

          await auth.api.registerSSOProvider({
            body: {
              providerId,
              issuer,
              domain,
              organizationId: orgId,
              oidcConfig: {
                clientId,
                clientSecret,
                // Discovered from the issuer rather than typed: every one of
                // these URLs is somewhere a mistake is invisible until a
                // person cannot sign in.
                discoveryEndpoint: `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
                scopes: ["openid", "email", "profile"],
                pkce: true,
              },
            },
            headers: c.req.raw.headers,
          });
        } else {
          const entryPoint = String(body.entryPoint ?? "").trim();
          const cert = String(body.certificate ?? "").trim();
          if (!entryPoint || !cert) {
            return c.json(
              { error: "a sign-in URL and the provider's certificate" },
              400,
            );
          }

          const base =
            process.env.SENTRELLO_BASE_URL ?? new URL(c.req.url).origin;
          await auth.api.registerSSOProvider({
            body: {
              providerId,
              issuer,
              domain,
              organizationId: orgId,
              samlConfig: {
                entryPoint,
                cert,
                callbackUrl: `${base}/api/auth/sso/saml2/sp/acs/${providerId}`,
                audience: base,
                wantAssertionsSigned: true,
                signatureAlgorithm: "sha256",
                digestAlgorithm: "sha256",
                identifierFormat:
                  "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
                // What this instance tells the provider about itself. The
                // provider needs an entity id to trust, and the instance's own
                // address is the one thing it certainly has.
                spMetadata: {
                  entityID: base,
                  binding: "post",
                },
              },
            },
            headers: c.req.raw.headers,
          });
        }
      } catch (err) {
        return c.json(
          {
            error: `that provider would not connect: ${(err as Error).message}`,
          },
          400,
        );
      }

      await record({
        organizationId: orgId,
        actor: session.user,
        subject: { id: providerId, name: domain, email: null },
        action: "sso.connected",
        detail: { kind: body.kind, domain },
      });
      return c.json({ providerId, domain }, 201);
    },
  );

  ctx.app.delete(
    "/api/users/sso/:id",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c: RouteContext) => {
      const session = c.get("session");
      const orgId = activeOrganizationId(session);
      const id = c.req.param("id") ?? "";

      const [gone] = await db
        .delete(schema.ssoProvider)
        .where(
          and(
            eq(schema.ssoProvider.id, id),
            eq(schema.ssoProvider.organizationId, orgId),
          ),
        )
        .returning();
      if (!gone) return c.json({ error: "not found" }, 404);

      // The people who arrived through it keep their accounts and their roles.
      // Disconnecting is "stop accepting sign-ins from there", not "delete
      // half the staff" — which is what somebody expects, and the opposite of
      // what deleting the accounts would do to their history.
      await record({
        organizationId: orgId,
        actor: session.user,
        subject: { id: gone.providerId, name: gone.domain, email: null },
        action: "sso.disconnected",
        detail: { domain: gone.domain },
      });
      return c.json({ ok: true });
    },
  );

  /**
   * Whether an email address should be sent to a provider instead of a
   * password box.
   *
   * Asked by the sign-in page before anybody has signed in, so it says only
   * yes or no and never which provider or which business.
   */
  ctx.app.post("/api/users/sso/check", async (c: RouteContext) => {
    const body = (await c.req.json().catch(() => ({}))) as { email?: unknown };
    const domain = cleanDomain(body.email);
    if (!domain) return c.json({ sso: false });

    const [found] = await db
      .select({ providerId: schema.ssoProvider.providerId })
      .from(schema.ssoProvider)
      .where(eq(schema.ssoProvider.domain, domain))
      .limit(1);
    return c.json({ sso: Boolean(found) });
  });
}
