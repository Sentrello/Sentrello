import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "./index";
import {
  accountingFieldsFor,
  accountingValues,
  ownedDimension,
  periodFrom,
  postJournalEntry,
  taggingFrom,
} from "./ledger";

let orgId: string;
let cashId: string;
let arId: string;
let kitchenId: string;

beforeAll(async () => {
  const suffix = crypto.randomUUID();
  const [org] = await db
    .insert(schema.organizations)
    .values({
      id: suffix,
      name: `ledger-test-${suffix}`,
      slug: `ledger-test-${suffix}`,
      createdAt: new Date(),
    })
    .returning();
  if (!org) throw new Error("could not create test organization");
  orgId = org.id;

  const created = await db
    .insert(schema.accounts)
    .values([
      { organizationId: orgId, code: "1000", name: "Cash", type: "asset" },
      {
        organizationId: orgId,
        code: "1100",
        name: "Accounts Receivable",
        type: "asset",
      },
    ])
    .returning();
  const [cash, ar] = created;
  if (!cash || !ar) throw new Error("could not create test accounts");
  cashId = cash.id;
  arId = ar.id;

  const [kitchen] = await db
    .insert(schema.dimensions)
    .values({ organizationId: orgId, kind: "class", name: "Kitchen job" })
    .returning();
  if (!kitchen) throw new Error("could not create test dimension");
  kitchenId = kitchen.id;
});

afterAll(async () => {
  await db
    .delete(schema.dimensions)
    .where(eq(schema.dimensions.organizationId, orgId));
  await db
    .delete(schema.ledgerSettings)
    .where(eq(schema.ledgerSettings.organizationId, orgId));
  const entries = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));
  const ids = entries.map((e) => e.id);
  if (ids.length > 0) {
    await db
      .delete(schema.journalLines)
      .where(inArray(schema.journalLines.entryId, ids));
    await db
      .delete(schema.journalEntries)
      .where(eq(schema.journalEntries.organizationId, orgId));
  }
  await db
    .delete(schema.accounts)
    .where(eq(schema.accounts.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
});

test("a balanced entry posts its header and lines", async () => {
  const entry = await postJournalEntry(orgId, "payment received", "payment:1", [
    { accountId: cashId, debitCents: 5000 },
    { accountId: arId, creditCents: 5000 },
  ]);
  expect(entry.organizationId).toBe(orgId);

  const lines = await db
    .select()
    .from(schema.journalLines)
    .where(eq(schema.journalLines.entryId, entry.id));
  expect(lines).toHaveLength(2);
  expect(lines.reduce((s, l) => s + l.debitCents, 0)).toBe(5000);
  expect(lines.reduce((s, l) => s + l.creditCents, 0)).toBe(5000);
});

test("an unbalanced entry throws and writes nothing", async () => {
  const before = await db
    .select()
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));

  expect(
    postJournalEntry(orgId, "bad", "manual", [
      { accountId: cashId, debitCents: 5000 },
      { accountId: arId, creditCents: 4999 },
    ]),
  ).rejects.toThrow("Unbalanced entry: debits 5000 != credits 4999");

  const after = await db
    .select()
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));
  expect(after.length).toBe(before.length);
});

test("a multi-line split entry still has to balance", async () => {
  const entry = await postJournalEntry(orgId, "split", "manual", [
    { accountId: cashId, debitCents: 3000 },
    { accountId: cashId, debitCents: 2000 },
    { accountId: arId, creditCents: 5000 },
  ]);
  const lines = await db
    .select()
    .from(schema.journalLines)
    .where(eq(schema.journalLines.entryId, entry.id));
  expect(lines).toHaveLength(3);
});

test("the org's trial balance nets to zero", async () => {
  const rows = await db
    .select({
      debit: schema.journalLines.debitCents,
      credit: schema.journalLines.creditCents,
      entryOrg: schema.journalEntries.organizationId,
    })
    .from(schema.journalLines)
    .innerJoin(
      schema.journalEntries,
      eq(schema.journalLines.entryId, schema.journalEntries.id),
    )
    .where(eq(schema.journalEntries.organizationId, orgId));

  const net = rows.reduce((s, r) => s + r.debit - r.credit, 0);
  expect(net).toBe(0);
});

test("periodFrom — a bare 'to' date is stretched to the end of that day", () => {
  const period = periodFrom((name) =>
    name === "to" ? "2026-06-30" : undefined,
  );
  expect(period.to?.toISOString()).toBe("2026-06-30T23:59:59.999Z");
});

test("periodFrom — a 'from' date is not stretched, and dimension filters travel with the period", () => {
  const period = periodFrom(
    (name) => ({ from: "2026-06-01", classId: "abc" })[name],
  );
  expect(period.from?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  expect(period.classId).toBe("abc");
  expect(period.locationId).toBeUndefined();
});

test("ownedDimension — this business's own class, a stranger's id, and no id at all", async () => {
  expect(await ownedDimension(orgId, "class", kitchenId)).toBe(kitchenId);
  expect(await ownedDimension(orgId, "class", crypto.randomUUID())).toBe(
    "unknown",
  );
  // The right id, the wrong kind: a location asked for what is a class.
  expect(await ownedDimension(orgId, "location", kitchenId)).toBe("unknown");
  expect(await ownedDimension(orgId, "class", undefined)).toBeNull();
});

test("taggingFrom — refused as a pair, not quietly half-accepted", async () => {
  const ok = await taggingFrom(orgId, { classId: kitchenId });
  expect(ok).toEqual({ classId: kitchenId, locationId: null });

  const bad = await taggingFrom(orgId, {
    classId: kitchenId,
    locationId: crypto.randomUUID(),
  });
  expect(bad).toEqual({ error: "that is not a location of yours" });
});

test("accountingValues — only a field somebody defined is kept, coerced to its type", async () => {
  await db
    .insert(schema.ledgerSettings)
    .values({
      organizationId: orgId,
      customFields: [
        {
          id: "litres",
          label: "Litres",
          type: "number",
          appliesTo: "bill",
        },
      ],
    })
    .onConflictDoUpdate({
      target: schema.ledgerSettings.organizationId,
      set: {
        customFields: [
          { id: "litres", label: "Litres", type: "number", appliesTo: "bill" },
        ],
      },
    });

  expect(await accountingFieldsFor(orgId)).toHaveLength(1);

  const values = await accountingValues(orgId, "bill", {
    litres: "42.5",
    something_nobody_defined: "dropped",
  });
  expect(values).toEqual({ litres: 42.5 });

  // A bill's field is not written onto a transaction.
  const onTransaction = await accountingValues(orgId, "transaction", {
    litres: "1",
  });
  expect(onTransaction).toEqual({});
});
