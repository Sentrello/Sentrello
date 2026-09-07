import { auth } from "@sentrello/auth";
import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, schema } from "@sentrello/db";
import { lockState, policyFor } from "@sentrello/db/lockout";
import {
  ACTION_TEXT,
  type SecurityAction,
  recent,
  record,
} from "@sentrello/db/security-events";
import type { ModuleContext } from "@sentrello/module-sdk";
import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { temporaryPassword } from "./password";
import { applyRoles, twoFactorRequired as needsTwoFactor } from "./roles";

/**
 * What the Recent-changes card on `GET /api/users` leaves out.
 *
 * Every sign-in attempt and every prune run is a security event, and on an
 * instance whose login page faces the internet those are the overwhelming
 * majority of rows. The card exists to answer "who changed what, and when" —
 * the Events screen (`events.ts`) is where sign-in traffic and prune runs are
 * read, not this one.
 */
const NOISE_ACTIONS: SecurityAction[] = [
  "sign-in.succeeded",
  "sign-in.failed",
  "events.pruned",
];

/** The details of one person, as an administrator needs to see them. */
export interface Person {
  userId: string;
  memberId: string;
  name: string;
  email: string;
  /** Everything they hold, own role and group roles together. */
  role: string;
  /** The role given to them directly, apart from any group. */
  baseRole: string;
  /** The groups they are in, which is where the rest of their roles come from. */
  groups: string[];
  twoFactorEnabled: boolean;
  /** Whether the business's rules say they must have a second factor. */
  twoFactorRequired: boolean;
  /** The last time they actually used it, or null if they never have. */
  lastSeenAt: Date | null;
  /** Whether this is the person doing the looking. */
  you: boolean;
}

/** One person's detail, as the suspend/restore screen needs it. */
export interface PersonDetail extends Person {
  /** Set while this account is suspended, null otherwise. */
  disabledAt: string | null;
  emailVerified: boolean;
  joinedAt: string;
  /**
   * Whether failed attempts have locked this address out, and until when.
   *
   * Derived, not stored — `lockState` counts the recorded failures, so this
   * is the same answer the sign-in guard reaches on the next attempt rather
   * than a second copy of it that could disagree.
   *
   * Here because a lock nobody can see is a lock nobody can lift: the route
   * to clear one has existed since the lockout landed, and until this field
   * did, no screen knew there was anything to clear.
   */
  locked: boolean;
  lockedUntil: string | null;
  failedAttempts: number;
}

/** The person an action is about, for the record. */
async function subjectOf(userId: string) {
  const [user] = await db
    .select({
      id: schema.user.id,
      name: schema.user.name,
      email: schema.user.email,
    })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .limit(1);
  return user ?? { id: userId, name: null, email: null };
}

/**
 * Whether taking `target` away — suspending or removing them — would leave
 * this organization with no administrator able to sign in.
 *
 * One function, called by both the removal route and the suspend route
 * below, rather than a copy in each: a copy is how this drifted wrong the
 * first time. Two faults, both in the counting, not one:
 *
 * `member.role` is comma separated the moment somebody holds a role through
 * a group — `applyRoles` in `./roles.ts` writes it that way — so an
 * administrator who joins any group becomes `"admin,staff"`, and a plain
 * `m.role === "admin"` stops seeing them. Split on the comma and check
 * membership in the list instead.
 *
 * A suspended administrator cannot sign in, approve anything, or promote
 * anybody back — counting them toward the total is what let two separate
 * calls suspend both administrators of an organization in turn, since
 * neither call ever saw fewer than two. Only a member still able to sign in
 * — `disabledAt` null — counts.
 *
 * `target` is included in `members`, so the count is of every administrator
 * still standing *including* the one this action is about: if that count is
 * one, `target` is the only one, and the action is refused.
 */
function isLastAdministrator(
  members: { role: string; disabledAt: Date | null }[],
  target: { role: string },
): boolean {
  const holdsAdmin = (role: string) => role.split(",").includes("admin");
  if (!holdsAdmin(target.role)) return false;
  const livingAdmins = members.filter(
    (m) => holdsAdmin(m.role) && !m.disabledAt,
  );
  return livingAdmins.length <= 1;
}

/**
 * One person, in the shape both `GET /api/users/:userId` and the suspend
 * route return. Null when they are not a member of this organization at all —
 * the caller turns that into a 404 rather than a person made of nulls.
 */
async function personDetail(
  orgId: string,
  userId: string,
  viewerId: string,
): Promise<PersonDetail | null> {
  const [row] = await db
    .select({
      memberId: schema.member.id,
      role: schema.member.role,
      baseRole: schema.member.baseRole,
      disabledAt: schema.member.disabledAt,
      joinedAt: schema.member.createdAt,
      name: schema.user.name,
      email: schema.user.email,
      emailVerified: schema.user.emailVerified,
      twoFactorEnabled: schema.user.twoFactorEnabled,
    })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
    .where(
      and(
        eq(schema.member.organizationId, orgId),
        eq(schema.member.userId, userId),
      ),
    )
    .limit(1);
  if (!row) return null;

  const held = row.role.split(",").filter(Boolean);
  const [secret] = await db
    .select({ userId: schema.twoFactor.userId })
    .from(schema.twoFactor)
    .where(eq(schema.twoFactor.userId, userId))
    .limit(1);
  const [lastSession] = await db
    .select({ updatedAt: schema.session.updatedAt })
    .from(schema.session)
    .where(eq(schema.session.userId, userId))
    .orderBy(desc(schema.session.updatedAt))
    .limit(1);
  const groups = await db
    .select({ name: schema.userGroups.name })
    .from(schema.userGroupMembers)
    .innerJoin(
      schema.userGroups,
      eq(schema.userGroups.id, schema.userGroupMembers.groupId),
    )
    .where(
      and(
        eq(schema.userGroupMembers.organizationId, orgId),
        eq(schema.userGroupMembers.userId, userId),
      ),
    );
  const policy = await policyFor(orgId);
  const lock = await lockState(orgId, row.email ?? "");

  return {
    memberId: row.memberId,
    userId,
    name: row.name ?? "",
    email: row.email ?? "",
    role: row.role,
    baseRole: row.baseRole ?? held[0] ?? "member",
    groups: groups.map((g) => g.name),
    twoFactorEnabled: Boolean(row.twoFactorEnabled) || Boolean(secret),
    twoFactorRequired: needsTwoFactor(policy, held),
    lastSeenAt: lastSession?.updatedAt ?? null,
    you: userId === viewerId,
    disabledAt: row.disabledAt ? row.disabledAt.toISOString() : null,
    emailVerified: Boolean(row.emailVerified),
    joinedAt: row.joinedAt.toISOString(),
    locked: lock.locked,
    lockedUntil: lock.until ? lock.until.toISOString() : null,
    failedAttempts: lock.failures,
  };
}

export function registerPeople(ctx: ModuleContext) {
  ctx.app.get(
    "/api/users",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c) => {
      const session = c.get("session");
      const orgId = activeOrganizationId(session);

      /**
       * A page of people, not all of them.
       *
       * Most instances have twenty-five; some have five hundred, and this
       * screen loaded every one of them with their sessions and their groups
       * to draw a list nobody could read. Searched on the server for the
       * same reason — filtering in the browser means fetching everybody
       * first, which is the thing being avoided.
       */
      const q = (c.req.query("q") ?? "").trim().toLowerCase();
      const perPage = Math.min(
        200,
        Math.max(10, Number.parseInt(c.req.query("perPage") ?? "50", 10) || 50),
      );
      const page = Math.max(
        1,
        Number.parseInt(c.req.query("page") ?? "1", 10) || 1,
      );

      const matches = q
        ? or(
            ilike(schema.user.name, `%${q}%`),
            ilike(schema.user.email, `%${q}%`),
          )
        : undefined;

      const [counted] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(schema.member)
        .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
        .where(and(eq(schema.member.organizationId, orgId), matches));

      const members = await db
        .select({
          memberId: schema.member.id,
          userId: schema.member.userId,
          role: schema.member.role,
          baseRole: schema.member.baseRole,
          joinedAt: schema.member.createdAt,
        })
        .from(schema.member)
        .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
        .where(and(eq(schema.member.organizationId, orgId), matches))
        .orderBy(asc(schema.user.name))
        .limit(perPage)
        .offset((page - 1) * perPage);

      const userIds = members.map((m) => m.userId);
      const [users, twoFactor, sessions] = await Promise.all([
        userIds.length
          ? db
              .select({
                id: schema.user.id,
                name: schema.user.name,
                email: schema.user.email,
                twoFactorEnabled: schema.user.twoFactorEnabled,
              })
              .from(schema.user)
              .where(inArray(schema.user.id, userIds))
          : [],
        userIds.length
          ? db
              .select({ userId: schema.twoFactor.userId })
              .from(schema.twoFactor)
              .where(inArray(schema.twoFactor.userId, userIds))
          : [],
        userIds.length
          ? db
              .select({
                userId: schema.session.userId,
                updatedAt: schema.session.updatedAt,
              })
              .from(schema.session)
              .where(inArray(schema.session.userId, userIds))
              .orderBy(desc(schema.session.updatedAt))
          : [],
      ]);

      const byId = new Map(users.map((u) => [u.id, u]));
      const hasSecret = new Set(twoFactor.map((t) => t.userId));
      const lastSeen = new Map<string, Date>();
      for (const s of sessions) {
        if (!lastSeen.has(s.userId)) lastSeen.set(s.userId, s.updatedAt);
      }

      // Group membership for everybody at once: one query rather than one
      // per person, on a screen a business opens to see everybody.
      const groupRows = userIds.length
        ? await db
            .select({
              userId: schema.userGroupMembers.userId,
              name: schema.userGroups.name,
            })
            .from(schema.userGroupMembers)
            .innerJoin(
              schema.userGroups,
              eq(schema.userGroups.id, schema.userGroupMembers.groupId),
            )
            .where(eq(schema.userGroupMembers.organizationId, orgId))
        : [];
      const policy = await policyFor(orgId);

      const people: Person[] = members.map((m) => {
        const user = byId.get(m.userId);
        const held = m.role.split(",").filter(Boolean);
        return {
          memberId: m.memberId,
          userId: m.userId,
          name: user?.name ?? "",
          email: user?.email ?? "",
          role: m.role,
          baseRole: m.baseRole ?? held[0] ?? "member",
          groups: groupRows
            .filter((g) => g.userId === m.userId)
            .map((g) => g.name),
          // Both, because a half-finished setup leaves a secret with the
          // flag still off, and an administrator looking at this screen
          // wants to know there is something to revoke.
          twoFactorEnabled:
            Boolean(user?.twoFactorEnabled) || hasSecret.has(m.userId),
          twoFactorRequired: needsTwoFactor(policy, held),
          lastSeenAt: lastSeen.get(m.userId) ?? null,
          you: m.userId === session.user.id,
        };
      });

      const invitations = await db
        .select({
          id: schema.invitation.id,
          email: schema.invitation.email,
          role: schema.invitation.role,
          status: schema.invitation.status,
          expiresAt: schema.invitation.expiresAt,
        })
        .from(schema.invitation)
        .where(
          and(
            eq(schema.invitation.organizationId, orgId),
            eq(schema.invitation.status, "pending"),
          ),
        );

      return c.json({
        people,
        total: counted?.total ?? people.length,
        page,
        perPage,
        invitations,
        // Who did what, so "when did that happen and who did it" has an
        // answer that is not somebody's memory. Excludes sign-in noise —
        // see NOISE_ACTIONS below — so twenty-five bot attempts against the
        // login page do not evict every administrative action from this
        // card; the Events screen (`events.ts`) is where sign-in events are
        // read.
        history: (await recent(orgId, 25, { exclude: NOISE_ACTIONS })).map(
          (e) => ({
            at: e.at,
            actor: e.actorName,
            subject: e.subjectName,
            action: e.action,
            says: ACTION_TEXT[e.action as keyof typeof ACTION_TEXT] ?? e.action,
            detail: e.detail,
          }),
        ),
      });
    },
  );

  ctx.app.post(
    "/api/users/:userId/role",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c) => {
      const session = c.get("session");
      const orgId = activeOrganizationId(session);
      const userId = c.req.param("userId");
      const body = (await c.req.json().catch(() => ({}))) as {
        role?: unknown;
      };
      const role = String(body.role ?? "").trim();
      if (!role) return c.json({ error: "a role is required" }, 400);

      // An administrator who demotes themselves has locked the business out
      // of its own instance, and nobody else can put it right.
      if (userId === session.user.id) {
        return c.json(
          { error: "you cannot change your own role — ask another admin" },
          400,
        );
      }

      const [member] = await db
        .select({ id: schema.member.id })
        .from(schema.member)
        .where(
          and(
            eq(schema.member.userId, userId),
            eq(schema.member.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!member) return c.json({ error: "not found" }, 404);

      // Through Better Auth rather than by writing the row: it is the thing
      // that decides whether a role may be granted at all, and a direct
      // update would sidestep that quietly.
      const [before] = await db
        .select({ role: schema.member.role })
        .from(schema.member)
        .where(eq(schema.member.id, member.id))
        .limit(1);

      // Through Better Auth first, so it decides whether this role may be
      // granted at all — then recorded as the person's own role and the
      // effective set recomputed, because groups may grant more.
      await auth.api.updateMemberRole({
        body: { memberId: member.id, role, organizationId: orgId },
        headers: c.req.raw.headers,
      });
      await db
        .update(schema.member)
        .set({ baseRole: role })
        .where(eq(schema.member.id, member.id));
      const effective = await applyRoles(orgId, userId);

      await record({
        organizationId: orgId,
        actor: session.user,
        subject: await subjectOf(userId),
        action: "role.changed",
        detail: {
          from: before?.role ?? null,
          to: role,
          effective: effective.all,
        },
      });
      return c.json({ ok: true });
    },
  );

  /**
   * Withdrawing an invitation.
   *
   * An invitation is a live way into the business: whoever holds that email
   * can join, with whatever role it names. An administrator who invited the
   * wrong address, or a person who has since taken another job, needs it
   * gone — and until now the only thing the screen could do was list it.
   */
  ctx.app.delete(
    "/api/users/invitations/:id",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c) => {
      const session = c.get("session");
      const orgId = activeOrganizationId(session);

      const [invitation] = await db
        .select({
          id: schema.invitation.id,
          email: schema.invitation.email,
          role: schema.invitation.role,
        })
        .from(schema.invitation)
        .where(
          and(
            eq(schema.invitation.id, c.req.param("id")),
            eq(schema.invitation.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!invitation) return c.json({ error: "not found" }, 404);

      // Marked rather than deleted: Better Auth reads the status when
      // somebody follows the link, so a cancelled invitation must still be
      // there to say no with.
      await db
        .update(schema.invitation)
        .set({ status: "canceled" })
        .where(eq(schema.invitation.id, invitation.id));

      await record({
        organizationId: orgId,
        actor: session.user,
        subject: { id: null, name: invitation.email },
        action: "invitation.cancelled",
        detail: { role: invitation.role },
      });
      return c.json({ cancelled: true });
    },
  );

  /**
   * Taking somebody off the instance.
   *
   * Their membership goes and their sessions end. The user record itself
   * stays: invoices, notes and activities point at it, and a business that
   * loses who raised an invoice when somebody leaves has lost its own
   * history.
   */
  ctx.app.delete(
    "/api/users/:userId",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c) => {
      const session = c.get("session");
      const orgId = activeOrganizationId(session);
      const userId = c.req.param("userId");

      if (userId === session.user.id) {
        return c.json({ error: "you cannot remove yourself" }, 400);
      }

      const members = await db
        .select({
          id: schema.member.id,
          role: schema.member.role,
          disabledAt: schema.member.disabledAt,
        })
        .from(schema.member)
        .where(eq(schema.member.organizationId, orgId));

      const [mine] = await db
        .select({ id: schema.member.id, role: schema.member.role })
        .from(schema.member)
        .where(
          and(
            eq(schema.member.userId, userId),
            eq(schema.member.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!mine) return c.json({ error: "not found" }, 404);

      // The last administrator cannot be removed. An instance with none is
      // one nobody can invite anybody back into.
      if (isLastAdministrator(members, mine)) {
        return c.json(
          { error: "this is the last administrator; promote somebody first" },
          400,
        );
      }

      const subject = await subjectOf(userId);
      await db.delete(schema.member).where(eq(schema.member.id, mine.id));
      await db.delete(schema.session).where(eq(schema.session.userId, userId));

      await record({
        organizationId: orgId,
        actor: session.user,
        subject,
        action: "member.removed",
        detail: { role: mine.role },
      });
      return c.json({ removed: true });
    },
  );

  /**
   * Giving somebody their way back in.
   *
   * A temporary password shown once, rather than a link in an email, because
   * an instance with no mail configured is the normal case and its owner is
   * standing next to the person who is locked out. Every existing session
   * ends: if the password was reset because somebody else had it, leaving
   * their session alive defeats the point.
   */
  ctx.app.post(
    "/api/users/:userId/password",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c) => {
      const session = c.get("session");
      const orgId = activeOrganizationId(session);
      const userId = c.req.param("userId");

      const [member] = await db
        .select({ id: schema.member.id })
        .from(schema.member)
        .where(
          and(
            eq(schema.member.userId, userId),
            eq(schema.member.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!member) return c.json({ error: "not found" }, 404);

      const password = temporaryPassword();
      const context = await auth.$context;
      const hash = await context.password.hash(password);
      await context.internalAdapter.updatePassword(userId, hash);
      await db.delete(schema.session).where(eq(schema.session.userId, userId));

      const subject = await subjectOf(userId);
      await record({
        organizationId: orgId,
        actor: session.user,
        subject,
        action: "password.reset",
        // `lockState` (`packages/db/src/lockout.ts`) reads this to decide
        // whether "issue a new password" — the remedy an administrator
        // actually reaches for — also clears an account lock. Without it the
        // owner gets a fresh password and is still told "too many failed
        // attempts".
        detail: { email: (subject.email ?? "").toLowerCase() },
      });

      // Returned once and never stored. The administrator reads it out and
      // the person changes it; anything else means a password sitting in a
      // database column waiting to be found. The log records that it
      // happened, never what it was.
      return c.json({ password });
    },
  );

  /**
   * Taking two-factor off an account.
   *
   * The phone with the authenticator on it is in a river, and the backup
   * codes are in a drawer at home. Without this the only way back is a
   * terminal, so the practical outcome is that nobody turns two-factor on at
   * all — which is worse than an administrator being able to remove it.
   *
   * Sessions end with it, so this cannot be used to quietly take over an
   * account that is currently signed in somewhere.
   */
  ctx.app.post(
    "/api/users/:userId/two-factor/revoke",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c) => {
      const session = c.get("session");
      const orgId = activeOrganizationId(session);
      const userId = c.req.param("userId");

      const [member] = await db
        .select({ id: schema.member.id })
        .from(schema.member)
        .where(
          and(
            eq(schema.member.userId, userId),
            eq(schema.member.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!member) return c.json({ error: "not found" }, 404);

      await db
        .delete(schema.twoFactor)
        .where(eq(schema.twoFactor.userId, userId));
      await db
        .update(schema.user)
        .set({ twoFactorEnabled: false })
        .where(eq(schema.user.id, userId));
      await db.delete(schema.session).where(eq(schema.session.userId, userId));

      await record({
        organizationId: orgId,
        actor: session.user,
        subject: await subjectOf(userId),
        action: "two-factor.revoked",
      });
      return c.json({ revoked: true });
    },
  );

  /** Signing somebody out everywhere, without changing anything else. */
  ctx.app.post(
    "/api/users/:userId/sessions/revoke",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const userId = c.req.param("userId");
      const [member] = await db
        .select({ id: schema.member.id })
        .from(schema.member)
        .where(
          and(
            eq(schema.member.userId, userId),
            eq(schema.member.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!member) return c.json({ error: "not found" }, 404);

      const gone = await db
        .delete(schema.session)
        .where(eq(schema.session.userId, userId))
        .returning({ id: schema.session.id });

      await record({
        organizationId: orgId,
        actor: c.get("session").user,
        subject: await subjectOf(userId),
        action: "sessions.revoked",
        detail: { sessions: gone.length },
      });
      return c.json({ signedOut: gone.length });
    },
  );

  ctx.app.get(
    "/api/users/:userId",
    requireSession(),
    // `settings:update`, matching every other route in this file and its own
    // docstring — not `settings:read`, which `defaults.ts` grants to
    // executives, managers and accounting, and which would hand any of them
    // an administrator's email, roles, groups and 2FA state through this
    // route while `GET /api/users` beside it correctly refuses them.
    requirePermission({ settings: ["update"] }),
    async (c) => {
      const session = c.get("session");
      const orgId = activeOrganizationId(session);
      const userId = c.req.param("userId");

      const person = await personDetail(orgId, userId, session.user.id);
      if (!person) return c.json({ error: "not found" }, 404);
      return c.json({ person });
    },
  );

  /**
   * Suspending an account, rather than deleting it.
   *
   * A person who has left should stop being able to sign in without their
   * invoices losing their author. Deleting the member takes the history with
   * it; this does not — the member row and everything it wrote stay exactly
   * where they are, only `disabledAt` and their sessions change.
   *
   * Guarded exactly as removal is, calling the same `isLastAdministrator`
   * both routes share rather than a copy of the check: nobody may suspend
   * themselves, and the last administrator may not be suspended — an
   * instance with no administrator cannot be recovered through the browser,
   * only from a terminal on the host. Unlike removal, the last-administrator
   * check only applies while *disabling* an account: restoring one can only
   * ever add an administrator back, never take the last one away.
   */
  ctx.app.patch(
    "/api/users/:userId",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c) => {
      const session = c.get("session");
      const orgId = activeOrganizationId(session);
      const userId = c.req.param("userId");
      const body = (await c.req.json().catch(() => ({}))) as {
        disabled?: unknown;
      };
      if (typeof body.disabled !== "boolean") {
        return c.json({ error: "disabled must be true or false" }, 400);
      }
      const disabled = body.disabled;

      if (userId === session.user.id) {
        return c.json({ error: "you cannot suspend yourself" }, 400);
      }

      const members = await db
        .select({
          id: schema.member.id,
          role: schema.member.role,
          disabledAt: schema.member.disabledAt,
        })
        .from(schema.member)
        .where(eq(schema.member.organizationId, orgId));

      const [target] = await db
        .select({ id: schema.member.id, role: schema.member.role })
        .from(schema.member)
        .where(
          and(
            eq(schema.member.userId, userId),
            eq(schema.member.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!target) return c.json({ error: "not found" }, 404);

      // The last administrator cannot be suspended.
      if (disabled && isLastAdministrator(members, target)) {
        return c.json(
          {
            error: "this is the last administrator; promote somebody first",
          },
          400,
        );
      }

      const subject = await subjectOf(userId);
      await db
        .update(schema.member)
        .set({ disabledAt: disabled ? new Date() : null })
        .where(eq(schema.member.id, target.id));

      // Ends every session of theirs. An account that cannot sign in again
      // but stays signed in where it already was has not actually been
      // suspended.
      if (disabled) {
        await db
          .delete(schema.session)
          .where(eq(schema.session.userId, userId));
      }

      await record({
        organizationId: orgId,
        actor: session.user,
        subject,
        action: disabled ? "account.disabled" : "account.enabled",
        detail: { role: target.role },
      });

      const person = await personDetail(orgId, userId, session.user.id);
      return c.json({ person });
    },
  );
}
