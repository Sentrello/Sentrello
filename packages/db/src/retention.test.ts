import { afterAll, expect, test } from "bun:test";
import {
  STATUTORY_TABLES,
  addRetention,
  classifySchema,
  clearRetention,
  isStatutoryTable,
  retentionPolicies,
} from "@sentrello/module-sdk";
import type { RegisteredRetention } from "@sentrello/module-sdk";
import { eq, getTableColumns, getTableName, isTable, like } from "drizzle-orm";
import { db } from "./client";
import { redactPayloads } from "./erasure";
import { RECORD_EVENT_PAYLOADS } from "./record-events";
import {
  NON_STATUTORY_TABLES,
  forgetRetentionSweep,
  lastRetentionSweep,
  retentionBacklog,
  sweepAllRetention,
  sweepRetention,
} from "./retention";
import * as schema from "./schema";
import { recordEvents } from "./schema";

/**
 * The shared sweep, tested on the change feed.
 *
 * `record_events` stands in for every log in the product: a row per thing that
 * happened, two jsonb payloads carrying a copy of the record it happened to,
 * and a timestamp. Everything proved here — the window to the day, an
 * interrupted sweep resuming, a second organisation untouched, an erased row
 * staying erased — is a property of the facility rather than of this table.
 *
 * `organizationId` is free text on this table, so these tests need no
 * organisation rows except where they exercise the loop over all of them.
 */

const DAY = 24 * 60 * 60 * 1000;
const suffix = crypto.randomUUID().slice(0, 8);

/**
 * A fresh organisation per test.
 *
 * Shared ids made these tests each other's leftovers, which is the same
 * mistake — a log nobody cleans up — one directory down.
 */
const anOrg = () => `retention-${suffix}-${crypto.randomUUID().slice(0, 8)}`;

afterAll(async () => {
  await db
    .delete(recordEvents)
    .where(like(recordEvents.organizationId, `retention-${suffix}%`));
  await db
    .delete(schema.organizations)
    .where(like(schema.organizations.id, `retention-${suffix}%`));
  clearRetention();
  forgetRetentionSweep();
});

/** A feed row of a given age, carrying a copy of a record. */
async function event(
  organizationId: string,
  daysAgo: number,
  payload: Record<string, unknown> | null = { name: "A Person" },
) {
  const [row] = await db
    .insert(recordEvents)
    .values({
      organizationId,
      entity: "deal",
      entityId: `d-${crypto.randomUUID().slice(0, 8)}`,
      action: "updated",
      changed: ["stage"],
      before: payload,
      after: payload,
      at: new Date(Date.now() - daysAgo * DAY),
    })
    .returning();
  if (!row) throw new Error("nothing was written");
  return row;
}

const policy = (
  over: Partial<RegisteredRetention> = {},
): RegisteredRetention => ({
  moduleId: "test",
  id: `test-${crypto.randomUUID().slice(0, 8)}`,
  label: "Change feed",
  table: recordEvents,
  clock: recordEvents.at,
  payloads: [...RECORD_EVENT_PAYLOADS],
  window: () => ({ emptyAfterDays: 90, removeAfterDays: 400 }),
  ...over,
});

const read = async (id: string) =>
  (await db.select().from(recordEvents).where(eq(recordEvents.id, id))).at(0);

// --- the window ------------------------------------------------------------

test("the window is kept to the day, in both directions", async () => {
  const org = anOrg();
  const gone = await event(org, 401);
  const kept = await event(org, 399);
  const trimmed = await event(org, 91);
  const whole = await event(org, 89);

  const result = await sweepRetention(policy(), org);

  expect(await read(gone.id)).toBeUndefined();
  expect(await read(kept.id)).toBeDefined();
  // Past the first horizon and inside the second: the row stands, the copies
  // are gone, and what changed is still readable.
  const bare = await read(trimmed.id);
  expect(bare?.before).toBeNull();
  expect(bare?.after).toBeNull();
  expect(bare?.changed).toEqual(["stage"]);
  const full = await read(whole.id);
  expect(full?.before).toEqual({ name: "A Person" });

  expect(result.removed).toBe(1);
  // `kept` is 399 days old and holds a payload, so it is emptied too.
  expect(result.emptied).toBe(2);
  expect(result.backlog).toBe(0);
});

test("a window of zero keeps everything for ever", async () => {
  const org = anOrg();
  const ancient = await event(org, 4000);
  const result = await sweepRetention(policy({ window: () => ({}) }), org);
  expect(await read(ancient.id)).toBeDefined();
  expect(result).toMatchObject({ removed: 0, emptied: 0, backlog: 0 });
  await db.delete(recordEvents).where(eq(recordEvents.id, ancient.id));
});

test("a row that has not finished is live state and is never touched", async () => {
  const org = anOrg();
  const unfinished = await event(org, 500);
  // `handledAt` is null until something has dispatched the event: the clock
  // says this row is not finished, so age is irrelevant.
  const result = await sweepRetention(
    policy({ clock: recordEvents.handledAt }),
    org,
  );
  expect(await read(unfinished.id)).toBeDefined();
  expect(result.removed).toBe(0);

  await db
    .update(recordEvents)
    .set({ handledAt: new Date(Date.now() - 500 * DAY) })
    .where(eq(recordEvents.id, unfinished.id));
  await sweepRetention(policy({ clock: recordEvents.handledAt }), org);
  expect(await read(unfinished.id)).toBeUndefined();
});

test("rows a policy spares are never removed, however old", async () => {
  const org = anOrg();
  const spared = await event(org, 4000);
  const ordinary = await event(org, 4000);
  await sweepRetention(policy({ keep: eq(recordEvents.id, spared.id) }), org);
  expect(await read(spared.id)).toBeDefined();
  expect(await read(ordinary.id)).toBeUndefined();
  await db.delete(recordEvents).where(eq(recordEvents.id, spared.id));
});

// --- other organisations ---------------------------------------------------

test("a sweep never reaches another organisation's rows", async () => {
  const org = anOrg();
  const other = anOrg();
  const mine = await event(org, 500);
  const theirs = await event(other, 500);

  const result = await sweepRetention(policy(), org);

  expect(await read(mine.id)).toBeUndefined();
  expect(await read(theirs.id)).toBeDefined();
  // And the count reported is this organisation's own, not the table's.
  expect(result.removed).toBe(1);
  expect(await retentionBacklog(policy(), org)).toBe(0);
  expect(await retentionBacklog(policy(), other)).toBe(1);

  await db.delete(recordEvents).where(eq(recordEvents.id, theirs.id));
});

// --- interruption ----------------------------------------------------------

test("a sweep interrupted mid-way resumes with nothing lost or repeated", async () => {
  const org = anOrg();
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(await event(org, 500));

  let batches = 0;
  const crashing = policy({
    // The power goes off between the second batch being chosen and its rows
    // being removed. Everything before it is already committed.
    cascade: async () => {
      batches += 1;
      if (batches === 2) throw new Error("the power went off");
      return 0;
    },
  });
  await expect(sweepRetention(crashing, org, { batch: 2 })).rejects.toThrow(
    "the power went off",
  );

  const left = await db
    .select({ id: recordEvents.id })
    .from(recordEvents)
    .where(eq(recordEvents.organizationId, org));
  expect(left).toHaveLength(3);

  // No cursor was kept, and none is needed: the predicate is the complement
  // of what the sweep writes, so the rows already gone are not offered again.
  const resumed = await sweepRetention(policy(), org, { batch: 2 });
  expect(resumed.removed).toBe(3);
  expect(resumed.backlog).toBe(0);
  for (const row of rows) expect(await read(row.id)).toBeUndefined();
});

test("an emptying interrupted half way empties the rest and re-empties nothing", async () => {
  const org = anOrg();
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(await event(org, 100));

  let batches = 0;
  const crashing = policy({
    window: () => ({ emptyAfterDays: 90 }),
    cascade: async () => {
      batches += 1;
      if (batches === 2) throw new Error("the power went off");
      return 0;
    },
  });
  await expect(sweepRetention(crashing, org, { batch: 2 })).rejects.toThrow(
    "the power went off",
  );

  const resumed = await sweepRetention(
    policy({ window: () => ({ emptyAfterDays: 90 }) }),
    org,
    { batch: 2 },
  );
  // Three, not five: the two already emptied no longer match, so the work is
  // neither repeated nor reported twice.
  expect(resumed.emptied).toBe(3);
  for (const row of rows) {
    const after = await read(row.id);
    expect(after?.before).toBeNull();
    expect(after?.entityId).toBe(row.entityId);
  }
  // And a third sweep has nothing left to do at all.
  const again = await sweepRetention(
    policy({ window: () => ({ emptyAfterDays: 90 }) }),
    org,
    { batch: 2 },
  );
  expect(again.emptied).toBe(0);
  await db.delete(recordEvents).where(eq(recordEvents.organizationId, org));
});

test("a sweep out of budget does nothing and says what is still owed", async () => {
  const org = anOrg();
  const old = await event(org, 500);
  const result = await sweepRetention(policy(), org, { deadline: Date.now() });
  expect(await read(old.id)).toBeDefined();
  expect(result.removed).toBe(0);
  expect(result.backlog).toBe(1);
  await db.delete(recordEvents).where(eq(recordEvents.id, old.id));
});

// --- erasure ---------------------------------------------------------------

test("a row an erasure already emptied is not restored and not emptied again", async () => {
  const org = anOrg();
  const erased = await event(org, 100, { name: "Gone", email: "g@x.test" });
  const cleared = await redactPayloads({
    table: recordEvents,
    organizationId: org,
    subject: { email: "g@x.test" },
    payloads: [...RECORD_EVENT_PAYLOADS],
  });
  expect(cleared).toBe(1);

  const result = await sweepRetention(
    policy({ window: () => ({ emptyAfterDays: 90 }) }),
    org,
  );
  // Nightly for ever, on every erased row in the table, is what a predicate
  // written as `is not null` would have bought.
  expect(result.emptied).toBe(0);
  expect(result.backlog).toBe(0);
  const after = await read(erased.id);
  expect(after?.before).toBeNull();
  expect(after?.after).toBeNull();
  await db.delete(recordEvents).where(eq(recordEvents.id, erased.id));
});

test("a payload emptied key by key is not emptied a second time", async () => {
  const org = anOrg();
  // The shape the paid bundle's run logs use: one jsonb column with the copy
  // nested under a key, emptied to JSON null rather than to SQL NULL. `is not
  // null` would call that full every night for ever.
  const row = await event(org, 100, { record: { name: "A Person" } });
  const keyed = policy({
    payloads: [{ column: recordEvents.before, keys: ["record"] }],
    window: () => ({ emptyAfterDays: 90 }),
  });
  expect((await sweepRetention(keyed, org)).emptied).toBe(1);
  expect((await read(row.id))?.before).toEqual({ record: null });
  expect((await sweepRetention(keyed, org)).emptied).toBe(0);
  await db.delete(recordEvents).where(eq(recordEvents.id, row.id));
});

// --- failure isolation and visibility --------------------------------------

test("one module's failing policy does not stop another's sweep", async () => {
  const org = anOrg();
  const [organization] = await db
    .insert(schema.organizations)
    .values({
      id: org,
      name: `Retention ${suffix}`,
      slug: `retention-${suffix}`,
      createdAt: new Date(),
    })
    .returning();
  if (!organization) throw new Error("no organization");

  const old = await event(org, 500);
  clearRetention();
  forgetRetentionSweep();
  addRetention(
    policy({
      id: "broken",
      label: "A module that got it wrong",
      window: () => {
        throw new Error("this policy is nonsense");
      },
    }),
  );
  addRetention(policy({ id: "sound", label: "Change feed" }));

  const report = await sweepAllRetention();

  // The sound policy did its work, in the same sweep, after the broken one.
  expect(await read(old.id)).toBeUndefined();
  expect(report.removed).toBeGreaterThanOrEqual(1);
  // Reported rather than swallowed, and only the broken one failed. Other
  // organisations may exist in this database with nothing to sweep; the
  // claim is that this one's failure is named and no other policy's is.
  expect(report.failed.every((f) => f.policy === "broken")).toBe(true);
  expect(
    report.failed.some(
      (f) => f.organizationId === org && f.error.includes("nonsense"),
    ),
  ).toBe(true);
  // And it is on the record where monitoring reads it, rather than only in a
  // log line nobody on a self-hosted box is watching.
  expect(lastRetentionSweep()?.at).toBe(report.at);
  expect(lastRetentionSweep()?.policies.map((p) => p.id)).toContain("sound");

  clearRetention();
  forgetRetentionSweep();
  await db.delete(schema.organizations).where(eq(schema.organizations.id, org));
});

// --- statutory records -----------------------------------------------------

test("a policy pointed at a statutory table is refused", () => {
  clearRetention();
  const invoices = {
    ...policy({ id: "greedy" }),
    table: schema.invoices,
  } as unknown as RegisteredRetention;
  expect(() => addRetention(invoices)).toThrow(/statutory/);
  expect(retentionPolicies()).toHaveLength(0);

  // The compiler refuses it first — `NotStatutory<typeof schema.invoices>`
  // resolves to `never`, so this does not type-check and the cast above is
  // the only way a policy on the books could ever reach the registry.
  // @ts-expect-error — invoices is a statutory record and cannot be swept
  const refused: NotStatutory<typeof schema.invoices> = schema.invoices;
  expect(refused).toBeDefined();
});

test("something that is not a table at all is refused rather than swept", () => {
  clearRetention();
  const nonsense = {
    ...policy({ id: "nonsense" }),
    table: { id: {}, organizationId: {} },
  } as unknown as RegisteredRetention;
  expect(() => addRetention(nonsense)).toThrow(/not a table/);
});

test("every table carrying money is named as statutory", () => {
  const unguarded: string[] = [];
  for (const exported of Object.values(schema)) {
    if (!isTable(exported)) continue;
    const columns = Object.values(getTableColumns(exported)).map((c) => c.name);
    if (!columns.some((name) => name.endsWith("_cents"))) continue;
    const name = getTableName(exported);
    if (!(STATUTORY_TABLES as readonly string[]).includes(name)) {
      unguarded.push(name);
    }
  }
  // A new table that holds an amount and is not on the list is a table a
  // retention policy could be pointed at. Add it to STATUTORY_TABLES.
  expect(unguarded).toEqual([]);
});

/**
 * And the ratchet that catches what a column name cannot see.
 *
 * The test above is a cheap net over the common case and it is not the
 * guarantee. It passed for months while four tables recording what customers
 * bought and were billed for sat unprotected, because a licence, a
 * subscription and an entitlement are evidence of a sale written entirely in
 * dates and identifiers and carry no amount at all — and widening the net by
 * column name goes wrong in the other direction just as fast, since
 * `companies.tax_identifier` and `organizations.base_currency` read like
 * money and are a VAT number and a preference.
 *
 * So the decision is a person's, and this is what makes it a deliberate one:
 * every table in the schema has to be named in one list or the other. A table
 * added tomorrow is in neither, and this fails until somebody has looked at
 * it.
 */
test("every table in the schema has been classified, one way or the other", () => {
  // The ratchet itself lives in the SDK, so the three repositories that have
  // to hold this property run the same one over their own schemas rather than
  // writing it three ways. Core's is the first caller.
  const gaps = classifySchema(schema, NON_STATUTORY_TABLES);

  // A new table. Decide whether losing it would stop a business answering an
  // auditor, and name it in STATUTORY_TABLES or NON_STATUTORY_TABLES.
  expect(gaps.unclassified).toEqual([]);
  expect(gaps.both).toEqual([]);
  // And the other way: a name left behind by a table that has been removed or
  // renamed, which would quietly stop guarding anything.
  expect(gaps.stale).toEqual([]);
});

/**
 * And the half of the guarantee that lives outside this repository.
 *
 * The refusal is by name, so naming a module's table here is what protects it
 * — and until today not one of the optional modules' tables was named, while
 * thirteen retention policies were registered against that schema. A policy
 * pointed at a till's Z closure, a shop's cost layers or a subscription's
 * charge attempts would have compiled, registered and run.
 *
 * This test names them as the modules repository spells them. It cannot see
 * that schema, so it builds the table the way drizzle does — the name and the
 * schema under the symbols `retentionTableName` reads — and asks the same
 * question `addRetention` asks. `classifySchema` is what stops the *next* one
 * being missed, over there, in that repository's own suite.
 */
test("the optional modules' records of money taken are refused too", () => {
  const foreign = (qualified: string) => {
    const [schemaName, name] = qualified.split(".");
    return {
      [Symbol.for("drizzle:Name")]: name,
      [Symbol.for("drizzle:Schema")]: schemaName,
    } as unknown as Parameters<typeof isStatutoryTable>[0];
  };

  const unguarded = [
    "pos.tickets",
    "pos.ticket_line_modifiers",
    "pos.adjustments",
    "pos.drawers",
    "pos.drawer_events",
    "pos.closures",
    "pos.receipts",
    "pos.receipt_issues",
    "shop.orders",
    "shop.order_lines",
    "shop.fulfillments",
    "shop.allocations",
    "shop.stock_layers",
    "shop.stock_moves",
    "shop.tax_classes",
    "shop.tax_rates",
    "shop.discounts",
    "subscriptions.charge_attempts",
    "subscriptions.plan_changes",
    "subscriptions.dunning_cycles",
    "subscriptions.discounts",
    "seo.usage",
    "links.events",
  ].filter((name) => !isStatutoryTable(foreign(name)));
  expect(unguarded).toEqual([]);

  // And a module's own log is still sweepable: a qualified entry refuses that
  // table and not every table that happens to share its bare name.
  expect(isStatutoryTable(foreign("crm.events"))).toBe(false);
});

/**
 * The control plane's own records, by name.
 *
 * They are not in this schema — they belong to the instance that sells
 * licences rather than to a business's own — but the refusal is by table
 * name, so naming them here is what stops a policy being written against them
 * anywhere. Every one is the answer to "what did this customer buy, and what
 * were they billed for it", which is the same question an invoice answers.
 */
test("what a customer bought and was billed for is statutory too", () => {
  clearRetention();
  const table = (name: string, schemaName?: string) => {
    const made = {
      _: { name },
      id: { name: "id", getSQL: () => null },
      organizationId: { name: "organization_id", getSQL: () => null },
    } as Record<string | symbol, unknown>;
    made[Symbol.for("drizzle:Name")] = name;
    if (schemaName) made[Symbol.for("drizzle:Schema")] = schemaName;
    return made;
  };

  for (const [name, schemaName] of [
    ["licenses", undefined],
    ["license_subscriptions", undefined],
    ["entitlements", undefined],
    ["seo_usage_invoices", undefined],
    ["calls", "seo_cloud"],
    ["credits", "seo_cloud"],
  ] as [string, string | undefined][]) {
    const greedy = {
      ...policy({ id: `control-plane-${name}` }),
      table: table(name, schemaName),
    } as unknown as RegisteredRetention;
    expect(() => addRetention(greedy)).toThrow(/statutory/);
  }
  expect(retentionPolicies()).toHaveLength(0);

  /*
   * And the qualified names are qualified for a reason: a module that keeps a
   * log of telephone calls is not touching the metered-usage ledger, and
   * refusing every table in the product called `calls` would be a rule
   * nobody could work with.
   */
  const ownCalls = {
    ...policy({ id: "a-crm-call-log" }),
    table: table("calls", "crm"),
  } as unknown as RegisteredRetention;
  addRetention(ownCalls);
  expect(retentionPolicies()).toHaveLength(1);
  clearRetention();
});
