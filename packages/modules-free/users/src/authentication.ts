import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, schema } from "@sentrello/db";
import { policyFor } from "@sentrello/db/lockout";
import { record } from "@sentrello/db/security-events";
import { mailConfigured } from "@sentrello/email";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";
import { knownRoles } from "./roles";

/**
 * The rules for signing in, and the way back in when they lock somebody out.
 *
 * `GET`/`PUT /api/users/policy` moved here from `groups.ts`, unchanged apart
 * from three fields nothing previously wrote: `lockoutAfterAttempts`,
 * `lockoutMinutes` and `eventRetentionDays`. Writing them makes an
 * interaction reachable that was deliberately left unreachable while nothing
 * wrote these fields: a retention window that reaches inside the lockout
 * window makes `lockState` (`packages/db/src/lockout.ts`) unreliable in both
 * directions — pruning the failures that decide a lock silently unlocks it,
 * and pruning the events that clear a lock silently extends it. The write is
 * validated and refused with a reason, not clamped.
 *
 * `POST /api/users/:userId/unlock` is new outright. Task 8's addendum found
 * that today nothing in the repository can clear an account lock except
 * waiting: this is one of the two routes back in, for an administrator who
 * still has a session; `packages/auth/src/unlock.ts` is the other, for when
 * signing in at all is what the lock is withholding.
 */
/**
 * A refusal a person can read, and a field a caller can act on.
 *
 * The messages named the API's own field — "lockoutAfterAttempts must be
 * between 0 (off) and 1000" — and the screen prints them under an input
 * labelled "Lock after", so the one word connecting the two was the one the
 * reader did not have. Naming the label instead would fix the screen and
 * leave an API caller guessing which of six fields it meant.
 *
 * Both, then: prose for the person and `field` for the caller. The labels are
 * the ones on `apps/web/src/routes/users/authentication.tsx`, and this is the
 * only place that has to know they match.
 */
const LABELS: Record<string, string> = {
  requireTwoFactorFor: "Require two-factor for",
  requireEmailVerified: "Require a confirmed email address",
  minPasswordLength: "Shortest password",
  sessionDays: "Stay signed in for",
  lockoutAfterAttempts: "Lock after",
  lockoutMinutes: "Locked for",
  eventRetentionDays: "Keep history for",
};

function refuse(c: RouteContext, field: string, says: string) {
  return c.json({ error: `${LABELS[field] ?? field} ${says}`, field }, 400);
}

export function registerAuthentication(ctx: ModuleContext) {
  ctx.app.get(
    "/api/users/policy",
    requireSession(),
    requirePermission({ settings: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      return c.json({ policy: await policyFor(orgId) });
    },
  );

  ctx.app.put(
    "/api/users/policy",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c: RouteContext) => {
      const session = c.get("session");
      const orgId = activeOrganizationId(session);
      const current = await policyFor(orgId);
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      const allowed = await knownRoles(orgId);
      /**
       * Refused unless mail is configured, which is the whole safety of this
       * setting. A business that cannot send a verification link and requires
       * one has locked itself out of its own software, and the only way back
       * would be the host — which is a worse answer than not letting them
       * switch it on.
       *
       * Turning it *off* is always allowed, including with no mail, because
       * that is the way out if it was ever on.
       */
      if (body.requireEmailVerified === true && !mailConfigured()) {
        return refuse(
          c,
          "requireEmailVerified",
          "cannot be switched on until email is configured — otherwise nobody could confirm an address, including you",
        );
      }
      const requireEmailVerified =
        typeof body.requireEmailVerified === "boolean"
          ? body.requireEmailVerified
          : current.requireEmailVerified;

      const requireTwoFactorFor = Array.isArray(body.requireTwoFactorFor)
        ? [...new Set(body.requireTwoFactorFor.map(String))].filter((r) =>
            allowed.includes(r),
          )
        : current.requireTwoFactorFor;

      const minPasswordLength = Number.isInteger(body.minPasswordLength)
        ? Math.min(Math.max(body.minPasswordLength as number, 8), 72)
        : current.minPasswordLength;

      const sessionDays =
        body.sessionDays === null
          ? null
          : Number.isInteger(body.sessionDays)
            ? Math.min(Math.max(body.sessionDays as number, 1), 365)
            : current.sessionDays;

      /**
       * Bounded at both ends, like `minPasswordLength` and `sessionDays`
       * above.
       *
       * All three of these columns are `integer` — pg `int4` — so a value
       * past 2^31-1 is not a large setting, it is a database error: the
       * update throws out of range and the route answers 500 to a request it
       * should have refused with a reason. The upper bounds below are chosen
       * to be far past any real instance and far short of that: a thousand
       * attempts, a year of lockout, and a century of retention.
       *
       * Zero attempts is documented as off. A negative number was never a
       * choice to mean that — clamping it to 0 would hide the difference
       * between "turned off on purpose" and "typo" — so every one of these
       * is refused outright rather than clamped, matching the
       * retention-vs-lockout check below.
       */
      const whole = (v: unknown): v is number => Number.isInteger(v);
      if (body.lockoutAfterAttempts !== undefined) {
        if (!whole(body.lockoutAfterAttempts)) {
          return refuse(c, "lockoutAfterAttempts", "must be a whole number");
        }
        if (body.lockoutAfterAttempts < 0 || body.lockoutAfterAttempts > 1000) {
          return refuse(
            c,
            "lockoutAfterAttempts",
            "must be between 0 (off) and 1000",
          );
        }
      }
      const lockoutAfterAttempts =
        (body.lockoutAfterAttempts as number | undefined) ??
        current.lockoutAfterAttempts;

      // A zero or negative window would count every failure ever made
      // against an address as still inside it — not a smaller number, a
      // meaningless one.
      if (body.lockoutMinutes !== undefined) {
        if (!whole(body.lockoutMinutes)) {
          return refuse(c, "lockoutMinutes", "must be a whole number");
        }
        if (body.lockoutMinutes < 1 || body.lockoutMinutes > 525_600) {
          return refuse(
            c,
            "lockoutMinutes",
            "must be between 1 and 525600 (a year)",
          );
        }
      }
      const lockoutMinutes =
        (body.lockoutMinutes as number | undefined) ?? current.lockoutMinutes;

      if (body.eventRetentionDays !== undefined) {
        if (!whole(body.eventRetentionDays)) {
          return refuse(c, "eventRetentionDays", "must be a whole number");
        }
        if (body.eventRetentionDays < 0 || body.eventRetentionDays > 36_500) {
          return refuse(
            c,
            "eventRetentionDays",
            "must be between 0 (keep forever) and 36500",
          );
        }
      }
      const eventRetentionDays =
        (body.eventRetentionDays as number | undefined) ??
        current.eventRetentionDays;

      // The interaction this task's addendum names: zero retention means
      // "keep forever", which by definition cannot be shorter than any
      // window, so only a positive retention is checked against the lockout
      // window it has to outlast.
      if (
        eventRetentionDays > 0 &&
        eventRetentionDays * 24 * 60 < lockoutMinutes
      ) {
        return c.json(
          {
            // Names both settings, because the refusal is about the pair
            // and either one is the fix. `field` points at retention, which
            // is the one the caller just sent.
            error: `Keep history for (${eventRetentionDays} days) must be at least as long as Locked for (${lockoutMinutes} minutes)`,
            field: "eventRetentionDays",
          },
          400,
        );
      }

      const [updated] = await db
        .update(schema.securityPolicy)
        .set({
          requireEmailVerified,
          requireTwoFactorFor,
          minPasswordLength,
          sessionDays,
          lockoutAfterAttempts,
          lockoutMinutes,
          eventRetentionDays,
          updatedAt: new Date(),
        })
        .where(eq(schema.securityPolicy.organizationId, orgId))
        .returning();

      await record({
        organizationId: orgId,
        actor: session.user,
        subject: { id: orgId, name: "this business", email: null },
        action: "policy.changed",
        detail: {
          requireTwoFactorFor,
          minPasswordLength,
          sessionDays,
          lockoutAfterAttempts,
          lockoutMinutes,
          eventRetentionDays,
        },
      });
      return c.json({ policy: updated });
    },
  );

  /**
   * Clearing an account lock, from inside a session.
   *
   * Writes the `account.unlocked` event `lockState`
   * (`packages/db/src/lockout.ts`) reads to clear the window — the clearing
   * branch that event names had no producer until this route existed.
   * `settings:update`, the same permission that hands somebody a new
   * password: both routes can put a locked-out account back in reach.
   */
  ctx.app.post(
    "/api/users/:userId/unlock",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c: RouteContext) => {
      const session = c.get("session");
      const orgId = activeOrganizationId(session);
      const userId = c.req.param("userId") ?? "";

      const [row] = await db
        .select({ email: schema.user.email, name: schema.user.name })
        .from(schema.member)
        .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
        .where(
          and(
            eq(schema.member.organizationId, orgId),
            eq(schema.member.userId, userId),
          ),
        )
        .limit(1);
      if (!row) return c.json({ error: "not found" }, 404);

      const email = (row.email ?? "").toLowerCase();
      await record({
        organizationId: orgId,
        actor: session.user,
        subject: { id: userId, name: row.name, email: row.email },
        action: "account.unlocked",
        // The address, exactly as `lockState` reads it — case-folded, since
        // that is how it stores and compares every other event's `email`.
        detail: { email },
      });

      return c.json({ unlocked: true });
    },
  );
}
