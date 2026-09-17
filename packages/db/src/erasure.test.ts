import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "./client";
import { redactPayloads } from "./erasure";
import { recordEvents } from "./schema";

/**
 * The seam a workflow run log goes through to forget somebody.
 *
 * The run logs themselves live in the paid bundle, and their context is a
 * record nested inside the run's own working state — nothing like the flat
 * before/after of the change feed. So the matching cannot be about key names:
 * it is about whether the person appears anywhere inside the payload, at any
 * depth. A rule written against key names would have to know `record`,
 * `before`, `contactId` and `entityId`, and would be wrong about the fifth.
 *
 * `record_events` stands in here because it is a jsonb payload on a table this
 * package owns; the shape written into it below is a run's context.
 */

const org = `erasure-${crypto.randomUUID().slice(0, 8)}`;
const other = `${org}-else`;
const email = "Deep@Example.test";

afterAll(async () => {
  for (const id of [org, other]) {
    await db.delete(recordEvents).where(eq(recordEvents.organizationId, id));
  }
});

test("a person nested deep inside a run's context is found and emptied", async () => {
  const context = {
    record: { id: "r-1", name: "Deep Person", email },
    steps: { "send-email": { to: email, sent: true } },
  };
  const [run] = await db
    .insert(recordEvents)
    .values({
      organizationId: org,
      entity: "deal",
      entityId: "d-1",
      action: "updated",
      changed: ["stage"],
      before: context,
      after: { record: { id: "r-1" }, steps: {} },
    })
    .returning();
  if (!run) throw new Error("nothing was written");

  // Another organization's run, holding the same address. The whole point.
  const [theirs] = await db
    .insert(recordEvents)
    .values({
      organizationId: other,
      entity: "deal",
      entityId: "d-2",
      action: "updated",
      changed: ["stage"],
      before: context,
      after: null,
    })
    .returning();
  if (!theirs) throw new Error("nothing was written");

  // Asked for by address, in the case the asker typed it differently.
  const cleared = await redactPayloads({
    table: recordEvents,
    organizationId: org,
    subject: { email: "deep@example.TEST" },
    payloads: [recordEvents.before, recordEvents.after],
  });
  expect(cleared).toBe(1);

  const [after] = await db
    .select()
    .from(recordEvents)
    .where(eq(recordEvents.id, run.id));
  // The run is still legible: it happened, to this record, and this moved.
  expect(after?.entity).toBe("deal");
  expect(after?.entityId).toBe("d-1");
  expect(after?.changed).toEqual(["stage"]);
  // And holds nothing about anybody.
  expect(after?.before).toBeNull();
  expect(after?.after).toBeNull();

  const [untouched] = await db
    .select()
    .from(recordEvents)
    .where(eq(recordEvents.id, theirs.id));
  expect(
    (untouched?.before as { record?: { email?: string } } | null)?.record
      ?.email,
  ).toBe(email);
});

test("an id that only appears under some other key still counts", async () => {
  const [row] = await db
    .insert(recordEvents)
    .values({
      organizationId: org,
      entity: "activity",
      entityId: "a-1",
      action: "created",
      changed: [],
      after: { id: "a-1", contactId: "r-9", body: "Rang about the gutters" },
    })
    .returning();
  if (!row) throw new Error("nothing was written");

  const cleared = await redactPayloads({
    table: recordEvents,
    organizationId: org,
    subject: { id: "r-9" },
    payloads: [recordEvents.before, recordEvents.after],
  });
  expect(cleared).toBe(1);

  const [after] = await db
    .select()
    .from(recordEvents)
    .where(eq(recordEvents.id, row.id));
  expect(after?.after).toBeNull();
  expect(after?.entity).toBe("activity");
});

/**
 * Knowing nothing about somebody is not grounds to empty everything.
 *
 * A privacy screen posted with a blank form is the way this function could do
 * the most damage, and an erasure it cannot aim has to change nothing.
 */
test("a subject with nothing on it clears nothing", async () => {
  const [row] = await db
    .insert(recordEvents)
    .values({
      organizationId: org,
      entity: "deal",
      entityId: "d-3",
      action: "created",
      changed: [],
      after: { id: "d-3", name: "Still Here" },
    })
    .returning();
  if (!row) throw new Error("nothing was written");

  expect(
    await redactPayloads({
      table: recordEvents,
      organizationId: org,
      subject: {},
      payloads: [recordEvents.before, recordEvents.after],
    }),
  ).toBe(0);

  const [after] = await db
    .select()
    .from(recordEvents)
    .where(eq(recordEvents.id, row.id));
  expect((after?.after as { name?: string } | null)?.name).toBe("Still Here");
});
