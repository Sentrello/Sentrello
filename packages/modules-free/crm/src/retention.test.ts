import { afterAll, expect, test } from "bun:test";
import { db, eq, schema } from "@sentrello/db";
import { redactPayloads } from "@sentrello/db/erasure";
import { RECORD_EVENT_PAYLOADS } from "@sentrello/db/record-events";
import { sweepRetention } from "@sentrello/db/retention";
import type {
  ModuleContext,
  RegisteredRetention,
  RetentionPolicy,
} from "@sentrello/module-sdk";
import {
  addRetention,
  clearRetention,
  retentionPolicies,
} from "@sentrello/module-sdk";
import { RECORD_EVENT_POLICY, registerCrmRetention } from "./retention";

/**
 * The change feed's own two windows.
 *
 * The mechanics belong to the shared facility and are proved in
 * `packages/db/src/retention.test.ts`. What is proved here is this module's
 * policy: ninety days for the copies, four hundred for the row, and an
 * erasure and a sweep that do not undo each other.
 */

const DAY = 24 * 60 * 60 * 1000;
const suffix = crypto.randomUUID().slice(0, 8);
const org = `crm-retention-${suffix}`;
const policy: RegisteredRetention = { ...RECORD_EVENT_POLICY, moduleId: "crm" };

afterAll(async () => {
  await db
    .delete(schema.recordEvents)
    .where(eq(schema.recordEvents.organizationId, org));
  clearRetention();
});

async function event(daysAgo: number, payload: Record<string, unknown>) {
  const [row] = await db
    .insert(schema.recordEvents)
    .values({
      organizationId: org,
      entity: "contact",
      entityId: `c-${crypto.randomUUID().slice(0, 8)}`,
      action: "updated",
      changed: ["email"],
      before: payload,
      after: payload,
      at: new Date(Date.now() - daysAgo * DAY),
    })
    .returning();
  if (!row) throw new Error("nothing was written");
  return row;
}

const read = async (id: string) =>
  (
    await db
      .select()
      .from(schema.recordEvents)
      .where(eq(schema.recordEvents.id, id))
  ).at(0);

test("the change feed keeps the copies ninety days and the fact four hundred", async () => {
  const gone = await event(401, { email: "a@x.test" });
  const summary = await event(399, { email: "b@x.test" });
  const whole = await event(89, { email: "c@x.test" });

  await sweepRetention(policy, org);

  expect(await read(gone.id)).toBeUndefined();
  const left = await read(summary.id);
  // The fact survives: which record, what changed, when, and who did it.
  expect(left?.entityId).toBe(summary.entityId);
  expect(left?.changed).toEqual(["email"]);
  expect(left?.before).toBeNull();
  expect((await read(whole.id))?.before).toEqual({ email: "c@x.test" });
});

test("a person erased from the feed is not put back by the sweep", async () => {
  const row = await event(30, { email: "erased@x.test" });
  await redactPayloads({
    table: schema.recordEvents,
    organizationId: org,
    subject: { email: "erased@x.test" },
    payloads: [...RECORD_EVENT_PAYLOADS],
  });

  await sweepRetention(policy, org);

  const after = await read(row.id);
  // Still there — thirty days old, inside both windows — and still empty.
  expect(after).toBeDefined();
  expect(after?.before).toBeNull();
  expect(after?.after).toBeNull();
});

test("the module registers the policy rather than only exporting it", () => {
  clearRetention();
  const registered: string[] = [];
  registerCrmRetention({
    registerRetention: (p: RetentionPolicy) =>
      addRetention({ ...p, moduleId: "crm" }),
  } as unknown as ModuleContext);
  for (const p of retentionPolicies()) registered.push(p.id);
  expect(registered).toContain("crm-record-events");
});
