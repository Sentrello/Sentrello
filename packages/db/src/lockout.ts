import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "./client";
import { at } from "./orm";
import * as schema from "./schema";

/** The policy for an organization, with the platform's defaults filled in. */
export async function policyFor(
  orgId: string,
): Promise<typeof schema.securityPolicy.$inferSelect> {
  const [existing] = await db
    .select()
    .from(schema.securityPolicy)
    .where(eq(schema.securityPolicy.organizationId, orgId))
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(schema.securityPolicy)
    .values({ organizationId: orgId })
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  const [raced] = await db
    .select()
    .from(schema.securityPolicy)
    .where(eq(schema.securityPolicy.organizationId, orgId))
    .limit(1);
  if (!raced) throw new Error("could not resolve the security policy");
  return raced;
}

/**
 * Whether an address is locked, worked out from the log.
 *
 * Deliberately not a counter in a table. Two pieces of state describing the
 * same fact eventually disagree, and this one would disagree at the moment
 * somebody phones to say they cannot get in. Counting the events means the
 * lock and the reason for it are the same record: nobody is ever locked out
 * without a visible cause, which is exactly what an administrator needs on
 * that call.
 *
 * The window starts at whichever came last — the most recent unlock, the most
 * recent success, the most recent password reset, or the start of the lockout
 * period. Anything before that is a question already answered.
 *
 * **The clock this runs on.** `windowStart` and `until` are computed from
 * this Node process's `Date.now()`, then compared in JS (`cleared.at >
 * windowStart`) or handed to Postgres through {@link at}, which casts as a
 * bare `timestamp` — no zone, parsed by both `pg` and Drizzle as UTC
 * regardless of the host's `TZ`. That makes the only real exposure genuine
 * clock disagreement between the app host and the database host: seconds of
 * drift are immaterial against a fifteen-minute window, but a Postgres
 * session `TimeZone` that is not UTC would be hours, and would silently
 * widen or shut off the lock rather than error. Accepted rather than pushed
 * into SQL (`localtimestamp - make_interval(...)`) because every deployment
 * this ships to pins the database's `TimeZone` to UTC already, and moving
 * the arithmetic there would trade one assumption (app and database clocks
 * agree) for another (the operator never changed a config default) rather
 * than removing the assumption.
 *
 * **The denial-of-service this deliberately allows.** Five failures per
 * fifteen minutes — the shipped default — is one request every three
 * minutes, three orders of magnitude under the production rate limiter (see
 * `recordTwoFactorVerify` in `sign-in-events.ts`). Anyone who knows an
 * address can keep it locked indefinitely from a single IP by sending one
 * wrong password every few minutes, and on a self-hosted instance that
 * address is usually the owner's — the one person with nobody else to ask
 * for an unlock. That is not an oversight; it is why the lock expires on its
 * own after `lockoutMinutes` rather than requiring an administrator to clear
 * it, and why `lockoutAfterAttempts` can be set to zero to turn the feature
 * off entirely on an instance where this tradeoff is not worth it. Auto-expiry
 * is the answer chosen here precisely because the locked person is often the
 * only administrator there is. Task 8 answers it two more ways this function
 * only reads the result of: `POST /api/users/:userId/unlock`
 * (`packages/modules-free/users/src/authentication.ts`) records an explicit
 * `account.unlocked` event from inside a session, and `sentrello unlock`
 * (`packages/auth/src/unlock.ts`) records the same event from the host,
 * without one — the route back in for the case this paragraph describes,
 * where the locked person cannot sign in to reach the route above it either.
 * `password.reset` clearing the window too (see the SQL below) is what makes
 * "issue a new password" — the remedy an administrator already reaches for —
 * actually work, rather than handing over a fresh password and leaving the
 * account still locked.
 */
export async function lockState(
  organizationId: string,
  email: string,
): Promise<{ locked: boolean; until: Date | null; failures: number }> {
  const address = email.trim().toLowerCase();
  // Not optional: policyFor always returns a row, inserting the platform's
  // defaults itself when none exists yet, or throws if even that races and
  // fails — it never resolves to undefined, so there is no default to fall
  // back to here.
  const policy = await policyFor(organizationId);
  const limit = policy.lockoutAfterAttempts;
  const minutes = policy.lockoutMinutes;
  // Zero is off: an instance on a private network may decide the support call
  // costs more than the risk.
  if (limit <= 0) return { locked: false, until: null, failures: 0 };

  const windowStart = new Date(Date.now() - minutes * 60_000);

  // Anything that settles the question resets the count. Bounded by the same
  // windowStart the failure count below is bounded by — nothing outside the
  // window can change the answer, and without this bound an address that
  // never once succeeds walks its entire history of successes on every
  // attempt, which on the default 365-day retention is the shape the attack
  // in the docstring above actually takes.
  const [cleared] = await db
    .select({ at: schema.securityEvents.at })
    .from(schema.securityEvents)
    .where(
      and(
        eq(schema.securityEvents.organizationId, organizationId),
        sql`${schema.securityEvents.action} in ('account.unlocked', 'sign-in.succeeded', 'password.reset')`,
        sql`${schema.securityEvents.detail} ->> 'email' = ${address}`,
        sql`${schema.securityEvents.at} > ${at(windowStart)}`,
      ),
    )
    .orderBy(desc(schema.securityEvents.at))
    .limit(1);

  const since = cleared?.at ?? windowStart;

  const failureFilters = and(
    eq(schema.securityEvents.organizationId, organizationId),
    eq(schema.securityEvents.action, "sign-in.failed"),
    sql`${schema.securityEvents.detail} ->> 'email' = ${address}`,
    sql`${schema.securityEvents.at} > ${at(since)}`,
  );

  const [row] = await db
    .select({ failures: sql<number>`count(*)::int` })
    .from(schema.securityEvents)
    .where(failureFilters);

  const failures = row?.failures ?? 0;
  if (failures < limit) return { locked: false, until: null, failures };

  // The lock is a sliding window, not a flat timer from the moment it is
  // read: it lifts the instant the limit-th most recent failure ages out of
  // `lockoutMinutes`, not `lockoutMinutes` from whenever somebody happens to
  // check. That failure is the one at position `limit - 1` when the failures
  // are ordered newest first — five failures aged ten minutes expire in
  // about five more, not fifteen, and a flat `Date.now() + minutes` here
  // would report fifteen and keep reporting fifteen on every subsequent
  // read, a countdown that resets each time the locked-out person looks at
  // it.
  const [boundary] = await db
    .select({ at: schema.securityEvents.at })
    .from(schema.securityEvents)
    .where(failureFilters)
    .orderBy(desc(schema.securityEvents.at))
    .offset(limit - 1)
    .limit(1);

  return {
    locked: true,
    until: new Date((boundary?.at ?? new Date()).getTime() + minutes * 60_000),
    failures,
  };
}
