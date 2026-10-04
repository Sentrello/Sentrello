import { auth } from "@sentrello/auth";
import { activeOrganizationId, requireSession } from "@sentrello/auth/hono";
import { db, schema } from "@sentrello/db";
import { NO_MAIL_SERVER, mailConfigured } from "@sentrello/email";
import { defineModule, rateLimit } from "@sentrello/module-sdk";
import { and, desc, eq } from "drizzle-orm";
import { type Columns, normalizeColumns } from "./columns";
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
/**
 * The column choices, under their own key rather than inside `profile`.
 *
 * Two reasons. They are written by a different screen at a different moment —
 * a column menu on a list, not a preferences form — so a save of one must not
 * carry a stale copy of the other. And this one grows with the product while
 * `profile` is a fixed handful of fields; keeping them apart means a list's
 * entry can never be dropped by a preferences screen that has not heard of it.
 */
const COLUMNS_KEY = "list-columns";

async function readColumns(
  organizationId: string,
  userId: string,
): Promise<Columns> {
  const [row] = await db
    .select({ value: schema.userPreferences.value })
    .from(schema.userPreferences)
    .where(
      and(
        eq(schema.userPreferences.organizationId, organizationId),
        eq(schema.userPreferences.userId, userId),
        eq(schema.userPreferences.key, COLUMNS_KEY),
      ),
    )
    .limit(1);
  return row ? normalizeColumns(row.value) : {};
}

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
    /**
     * The columns this person hides, on every list at once.
     *
     * One request, answered on the first screen and cached for the rest of the
     * visit: a reader who opens four lists in a minute asks once. An
     * organization is needed to answer at all — the choices belong to this
     * person *on this business* — and somebody with no active organization gets
     * an empty answer rather than an error, because a billing account with no
     * business still draws a screen.
     */
    ctx.app.get("/api/profile/columns", requireSession(), async (c) => {
      const session = c.get("session");
      const orgId = session.session.activeOrganizationId;
      return c.json({
        columns: orgId ? await readColumns(orgId, session.user.id) : {},
      });
    });

    /**
     * One list's choice, saved as it is made.
     *
     * Per list rather than the whole map, because two lists open in two tabs
     * would otherwise overwrite each other with whichever map was fetched
     * first. The row is read, the one entry replaced and the rest kept — the
     * same merge the dashboard's arrangement needs for the same reason.
     *
     * No permission beyond a session. Which columns somebody looks at is not a
     * thing a role should be able to decide for them.
     */
    ctx.app.put("/api/profile/columns/:list", requireSession(), async (c) => {
      const session = c.get("session");
      const orgId = session.session.activeOrganizationId;
      if (!orgId) return c.json({ error: "no organization" }, 400);

      const list = String(c.req.param("list") ?? "");
      const body = (await c.req.json().catch(() => ({}))) as {
        hidden?: unknown;
      };
      const asked = normalizeColumns({ [list]: body.hidden });
      // A list name this module would not store is a name the screen made up.
      if (!(list in asked) && !Array.isArray(body.hidden)) {
        return c.json({ error: "which list?" }, 400);
      }

      const columns = await readColumns(orgId, session.user.id);
      const next = normalizeColumns({ ...columns, ...asked });
      // Nothing hidden is no entry, so "show them all" removes the list rather
      // than storing an empty array for ever.
      if (!(list in asked)) delete next[list];

      await db
        .insert(schema.userPreferences)
        .values({
          organizationId: orgId,
          userId: session.user.id,
          key: COLUMNS_KEY,
          value: next,
        })
        .onConflictDoUpdate({
          target: [
            schema.userPreferences.organizationId,
            schema.userPreferences.userId,
            schema.userPreferences.key,
          ],
          set: { value: next, updatedAt: new Date() },
        });
      return c.json({ columns: next });
    });

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
            error: NO_MAIL_SERVER,
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
