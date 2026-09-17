import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "./index";
import {
  type LedgerRow,
  accountingFieldsFor,
  accountingValues,
  ledgerRows,
  ownedAccount,
  ownedDimension,
  periodFrom,
  postJournalEntry,
  taggingFrom,
  totalsByAccount,
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

test("ownedAccount — true for this business's account, false for a stranger's id", async () => {
  expect(await ownedAccount(orgId, cashId)).toBe(true);
  expect(await ownedAccount(orgId, crypto.randomUUID())).toBe(false);
  expect(await ownedAccount(orgId, "not-a-uuid")).toBe(false);
});

test("ledgerRows — reads back what postJournalEntry wrote, scoped to the org", async () => {
  const incomeId = await db
    .insert(schema.accounts)
    .values({
      organizationId: orgId,
      code: "4000",
      name: "Sales",
      type: "income",
    })
    .returning()
    .then(([row]) => {
      if (!row) throw new Error("could not create income account");
      return row.id;
    });
  await postJournalEntry(
    orgId,
    "ledgerRows test sale",
    "test",
    [
      { accountId: cashId, debitCents: 500 },
      { accountId: incomeId, creditCents: 500 },
    ],
    new Date("2026-02-01T00:00:00Z"),
  );
  const rows = await ledgerRows(orgId);
  expect(rows.some((r) => r.code === "4000" && r.creditCents === 500)).toBe(
    true,
  );
});

function row(
  over: Partial<LedgerRow> & { code: string; type: string },
): LedgerRow {
  return {
    entryId: over.entryId ?? "entry-1",
    classId: over.classId ?? null,
    locationId: over.locationId ?? null,
    accountId: over.accountId ?? `acct-${over.code}`,
    name: over.name ?? `Account ${over.code}`,
    debitCents: 0,
    creditCents: 0,
    postedAt: over.postedAt ?? new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

test("totalsByAccount — an expense account reads its debits as positive", () => {
  const totals = totalsByAccount(
    [row({ code: "5000", type: "expense", debitCents: 1_000 })],
    "expense",
  );
  expect(totals).toEqual([
    {
      accountId: "acct-5000",
      code: "5000",
      name: "Account 5000",
      balanceCents: 1_000,
    },
  ]);
});

/**
 * The row recording a financial event and the entry posting it live or die
 * together — in that direction too.
 *
 * `recordCreditMovement`'s tests prove the row-then-post half: a posting
 * refused by the closed books does not leave the row behind. This is the other
 * half, and the shape an audit of nineteen posting sites found eight times:
 * post first, write the row second, and nothing at all if the row fails. A
 * spend posted to the profit and loss with no cost row behind it is money
 * leaving the books that no screen can explain, and it is unfindable — the
 * entry looks perfectly ordinary.
 *
 * No new seam: `postJournalEntry` already takes the caller's transaction. This
 * is here so a caller can be pointed at a test rather than at an argument.
 */
test("an entry posted in a caller's transaction dies with the row it explains", async () => {
  const before = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.source, "cost-row-test"));

  await expect(
    db.transaction(async (tx) => {
      await postJournalEntry(
        orgId,
        "A day of scaffold",
        "cost-row-test",
        [
          { accountId: cashId, creditCents: 4_000 },
          { accountId: arId, debitCents: 4_000 },
        ],
        new Date("2024-03-04T12:00:00.000Z"),
        { tx },
      );
      // The row the entry exists to explain, rejected by the database — a
      // missing column here stands in for every way an insert fails.
      await tx
        .insert(schema.transactions)
        .values({ organizationId: orgId } as never);
    }),
  ).rejects.toThrow();

  const after = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.source, "cost-row-test"));
  expect(after.length).toBe(before.length);
});
