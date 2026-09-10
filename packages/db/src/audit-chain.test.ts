import { afterEach, beforeAll, expect, test } from "bun:test";
import { asc, db, eq, schema, sql } from "@sentrello/db";
import { record, verifyChain } from "./security-events";

/**
 * Whether an edit to the audit log can be found afterwards.
 *
 * "Append-only from the application's side" was true before this and was never
 * evidence of anything: the application is not the only thing that can reach
 * the table, and the log is what HIPAA, SOC 2 and 800-171 lean on. So every
 * test here reaches past the application and writes SQL, because that is the
 * threat — a check that only proves the application behaves is a check that
 * tests the wrong actor.
 */
const orgId = `audit-chain-${crypto.randomUUID().slice(0, 8)}`;
const other = `audit-other-${crypto.randomUUID().slice(0, 8)}`;

beforeAll(() => {
  // Every assertion below depends on a key existing; without one the chain is
  // never written and each of these would pass by not being checked at all.
  expect(
    Boolean(process.env.SENTRELLO_SECRET_KEY || process.env.BETTER_AUTH_SECRET),
  ).toBe(true);
});

afterEach(async () => {
  for (const id of [orgId, other]) {
    await db
      .delete(schema.securityEvents)
      .where(eq(schema.securityEvents.organizationId, id));
  }
});

const write = async (n: number, organizationId = orgId) => {
  for (let i = 0; i < n; i += 1) {
    await record({
      organizationId,
      actor: { id: `actor-${i}`, name: `Person ${i}` },
      subject: { id: `subject-${i}`, name: `Target ${i}` },
      action: "role.changed",
      detail: { from: "member", to: "admin", n: i },
    });
  }
};

const rows = () =>
  db
    .select()
    .from(schema.securityEvents)
    .where(eq(schema.securityEvents.organizationId, orgId))
    .orderBy(asc(schema.securityEvents.at), asc(schema.securityEvents.id));

test("a log nobody has touched verifies, and reports its head", async () => {
  await write(4);
  const verdict = await verifyChain(orgId);
  expect(verdict.intact).toBe(true);
  expect(verdict.checked).toBe(4);
  expect(verdict.problems).toEqual([]);
  expect(verdict.unchained).toBe(0);
  // The one thing worth copying somewhere the database cannot reach.
  expect(verdict.head).toBeTruthy();
  expect(verdict.head).toBe((await rows())[3]?.hash ?? null);
});

test("editing an entry is found", async () => {
  await write(4);
  const before = await rows();
  const target = before[1];
  if (!target) throw new Error("no row to edit");

  // The rewrite somebody would actually make: soften what was done, leave
  // everything else — including the row's own hash — exactly as it was.
  await db.execute(
    sql`update security_events set action = 'password.reset' where id = ${target.id}`,
  );

  const verdict = await verifyChain(orgId);
  expect(verdict.intact).toBe(false);
  expect(verdict.problems.join(" ")).toContain("altered");
});

test("editing the detail rather than the row is found too", async () => {
  await write(3);
  const target = (await rows())[1];
  if (!target) throw new Error("no row to edit");

  // A role change from member to admin, rewritten to look routine. The
  // columns a list renders are untouched; only the detail moved.
  await db.execute(
    sql`update security_events set detail = '{"from":"admin","to":"admin","n":1}'::jsonb where id = ${target.id}`,
  );

  expect((await verifyChain(orgId)).intact).toBe(false);
});

test("moving an entry's timestamp is found", async () => {
  await write(3);
  const target = (await rows())[1];
  if (!target) throw new Error("no row to move");

  await db.execute(
    sql`update security_events set at = at - interval '30 days' where id = ${target.id}`,
  );

  expect((await verifyChain(orgId)).intact).toBe(false);
});

test("removing an entry from the middle is found", async () => {
  await write(4);
  const target = (await rows())[1];
  if (!target) throw new Error("no row to delete");

  await db.execute(sql`delete from security_events where id = ${target.id}`);

  const verdict = await verifyChain(orgId);
  expect(verdict.intact).toBe(false);
  expect(verdict.problems.join(" ")).toContain("missing");
});

/**
 * The limit, asserted rather than described.
 *
 * A chain proves its links; it does not know how long it should be. This is
 * why `verifyChain` hands back the head hash and the screen says to keep a
 * copy of it somewhere else. Pinning it here means nobody later reads a clean
 * verdict as proof of something it never claimed.
 */
test("deleting the newest entries leaves a chain that still verifies", async () => {
  await write(4);
  const head = (await verifyChain(orgId)).head;

  const last = (await rows())[3];
  if (!last) throw new Error("no row to truncate");
  await db.execute(sql`delete from security_events where id = ${last.id}`);

  const after = await verifyChain(orgId);
  expect(after.intact).toBe(true);
  // And this is what gives it away: the head moved, so a copy kept outside
  // the database no longer matches.
  expect(after.head).not.toBe(head);
});

/**
 * Retention pruning removes the oldest rows on purpose, so the front of the
 * chain going missing must not read as tampering — or the check cries wolf
 * every time the retention job runs, and gets switched off.
 */
test("pruning the oldest entries is not mistaken for tampering", async () => {
  await write(4);
  const oldest = (await rows())[0];
  if (!oldest) throw new Error("no row to prune");

  await db.execute(sql`delete from security_events where id = ${oldest.id}`);

  const verdict = await verifyChain(orgId);
  expect(verdict.intact).toBe(true);
  expect(verdict.checked).toBe(3);
});

test("rows written before the chain existed are counted, not condemned", async () => {
  await write(2);
  // As an upgrade leaves them: a real entry with no signature.
  await db.insert(schema.securityEvents).values({
    organizationId: orgId,
    action: "password.reset",
    at: new Date(Date.now() - 86_400_000),
  });

  const verdict = await verifyChain(orgId);
  expect(verdict.unchained).toBe(1);
  expect(verdict.intact).toBe(true);
});

test("one business's log is checked without the other's", async () => {
  await write(3);
  await write(2, other);

  const mine = await verifyChain(orgId);
  expect(mine.intact).toBe(true);
  expect(mine.checked).toBe(3);

  // And breaking theirs does not break mine: the chains are separate, so one
  // business cannot make another's log look interfered with.
  const theirs = await db
    .select()
    .from(schema.securityEvents)
    .where(eq(schema.securityEvents.organizationId, other));
  await db.execute(
    sql`update security_events set action = 'password.reset' where id = ${theirs[0]?.id}`,
  );

  expect((await verifyChain(orgId)).intact).toBe(true);
  expect((await verifyChain(other)).intact).toBe(false);
});
