import { auth } from "@sentrello/auth";
import { activeOrganizationId, requireSession } from "@sentrello/auth/hono";
import { db, schema } from "@sentrello/db";
import { mailConfigured } from "@sentrello/email";
import { defineModule, rateLimit } from "@sentrello/module-sdk";
import { and, desc, eq } from "drizzle-orm";
import { DEFAULTS, type Preferences, normalize } from "./preferences";

/**
 * Your own account.
 *
 * Everything here is about the person making the request and nobody else, so
 * there is no permission to check beyond having a session — a role that could
 * stop somebody changing their own password would be a role nobody should
 * have. What replaces the permission check is that every query is filtered by
 * the session's own user id, and nothing takes a user id from the request.
 *
 * No nav entry: this is reached from the profile menu in the header, which is
 * where somebody looks when it is their own account they are thinking about,
 * not from the list of the business's modules.
 */

const KEY = "profile";

async function readPreferences(
  organizationId: string,
  userId: string,
): Promise<Preferences> {
  const [row] = await db
    .select({ value: schema.userPreferences.value })
    .from(schema.userPreferences)
    .where(
      and(
        eq(schema.userPreferences.organizationId, organizationId),
        eq(schema.userPreferences.userId, userId),
        eq(schema.userPreferences.key, KEY),
      ),
    )
    .limit(1);
  return row ? normalize(row.value) : DEFAULTS;
}

export default defineModule({
  id: "profile",
  tier: "free",
  register(ctx) {
    ctx.app.get("/api/profile", requireSession(), async (c) => {
      const session = c.get("session");
      /**
       * Read directly rather than through `activeOrganizationId`, which throws
       * by design so a business query can never lose its org filter.
       *
       * This is not a business query. Somebody signed in who belongs to no
       * organization — a billing account on the instance that sells Sentrello
       * — still has sessions to see and no preferences to read, and answering
       * with a 500 made every one of their sign-ins look like a broken server.
       */
      const orgId = session.session.activeOrganizationId;

      const [preferences, sessions] = await Promise.all([
        orgId ? readPreferences(orgId, session.user.id) : DEFAULTS,
        // Read directly rather than through `auth.api.listSessions`, which
        // needs the request headers and returns tokens. A token is a bearer
        // credential; the screen only needs enough to recognise a device.
        db
          .select({
            id: schema.session.id,
            createdAt: schema.session.createdAt,
            updatedAt: schema.session.updatedAt,
            expiresAt: schema.session.expiresAt,
            ipAddress: schema.session.ipAddress,
            userAgent: schema.session.userAgent,
          })
          .from(schema.session)
          .where(eq(schema.session.userId, session.user.id))
          .orderBy(desc(schema.session.updatedAt)),
      ]);

      const now = Date.now();
      return c.json({
        user: {
          name: session.user.name ?? "",
          email: session.user.email ?? "",
        },
        preferences,
        sessions: sessions
          .filter((s) => s.expiresAt.getTime() > now)
          .map((s) => ({
            id: s.id,
            current: s.id === session.session.id,
            signedInAt: s.createdAt,
            lastSeenAt: s.updatedAt,
            ipAddress: s.ipAddress,
            userAgent: s.userAgent,
          })),
      });
    });

    ctx.app.patch("/api/profile", requireSession(), async (c) => {
      const session = c.get("session");
      const orgId = activeOrganizationId(session);
      const body = (await c.req.json().catch(() => ({}))) as {
        name?: unknown;
        preferences?: unknown;
      };

      if (typeof body.name === "string" && body.name.trim()) {
        await db
          .update(schema.user)
          .set({ name: body.name.trim().slice(0, 100) })
          .where(eq(schema.user.id, session.user.id));
      }

      const preferences = normalize(
        body.preferences ?? (await readPreferences(orgId, session.user.id)),
      );
      await db
        .insert(schema.userPreferences)
        .values({
          organizationId: orgId,
          userId: session.user.id,
          key: KEY,
          value: preferences,
        })
        .onConflictDoUpdate({
          target: [
            schema.userPreferences.organizationId,
            schema.userPreferences.userId,
            schema.userPreferences.key,
          ],
          set: { value: preferences, updatedAt: new Date() },
        });

      return c.json({ preferences });
    });

    /**
     * Signing another device out.
     *
     * By row id, not by token: the screen never receives a session token, so
     * one cannot leak out of this endpoint or into a log. The row is deleted
     * only when it belongs to the person asking — that filter is what stands
     * in for a permission check here.
     */
    ctx.app.delete("/api/profile/sessions/:id", requireSession(), async (c) => {
      const session = c.get("session");
      const id = c.req.param("id");
      if (id === session.session.id) {
        return c.json(
          { error: "That is the session you are using. Sign out instead." },
          400,
        );
      }
      const deleted = await db
        .delete(schema.session)
        .where(
          and(
            eq(schema.session.id, id),
            eq(schema.session.userId, session.user.id),
          ),
        )
        .returning({ id: schema.session.id });
      return c.json({ revoked: deleted.length });
    });

    ctx.app.post("/api/profile/password", requireSession(), async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as {
        currentPassword?: unknown;
        newPassword?: unknown;
      };
      if (
        typeof body.currentPassword !== "string" ||
        typeof body.newPassword !== "string"
      ) {
        return c.json({ error: "Both passwords are required." }, 400);
      }

      try {
        // Better Auth's own endpoint: it verifies the current password and
        // applies whatever password rules the instance is configured with,
        // neither of which should be reimplemented here.
        await auth.api.changePassword({
          body: {
            currentPassword: body.currentPassword,
            newPassword: body.newPassword,
            // Everything else stays signed in. Somebody changing their
            // password on a laptop should not be signed out of their phone
            // unless they choose to be, which the sessions list is for.
            revokeOtherSessions: false,
          },
          headers: c.req.raw.headers,
        });
      } catch (err) {
        return c.json(
          { error: (err as Error).message || "That did not work." },
          400,
        );
      }
      return c.json({ changed: true });
    });

    /**
     * Changing the address you sign in with.
     *
     * Better Auth's own `/change-email` does the real work — the collision
     * check that never leaks whether another account already holds the
     * address, and the two-step confirm-then-verify Better Auth is configured
     * for in `packages/auth/src/index.ts` (the old address hears first, and
     * nothing in the `user` row moves until the new one is confirmed too).
     * This route adds only what is ours to add: the same "no mail, say so"
     * refusal every other route that starts an email uses, and a rate limit,
     * because unlike an invitation this is aimed by whoever holds the
     * session rather than by an administrator.
     */
    ctx.app.post("/api/profile/email", requireSession(), async (c) => {
      const session = c.get("session");
      const body = (await c.req.json().catch(() => ({}))) as {
        newEmail?: unknown;
      };
      const newEmail = String(body.newEmail ?? "")
        .trim()
        .toLowerCase();
      if (!newEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
        return c.json({ error: "a valid email address is required" }, 400);
      }
      if (newEmail === (session.user.email ?? "").toLowerCase()) {
        return c.json({ error: "that is already your sign-in email" }, 400);
      }

      // Same refusal shape as inviting a colleague or sending an invoice: a
      // change that claims to be under way when no mail can carry it is
      // worse than saying plainly there is no mail.
      if (!mailConfigured()) {
        return c.json(
          {
            error:
              "no mail server is connected — connect one under Settings → Connections",
          },
          400,
        );
      }

      const limit = rateLimit(
        `change-email:${session.user.id}`,
        8,
        15 * 60_000,
      );
      if (!limit.allowed) {
        return c.json({ error: "too_many_attempts" }, 429, {
          "retry-after": String(limit.retryAfterSeconds),
        });
      }

      const base = process.env.SENTRELLO_BASE_URL ?? new URL(c.req.url).origin;
      try {
        await auth.api.changeEmail({
          body: { newEmail, callbackURL: `${base}/profile` },
          headers: c.req.raw.headers,
        });
      } catch (err) {
        return c.json(
          { error: (err as Error).message || "That did not work." },
          400,
        );
      }

      // The same answer whether or not `newEmail` already belongs to someone
      // — Better Auth masks that itself, above. Saying anything else here
      // would undo it. Which inbox to check first is not that kind of leak:
      // it is read off this account's own `emailVerified` flag, which the
      // person asking already knows about themselves. Not on `SentrelloSession`
      // — the SDK's session type is deliberately narrow — so read off the
      // real Better Auth user the same way the profile screen already does
      // for `twoFactorEnabled`.
      const verified = Boolean(
        (session.user as { emailVerified?: boolean }).emailVerified,
      );
      const message = verified
        ? "Check your current inbox for a confirmation link. Once you confirm there, we'll send a verification link to the new address — this account keeps signing in with the address you have now until both are done."
        : `Check ${newEmail} for a verification link. This account keeps signing in with the address you have now until you follow it.`;
      return c.json({ requested: true, message });
    });
  },
});
