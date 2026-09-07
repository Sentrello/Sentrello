import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "./index";
import { postJournalEntry } from "./ledger";

let orgId: string;
let cashId: string;
let arId: string;

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
});

afterAll(async () => {
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
