import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, db, eq, inArray, schema, sql } from "@sentrello/db";
import { pruneAllEvents, pruneEvents } from "./retention";

/**
 * The prune deletes rows, and on a single-organization instance a prune that
 * reaches across organizations or misjudges the cutoff destroys audit history
 * nobody would ever notice missing. Two organizations are kept here for that
 * reason: every test that proves what gets removed also has a second
 * organization's history sitting untouched next to it.
 */

const suffix = crypto.randomUUID().slice(0, 8);
let orgId: string;
let otherOrgId: string;

async function makeOrg(label: string) {
  const [org] = await db
    .insert(schema.organizations)
    .values({
      id: crypto.randomUUID(),
      name: `Retention ${label} ${suffix}`,
      slug: `retention-${label}-${suffix}`,
      createdAt: new Date(),
    })
    .returning();
  if (!org) throw new Error("could not create organization");
  return org.id;
}

beforeAll(async () => {
  orgId = await makeOrg("main");
  otherOrgId = await makeOrg("other");
});

afterAll(async () => {
  await db
    .delete(schema.securityEvents)
    .where(inArray(schema.securityEvents.organizationId, [orgId, otherOrgId]));
  await db
    .delete(schema.securityPolicy)
    .where(inArray(schema.securityPolicy.organizationId, [orgId, otherOrgId]));
  await db
    .delete(schema.organizations)
    .where(inArray(schema.organizations.id, [orgId, otherOrgId]));
});

async function prunedMarkerCount(organizationId: string) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.securityEvents)
    .where(
      and(
        eq(schema.securityEvents.organizationId, organizationId),
        eq(schema.securityEvents.action, "events.pruned"),
      ),
    );
  return row?.n ?? 0;
}

test("the prune removes what is past the window and nothing newer", async () => {
  const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
  const recent = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  const [oldRow, recentRow] = await db
    .insert(schema.securityEvents)
    .values([
      {
        organizationId: orgId,
        actorId: "a",
        actorName: "A",
        action: "sign-in.failed",
        at: old,
      },
      {
        organizationId: orgId,
        actorId: "a",
        actorName: "A",
        action: "sign-in.failed",
        at: recent,
      },
    ])
    .returning({ id: schema.securityEvents.id });
  if (!oldRow || !recentRow) throw new Error("insert did not return rows");

  const removed = await pruneEvents(orgId);
  expect(removed).toBe(1);

  const left = await db
    .select({ id: schema.securityEvents.id })
    .from(schema.securityEvents)
    .where(eq(schema.securityEvents.organizationId, orgId));
  const ids = left.map((r) => r.id);
  // Not just "everything left is newer than the cutoff" — that is equally
  // true if the prune deleted everything. The recent row has to still be the
  // exact row it was, and the old one has to be gone by its own id.
  expect(ids).toContain(recentRow.id);
  expect(ids).not.toContain(oldRow.id);
});

test("a prune that removes nothing records nothing", async () => {
  const before = await prunedMarkerCount(orgId);
  expect(await pruneEvents(orgId)).toBe(0);
  expect(await prunedMarkerCount(orgId)).toBe(before);
});

test("pruning one organization does not touch another's history", async () => {
  const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
  const [otherOld] = await db
    .insert(schema.securityEvents)
    .values({
      organizationId: otherOrgId,
      actorId: null,
      actorName: null,
      action: "sign-in.failed",
      at: old,
    })
    .returning({ id: schema.securityEvents.id });
  if (!otherOld) throw new Error("insert did not return a row");

  const removed = await pruneEvents(orgId);

  const [stillThere] = await db
    .select({ id: schema.securityEvents.id })
    .from(schema.securityEvents)
    .where(eq(schema.securityEvents.id, otherOld.id));
  expect(stillThere).toBeDefined();
  // orgId has nothing left to prune at this point in the suite; this also
  // pins that the removal count reported is orgId's own, not the total
  // across every organization in the table.
  expect(removed).toBe(0);
});

test("a retention window of zero turns pruning off entirely", async () => {
  // policyFor inserts the default row the first time an organization is
  // touched, so this needs a real update rather than an insert.
  await pruneEvents(orgId);
  await db
    .update(schema.securityPolicy)
    .set({ eventRetentionDays: 0 })
    .where(eq(schema.securityPolicy.organizationId, orgId));

  const old = new Date(Date.now() - 4000 * 24 * 60 * 60 * 1000);
  const [ancient] = await db
    .insert(schema.securityEvents)
    .values({
      organizationId: orgId,
      actorId: null,
      actorName: null,
      action: "sign-in.failed",
      at: old,
    })
    .returning({ id: schema.securityEvents.id });
  if (!ancient) throw new Error("insert did not return a row");

  expect(await pruneEvents(orgId)).toBe(0);

  const [stillThere] = await db
    .select({ id: schema.securityEvents.id })
    .from(schema.securityEvents)
    .where(eq(schema.securityEvents.id, ancient.id));
  expect(stillThere).toBeDefined();

  await db
    .update(schema.securityPolicy)
    .set({ eventRetentionDays: 365 })
    .where(eq(schema.securityPolicy.organizationId, orgId));
});

test("pruneAllEvents reaches every organization, not just the one it was last called with", async () => {
  const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
  const [rowA] = await db
    .insert(schema.securityEvents)
    .values({
      organizationId: orgId,
      actorId: null,
      actorName: null,
      action: "sign-in.failed",
      at: old,
    })
    .returning({ id: schema.securityEvents.id });
  const [rowB] = await db
    .insert(schema.securityEvents)
    .values({
      organizationId: otherOrgId,
      actorId: null,
      actorName: null,
      action: "sign-in.failed",
      at: old,
    })
    .returning({ id: schema.securityEvents.id });
  if (!rowA || !rowB) throw new Error("insert did not return rows");

  const total = await pruneAllEvents();
  // Other organizations may exist in this database with nothing to prune;
  // the claim is only that this call's own two rows are both gone, which a
  // loop that stopped after the first organization would not achieve.
  expect(total).toBeGreaterThanOrEqual(2);

  const [aLeft] = await db
    .select({ id: schema.securityEvents.id })
    .from(schema.securityEvents)
    .where(eq(schema.securityEvents.id, rowA.id));
  const [bLeft] = await db
    .select({ id: schema.securityEvents.id })
    .from(schema.securityEvents)
    .where(eq(schema.securityEvents.id, rowB.id));
  expect(aLeft).toBeUndefined();
  expect(bLeft).toBeUndefined();
});

test("an old pruned-marker row is never itself pruned", async () => {
  const veryOld = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
  const [marker] = await db
    .insert(schema.securityEvents)
    .values({
      organizationId: orgId,
      actorId: null,
      actorName: null,
      action: "events.pruned",
      at: veryOld,
      detail: { removed: 1, olderThanDays: 365 },
    })
    .returning({ id: schema.securityEvents.id });
  if (!marker) throw new Error("insert did not return a row");

  await pruneEvents(orgId);

  const [stillThere] = await db
    .select({ id: schema.securityEvents.id })
    .from(schema.securityEvents)
    .where(eq(schema.securityEvents.id, marker.id));
  expect(stillThere).toBeDefined();
});
