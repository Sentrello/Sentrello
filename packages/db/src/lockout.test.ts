import { afterAll, beforeAll, expect, test } from "bun:test";
import { db, eq, inArray, schema, sql } from "@sentrello/db";
import { lockState } from "./lockout";

const suffix = crypto.randomUUID().slice(0, 8);
const email = `locked-${suffix}@example.test`;
let orgId: string;
let otherOrgId: string;

beforeAll(async () => {
  const [org] = await db
    .insert(schema.organizations)
    .values({
      id: crypto.randomUUID(),
      name: `Lockout ${suffix}`,
      slug: `lockout-${suffix}`,
      createdAt: new Date(),
    })
    .returning();
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await db.insert(schema.securityPolicy).values({ organizationId: orgId });

  const [other] = await db
    .insert(schema.organizations)
    .values({
      id: crypto.randomUUID(),
      name: `Lockout other ${suffix}`,
      slug: `lockout-other-${suffix}`,
      createdAt: new Date(),
    })
    .returning();
  if (!other) throw new Error("could not create the other organization");
  otherOrgId = other.id;
  await db.insert(schema.securityPolicy).values({ organizationId: otherOrgId });
});

afterAll(async () => {
  await db.execute(
    sql`delete from security_events where organization_id = ${orgId}`,
  );
  await db.execute(
    sql`delete from security_policy where organization_id = ${orgId}`,
  );
  await db.execute(
    sql`delete from security_events where organization_id = ${otherOrgId}`,
  );
  await db.execute(
    sql`delete from security_policy where organization_id = ${otherOrgId}`,
  );
  await db
    .delete(schema.organizations)
    .where(inArray(schema.organizations.id, [orgId, otherOrgId]));
});

/**
 * A failure, written `minutesAgo` in the past.
 *
 * `minutesAgo === 0` leaves `at` unset so Postgres's own `defaultNow()`
 * stamps it — the same source every real `sign-in.failed`, `sign-in.succeeded`
 * and `account.unlocked` row gets from `record()` in `security-events.ts`.
 * Passing an explicit client-clock `Date` for a "just now" row and comparing
 * it against another row's server-clock default, as an earlier version of
 * this helper did, raced whatever skew exists between this machine's clock
 * and the database's: reproducibly, roughly one run in four, "a success
 * clears it" saw the clearing event land with an earlier `at` than a failure
 * it was supposed to be after, so lock() kept counting failures the success
 * should have zeroed. An explicit past `Date` for `minutesAgo > 0` has no
 * such race — sixty minutes of margin swallows any clock skew a real
 * deployment would ever see.
 */
async function failure(minutesAgo = 0) {
  await db.insert(schema.securityEvents).values({
    organizationId: orgId,
    actorId: null,
    actorName: null,
    action: "sign-in.failed",
    detail: { email },
    ...(minutesAgo > 0
      ? { at: new Date(Date.now() - minutesAgo * 60_000) }
      : {}),
  });
}

async function clear() {
  await db.execute(
    sql`delete from security_events where organization_id = ${orgId}`,
  );
}

test("four failures do not lock, the fifth does", async () => {
  await clear();
  for (let i = 0; i < 4; i += 1) await failure();
  expect((await lockState(orgId, email)).locked).toBe(false);
  await failure();
  const locked = await lockState(orgId, email);
  expect(locked.locked).toBe(true);
  expect(locked.until).not.toBeNull();
});

test("a failure older than the window does not count", async () => {
  await clear();
  await failure(60);
  for (let i = 0; i < 4; i += 1) await failure();
  expect((await lockState(orgId, email)).locked).toBe(false);
});

test("an unlock clears it, however many failures came before", async () => {
  await clear();
  for (let i = 0; i < 6; i += 1) await failure();
  expect((await lockState(orgId, email)).locked).toBe(true);
  await db.insert(schema.securityEvents).values({
    organizationId: orgId,
    actorId: "admin",
    actorName: "An administrator",
    action: "account.unlocked",
    detail: { email },
  });
  expect((await lockState(orgId, email)).locked).toBe(false);
});

test("a password reset clears it too, the same as an unlock", async () => {
  // Task 8's addendum: "issue a new password" is the remedy an administrator
  // actually reaches for, and it has to clear the lock exactly as an
  // explicit unlock does — an owner handed a fresh password and still told
  // "too many failed attempts" is the single most confusing thing this
  // feature can do.
  await clear();
  for (let i = 0; i < 6; i += 1) await failure();
  expect((await lockState(orgId, email)).locked).toBe(true);
  await db.insert(schema.securityEvents).values({
    organizationId: orgId,
    actorId: "admin",
    actorName: "An administrator",
    action: "password.reset",
    detail: { email },
  });
  expect((await lockState(orgId, email)).locked).toBe(false);
});

test("a success clears it", async () => {
  await clear();
  for (let i = 0; i < 6; i += 1) await failure();
  await db.insert(schema.securityEvents).values({
    organizationId: orgId,
    actorId: "someone",
    actorName: "Someone",
    action: "sign-in.succeeded",
    detail: { email },
  });
  expect((await lockState(orgId, email)).locked).toBe(false);
});

test("zero attempts turns it off entirely", async () => {
  await clear();
  await db
    .update(schema.securityPolicy)
    .set({ lockoutAfterAttempts: 0 })
    .where(eq(schema.securityPolicy.organizationId, orgId));
  for (let i = 0; i < 20; i += 1) await failure();
  expect((await lockState(orgId, email)).locked).toBe(false);
  await db
    .update(schema.securityPolicy)
    .set({ lockoutAfterAttempts: 5 })
    .where(eq(schema.securityPolicy.organizationId, orgId));
});

test("one address locking does not lock another", async () => {
  await clear();
  for (let i = 0; i < 6; i += 1) await failure();
  expect((await lockState(orgId, email)).locked).toBe(true);
  expect((await lockState(orgId, `other-${suffix}@example.test`)).locked).toBe(
    false,
  );
});

/**
 * The same address, failing in one business, is not locked out of another.
 *
 * The branch's finishing review neutered every `organizationId` filter in
 * turn and found this one held by nothing: a lock is counted from events, and
 * a count that forgot its organization would lock somebody out of a business
 * they had never tried to sign in to. One person can hold accounts in two
 * instances of the same product with the same address, which is exactly who
 * this protects.
 */
test("failures in one organization do not lock the same address in another", async () => {
  // Its own address rather than this file's shared one, so what is asserted
  // is the organization filter and not the leftovers of the tests above.
  const shared = `shared-${suffix}@example.test`;
  for (let i = 0; i < 5; i += 1) {
    await db.insert(schema.securityEvents).values({
      organizationId: otherOrgId,
      action: "sign-in.failed",
      detail: { email: shared },
    });
  }

  // Locked where it happened...
  expect((await lockState(otherOrgId, shared)).locked).toBe(true);
  // ...and untouched where it did not, counted from zero rather than five.
  const here = await lockState(orgId, shared);
  expect(here.locked).toBe(false);
  expect(here.failures).toBe(0);

  await db.execute(
    sql`delete from security_events where organization_id = ${otherOrgId}`,
  );
});
