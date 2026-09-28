import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { googleRedirectUri, verifyGoogle } from "@sentrello/auth/providers";
import { db, eq, schema } from "@sentrello/db";
import { record } from "@sentrello/db/security-events";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";
import { secrets } from "@sentrello/module-sdk";

/**
 * Signing in with Google, set up on a screen.
 *
 * It used to be two environment variables and nothing else, which meant that
 * turning it on required shell access to the machine running the business —
 * and build rule 6 says a third-party integration is authorised, stored and
 * tested in its own settings, never by editing a file on a server. The
 * published page saying that anything configurable has a screen was wrong
 * about this one thing, and this is the screen.
 *
 * Three routes and nothing clever: what is connected, connect these details,
 * disconnect. The details are proved against Google before they are stored,
 * for the reason every other integration here is: credentials saved and
 * wrong fail later, on a sign-in page, in front of whoever the owner was
 * trying to let in.
 */
export function registerSocialSignIn(ctx: ModuleContext) {
  ctx.app.get(
    "/api/users/social-sign-in",
    requireSession(),
    requirePermission({ settings: ["read"] }),
    async (c: RouteContext) => {
      const [row] = await db
        .select()
        .from(schema.authProviders)
        .where(eq(schema.authProviders.provider, "google"))
        .limit(1);

      /*
       * An instance still on the environment variables reads as connected,
       * because it is — and says which way, so somebody looking for a client
       * id they cannot edit here knows why the box is empty.
       */
      const fromEnvironment = Boolean(
        process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
      );

      return c.json({
        google: {
          // The client id is public by design — it travels in the address bar
          // of every sign-in — so the screen may show it. The secret never
          // leaves this server.
          clientId: row?.clientId ?? null,
          connected: Boolean(row) || fromEnvironment,
          fromEnvironment: !row && fromEnvironment,
          enabled: row?.enabled ?? fromEnvironment,
          verifiedAt: row?.verifiedAt ?? null,
          updatedAt: row?.updatedAt ?? null,
        },
        // Google refuses anything it was not told about in advance, so the
        // screen has to be able to show somebody what to paste over there.
        redirectUri: googleRedirectUri(),
        // Whether this instance can store a secret at all.
        canStoreSecrets: secrets.secretsAvailable(),
      });
    },
  );

  ctx.app.put(
    "/api/users/social-sign-in/google",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c: RouteContext) => {
      const session = c.get("session");
      const orgId = activeOrganizationId(session);
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      const clientId = String(body.clientId ?? "")
        .trim()
        .slice(0, 255);
      const clientSecret = String(body.clientSecret ?? "").trim();
      if (!clientId || !clientSecret) {
        return c.json(
          { error: "both the client ID and the client secret" },
          400,
        );
      }
      if (!secrets.secretsAvailable()) {
        /*
         * Refused rather than stored in the clear. Without a key there is
         * nowhere safe to put a secret, and writing it plainly into the
         * database to keep a screen working is how a credential ends up in a
         * backup somebody emails.
         */
        return c.json(
          {
            error:
              "this instance has no secret key, so it cannot store a credential. Set SENTRELLO_SECRET_KEY and restart.",
          },
          409,
        );
      }

      const checked = await verifyGoogle(
        { clientId, clientSecret },
        googleRedirectUri(),
      );
      if (!checked.ok) return c.json({ error: checked.error }, 400);

      const stored = {
        clientId,
        clientSecret: secrets.seal(clientSecret),
        enabled: true,
        verifiedAt: new Date(),
        updatedBy: session.user.id,
        updatedAt: new Date(),
      };
      await db
        .insert(schema.authProviders)
        .values({ provider: "google", ...stored })
        .onConflictDoUpdate({
          target: schema.authProviders.provider,
          set: stored,
        });

      await record({
        organizationId: orgId,
        actor: session.user,
        action: "auth.google.connected",
        detail: { clientId },
      });

      /*
       * Said plainly, because it is the one surprising thing here. The
       * provider list is resolved when authentication is built, and rebuilding
       * it under a live process would mean tearing down sessions in flight to
       * save a restart.
       */
      return c.json({
        ok: true,
        verified: true,
        restartRequired: true,
      });
    },
  );

  ctx.app.delete(
    "/api/users/social-sign-in/google",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c: RouteContext) => {
      const session = c.get("session");
      const orgId = activeOrganizationId(session);

      await db
        .delete(schema.authProviders)
        .where(eq(schema.authProviders.provider, "google"));

      await record({
        organizationId: orgId,
        actor: session.user,
        action: "auth.google.disconnected",
        detail: {},
      });

      /*
       * People who signed up through Google keep their accounts. Taking the
       * button away is not the same as taking somebody's access away, and an
       * owner who wanted the second thing would be asking for it on a
       * different screen.
       */
      return c.json({ ok: true, restartRequired: true });
    },
  );
}
