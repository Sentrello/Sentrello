import { afterAll, expect, test } from "bun:test";
import { db, eq, schema } from "@sentrello/db";
import { recent } from "./security-events";

/**
 * `recent`, and the exclusion `GET /api/users`'s Recent-changes card needs.
 *
 * Task 8's addendum: once sign-in events exist, twenty-five bot attempts
 * evict every administrative action from a card that only ever asked for the
 * most recent 25 rows. Filtering the array `recent` already returned would
 * not fix that — the noise has already pushed the administrative rows out of
 * the 25 by the time a caller could filter them back out. The exclusion has
 * to happen inside the query, before the `limit`, which is what these tests
 * pin: a caller asking for 2 recent rows, excluding one action, gets the 2
 * most recent rows that are *not* that action, not the 2 most recent rows
 * overall with the excluded ones stripped out afterward.
 */

const orgId = crypto.randomUUID();

afterAll(async () => {
  await db
    .delete(schema.securityEvents)
    .where(eq(schema.securityEvents.organizationId, orgId));
});

async function seed() {
  await db
    .delete(schema.securityEvents)
    .where(eq(schema.securityEvents.organizationId, orgId));
  // Two administrative events, older...
  await db.insert(schema.securityEvents).values([
    {
      organizationId: orgId,
      action: "group.created",
      at: new Date(Date.now() - 5000),
    },
    {
      organizationId: orgId,
      action: "policy.changed",
      at: new Date(Date.now() - 4000),
    },
  ]);
  // ...then three noisy sign-in failures, more recent than both.
  await db.insert(schema.securityEvents).values([
    {
      organizationId: orgId,
      action: "sign-in.failed",
      at: new Date(Date.now() - 3000),
    },
    {
      organizationId: orgId,
      action: "sign-in.failed",
      at: new Date(Date.now() - 2000),
    },
    {
      organizationId: orgId,
      action: "sign-in.failed",
      at: new Date(Date.now() - 1000),
    },
  ]);
}

test("with no exclusion, the most recent rows are whatever they are", async () => {
  await seed();
  const rows = await recent(orgId, 2);
  // The three sign-in failures are the most recent three rows, so an
  // unfiltered read of the top 2 is entirely sign-in noise — this is the bug
  // the exclusion exists to fix, pinned here so a regression in the other
  // direction (exclusion applied when none was asked for) would fail this
  // test instead of going unnoticed.
  expect(rows).toHaveLength(2);
  expect(rows.every((r) => r.action === "sign-in.failed")).toBe(true);
});

test("excluding an action keeps it out of the window the limit is drawn from", async () => {
  await seed();
  const rows = await recent(orgId, 2, { exclude: ["sign-in.failed"] });
  expect(rows).toHaveLength(2);
  expect(rows.map((r) => r.action).sort()).toEqual([
    "group.created",
    "policy.changed",
  ]);
});
