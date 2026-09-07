import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, desc, eq, schema } from "@sentrello/db";
import { policyFor } from "@sentrello/db/lockout";
import { record } from "@sentrello/db/security-events";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";
import { effectiveRoles, twoFactorRequired } from "./roles";

/**
 * Which devices are signed in, and getting one of them out.
 *
 * The reference puts this in front of the administrator and in front of the person
 * themselves, and both are right. Somebody who has left a laptop on a train
 * wants to end that session without waiting for anybody; an administrator
 * whose foreman has just been dismissed wants every device of theirs out now.
 */

/**
 * What a browser told us about itself, in a few words.
 *
 * A user agent string is unreadable and misleading in equal measure, but "a
 * Mac, in Safari" is enough for somebody to recognise their own laptop — which
 * is the only question the screen is asking.
 */
export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return "an unknown device";
  const ua = userAgent.toLowerCase();

  const platform = ua.includes("iphone")
    ? "an iPhone"
    : ua.includes("ipad")
      ? "an iPad"
      : ua.includes("android")
        ? "an Android phone"
        : ua.includes("mac os") || ua.includes("macintosh")
          ? "a Mac"
          : ua.includes("windows")
            ? "a Windows PC"
            : ua.includes("linux")
              ? "a Linux machine"
              : "an unknown device";

  // Order matters: every browser claims to be several others, and Chrome is
  // in the string for Edge and most of the rest.
  const browser = ua.includes("edg/")
    ? "Edge"
    : ua.includes("firefox")
      ? "Firefox"
      : ua.includes("chrome") && !ua.includes("chromium")
        ? "Chrome"
        : ua.includes("safari")
          ? "Safari"
          : null;

  return browser ? `${platform}, in ${browser}` : platform;
}

interface SessionView {
  id: string;
  device: string;
  ipAddress: string | null;
  createdAt: Date;
  expiresAt: Date;
  updatedAt: Date;
  /** Whether this is the session making the request. */
  current: boolean;
}

async function sessionsOf(
  userId: string,
  currentToken: string | null,
): Promise<SessionView[]> {
  const rows = await db
    .select()
    .from(schema.session)
    .where(eq(schema.session.userId, userId))
    .orderBy(desc(schema.session.updatedAt));

  const now = Date.now();
  return rows
    .filter((row) => row.expiresAt.getTime() > now)
    .map((row) => ({
      id: row.id,
      device: describeDevice(row.userAgent),
      ipAddress: row.ipAddress,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      updatedAt: row.updatedAt,
      current: currentToken !== null && row.token === currentToken,
    }));
}

/** The session behind this request, so a screen can mark it "this device". */
async function currentToken(session: {
  session: { id: string };
}): Promise<string | null> {
  const [row] = await db
    .select({ token: schema.session.token })
    .from(schema.session)
    .where(eq(schema.session.id, session.session.id))
    .limit(1);
  return row?.token ?? null;
}

export function registerSessions(ctx: ModuleContext) {
  /**
   * My own devices.
   *
   * No permission beyond having a session: this is somebody's own account, and
   * needing an administrator to end a session on a lost phone is how a
   * business ends up with a phone signed in for a year.
   */
  ctx.app.get(
    "/api/users/me/sessions",
    requireSession(),
    async (c: RouteContext) => {
      const session = c.get("session");
      return c.json({
        sessions: await sessionsOf(
          session.user.id,
          await currentToken(session),
        ),
      });
    },
  );

  ctx.app.delete(
    "/api/users/me/sessions/:id",
    requireSession(),
    async (c: RouteContext) => {
      const session = c.get("session");
      const id = c.req.param("id") ?? "";

      // Only ever their own: the id comes from a list this person was shown,
      // but the check is against the row, not against the list.
      const [gone] = await db
        .delete(schema.session)
        .where(
          and(
            eq(schema.session.id, id),
            eq(schema.session.userId, session.user.id),
          ),
        )
        .returning();
      if (!gone) return c.json({ error: "not found" }, 404);
      return c.json({ ok: true });
    },
  );

  /**
   * Every live session across the organization, for an administrator.
   *
   * `settings:update`, not `settings:read` — not uniform with every read in
   * this module. `settings:read` gates remain at `groups.ts:45` and `:88`,
   * `authentication.ts:35` (`GET /api/users/policy`), `roles.ts:327`
   * (`GET /api/users/roles/:role`), `sso.ts:81`, and
   * `/api/users/:userId/sessions` below in this file. This one is `update`
   * because of what it answers: it aggregates every person's live sessions across the whole
   * organization in one read, the same class of administrative cross-person
   * read as the people list (`people.ts`) and the access route
   * (`access.ts`), both of which are also `settings:update`.
   *
   * A two-segment static path — `GET /api/users/sessions` — registered
   * ahead of `registerPeople` in `index.ts`, or `GET /api/users/:userId`
   * would capture "sessions" as a person id first.
   */
  ctx.app.get(
    "/api/users/sessions",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c: RouteContext) => {
      const session = c.get("session");
      const orgId = activeOrganizationId(session);
      const token = await currentToken(session);

      const rows = await db
        .select({
          id: schema.session.id,
          userId: schema.session.userId,
          token: schema.session.token,
          userAgent: schema.session.userAgent,
          ipAddress: schema.session.ipAddress,
          createdAt: schema.session.createdAt,
          expiresAt: schema.session.expiresAt,
          updatedAt: schema.session.updatedAt,
          name: schema.user.name,
          email: schema.user.email,
        })
        .from(schema.session)
        .innerJoin(
          schema.member,
          and(
            eq(schema.member.userId, schema.session.userId),
            eq(schema.member.organizationId, orgId),
          ),
        )
        .innerJoin(schema.user, eq(schema.user.id, schema.session.userId))
        .orderBy(desc(schema.session.updatedAt));

      const now = Date.now();
      const sessions = rows
        .filter((row) => row.expiresAt.getTime() > now)
        .map((row) => ({
          id: row.id,
          userId: row.userId,
          name: row.name,
          email: row.email,
          device: describeDevice(row.userAgent),
          ipAddress: row.ipAddress,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
          updatedAt: row.updatedAt,
          current: token !== null && row.token === token,
        }));

      return c.json({ sessions });
    },
  );

  /** Somebody else's devices, for an administrator. */
  ctx.app.get(
    "/api/users/:userId/sessions",
    requireSession(),
    requirePermission({ settings: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const userId = c.req.param("userId") ?? "";

      // Only people in this business. A user id is not a licence to read
      // sessions on an instance somebody else's account happens to share.
      const [member] = await db
        .select({ id: schema.member.id })
        .from(schema.member)
        .where(
          and(
            eq(schema.member.organizationId, orgId),
            eq(schema.member.userId, userId),
          ),
        )
        .limit(1);
      if (!member) return c.json({ error: "not found" }, 404);

      return c.json({ sessions: await sessionsOf(userId, null) });
    },
  );

  ctx.app.delete(
    "/api/users/:userId/sessions/:id",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c: RouteContext) => {
      const session = c.get("session");
      const orgId = activeOrganizationId(session);
      const userId = c.req.param("userId") ?? "";
      const id = c.req.param("id") ?? "";

      const [member] = await db
        .select({ id: schema.member.id })
        .from(schema.member)
        .where(
          and(
            eq(schema.member.organizationId, orgId),
            eq(schema.member.userId, userId),
          ),
        )
        .limit(1);
      if (!member) return c.json({ error: "not found" }, 404);

      const [gone] = await db
        .delete(schema.session)
        .where(
          and(eq(schema.session.id, id), eq(schema.session.userId, userId)),
        )
        .returning();
      if (!gone) return c.json({ error: "not found" }, 404);

      const [person] = await db
        .select({
          id: schema.user.id,
          name: schema.user.name,
          email: schema.user.email,
        })
        .from(schema.user)
        .where(eq(schema.user.id, userId))
        .limit(1);

      await record({
        organizationId: orgId,
        actor: session.user,
        subject: person ?? { id: userId },
        action: "session.revoked",
        detail: { device: describeDevice(null) },
      });
      return c.json({ ok: true });
    },
  );

  /**
   * What this person's own account still owes the business.
   *
   * The screen behind sign-in asks this: if the rules say somebody with their
   * roles must have a second factor and they have not set one up, they are
   * told plainly and sent to do it, rather than being refused at some later
   * moment with an error about permissions.
   */
  ctx.app.get(
    "/api/users/me/security",
    requireSession(),
    async (c: RouteContext) => {
      const session = c.get("session");
      const orgId = session.session.activeOrganizationId ?? null;
      if (!orgId) {
        return c.json({ twoFactorRequired: false, twoFactorEnabled: false });
      }

      const [me] = await db
        .select({ twoFactorEnabled: schema.user.twoFactorEnabled })
        .from(schema.user)
        .where(eq(schema.user.id, session.user.id))
        .limit(1);

      const roles = await effectiveRoles(orgId, session.user.id);
      const policy = await policyFor(orgId);

      return c.json({
        roles: roles.all,
        twoFactorEnabled: me?.twoFactorEnabled ?? false,
        twoFactorRequired: twoFactorRequired(policy, roles.all),
        minPasswordLength: policy.minPasswordLength,
      });
    },
  );
}
