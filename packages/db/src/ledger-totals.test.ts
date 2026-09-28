import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "./index";
import {
  type LedgerAmounts,
  ledgerRows,
  ledgerTotals,
  postJournalEntry,
  totalsByAccount,
} from "./ledger";

/**
 * The aggregate agrees with the ledger, or it is worse than the slow report.
 *
 * `ledgerTotals` exists to stop a report shipping a million lines into
 * JavaScript to add them up. The only thing that makes that trade worth making
 * is that the answer does not move: every test here asks the same question
 * both ways — the rows, added up in the application, against the database's
 * own `group by` — and demands they agree to the cent.
 *
 * The comparison is deliberately against `ledgerRows` and `totalsByAccount`
 * rather than against numbers written down here. Figures typed into a test are
 * a second opinion about what the books say; the ledger is the first one, and
 * these reports have no business disagreeing with it.
 */

let orgId: string;
/** A second business on the same instance, with books of its own. */
let otherOrgId: string;
let cashId: string;
let salesId: string;
let rentId: string;
let otherCashId: string;
let otherSalesId: string;
let kitchenId: string;
/** The first business's own figures, before anything hostile is written. */
let balancesBefore: Record<string, number>;

const JANUARY = {
  from: new Date(Date.UTC(2024, 0, 1)),
  to: new Date(Date.UTC(2024, 0, 31, 23, 59, 59, 999)),
};
const YEAR = {
  from: new Date(Date.UTC(2024, 0, 1)),
  to: new Date(Date.UTC(2024, 11, 31, 23, 59, 59, 999)),
};

async function makeOrg(label: string): Promise<string> {
  const suffix = crypto.randomUUID();
  const [org] = await db
    .insert(schema.organizations)
    .values({
      id: suffix,
      name: `${label}-${suffix}`,
      slug: `${label}-${suffix}`,
      createdAt: new Date(),
    })
    .returning();
  if (!org) throw new Error("could not create test organization");
  return org.id;
}

async function makeAccount(
  org: string,
  code: string,
  name: string,
  type: string,
): Promise<string> {
  const [row] = await db
    .insert(schema.accounts)
    .values({ organizationId: org, code, name, type })
    .returning();
  if (!row) throw new Error("could not create test account");
  return row.id;
}

beforeAll(async () => {
  orgId = await makeOrg("totals-test");
  otherOrgId = await makeOrg("totals-other");

  cashId = await makeAccount(orgId, "1000", "Cash", "asset");
  salesId = await makeAccount(orgId, "4000", "Sales", "income");
  rentId = await makeAccount(orgId, "6000", "Rent", "expense");
  otherCashId = await makeAccount(otherOrgId, "1000", "Cash", "asset");
  otherSalesId = await makeAccount(otherOrgId, "4000", "Sales", "income");

  const [kitchen] = await db
    .insert(schema.dimensions)
    .values({ organizationId: orgId, kind: "class", name: "Kitchen job" })
    .returning();
  if (!kitchen) throw new Error("could not create test dimension");
  kitchenId = kitchen.id;

  /**
   * Twelve months of trading, so a period is a narrowing rather than the whole
   * thing, and every account is touched in more than one month. A fixture with
   * one entry per account cannot tell a correct `group by` from a broken one.
   */
  for (let month = 0; month < 12; month += 1) {
    const at = new Date(Date.UTC(2024, month, 15, 12, 0, 0));
    await postJournalEntry(
      orgId,
      `sale in month ${month}`,
      "test",
      [
        { accountId: cashId, debitCents: 1_000 + month * 37 },
        { accountId: salesId, creditCents: 1_000 + month * 37 },
      ],
      at,
    );
    await postJournalEntry(
      orgId,
      `rent in month ${month}`,
      "test",
      [
        { accountId: rentId, debitCents: 400 + month, classId: kitchenId },
        { accountId: cashId, creditCents: 400 + month, classId: kitchenId },
      ],
      at,
    );
  }
  // A second sale in January, so one month holds more than one entry.
  await postJournalEntry(
    orgId,
    "second January sale",
    "test",
    [
      { accountId: cashId, debitCents: 2_500 },
      { accountId: salesId, creditCents: 2_500 },
    ],
    new Date(Date.UTC(2024, 0, 20, 9, 0, 0)),
  );
  // Outside the year, so a period that excludes it has something to exclude.
  await postJournalEntry(
    orgId,
    "a sale the year before",
    "test",
    [
      { accountId: cashId, debitCents: 9_100 },
      { accountId: salesId, creditCents: 9_100 },
    ],
    new Date(Date.UTC(2023, 5, 1, 9, 0, 0)),
  );

  await postJournalEntry(
    otherOrgId,
    "somebody else's sale",
    "test",
    [
      { accountId: otherCashId, debitCents: 777_000 },
      { accountId: otherSalesId, creditCents: 777_000 },
    ],
    new Date(Date.UTC(2024, 2, 3, 9, 0, 0)),
  );

  balancesBefore = balances(await ledgerTotals(orgId, {}));
});

afterAll(async () => {
  for (const org of [orgId, otherOrgId]) {
    const entries = await db
      .select({ id: schema.journalEntries.id })
      .from(schema.journalEntries)
      .where(eq(schema.journalEntries.organizationId, org));
    const ids = entries.map((e) => e.id);
    if (ids.length > 0) {
      await db
        .delete(schema.journalLines)
        .where(inArray(schema.journalLines.entryId, ids));
      await db
        .delete(schema.journalEntries)
        .where(eq(schema.journalEntries.organizationId, org));
    }
    await db
      .delete(schema.dimensions)
      .where(eq(schema.dimensions.organizationId, org));
    await db
      .delete(schema.accounts)
      .where(eq(schema.accounts.organizationId, org));
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, org));
  }
});

/** Per-account, debits positive — the trial balance, keyed for comparison. */
function balances(rows: LedgerAmounts[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const row of rows) {
    totals[row.accountId] =
      (totals[row.accountId] ?? 0) + row.debitCents - row.creditCents;
  }
  return totals;
}

/**
 * Built inside each test, not at module load: `kitchenId` is assigned in
 * `beforeAll`, and a table captured earlier would hold undefined.
 */
const windows = (): [string, Parameters<typeof ledgerTotals>[1]][] => [
  ["all time", {}],
  ["one year", YEAR],
  ["one month", JANUARY],
  ["one class", { ...YEAR, classId: kitchenId }],
];

test("ledgerTotals agrees with the ledger to the cent", async () => {
  for (const [label, window] of windows()) {
    const rows = await ledgerRows(orgId, window);
    const totals = await ledgerTotals(orgId, window);

    expect({ label, ...balances(totals) }).toEqual({
      label,
      ...balances(rows),
    });
    // Every account the rows mention, and no account they do not.
    expect(totals).toHaveLength(Object.keys(balances(rows)).length);
    for (const type of ["asset", "income", "expense", "liability", "equity"]) {
      expect(totalsByAccount(totals, type)).toEqual(
        totalsByAccount(rows, type),
      );
    }
  }
});

test("the aggregate still balances — debits equal credits", async () => {
  for (const window of [{}, YEAR, JANUARY]) {
    const totals = await ledgerTotals(orgId, window);
    const debits = totals.reduce((sum, a) => sum + a.debitCents, 0);
    const credits = totals.reduce((sum, a) => sum + a.creditCents, 0);
    expect(debits).toBe(credits);
    expect(debits).toBeGreaterThan(0);
  }
});

test("a period narrows: January is not the year, and the year is not all time", async () => {
  const january = balances(await ledgerTotals(orgId, JANUARY));
  const year = balances(await ledgerTotals(orgId, YEAR));
  const everything = balances(await ledgerTotals(orgId, {}));
  expect(january[salesId]).not.toBe(year[salesId]);
  expect(year[salesId]).not.toBe(everything[salesId]);
  // The 9,100 posted in 2023 is the whole of the difference.
  expect(everything[salesId]).toBe((year[salesId] as number) - 9_100);
});

test("another business's entries are never in these totals", async () => {
  const mine = await ledgerTotals(orgId, {});
  expect(mine.some((a) => a.accountId === otherSalesId)).toBe(false);
  expect(mine.some((a) => a.creditCents === 777_000)).toBe(false);

  const theirs = await ledgerTotals(otherOrgId, {});
  expect(balances(theirs)).toEqual({
    [otherCashId]: 777_000,
    [otherSalesId]: -777_000,
  });
});

/**
 * The one row that tells the two org filters apart.
 *
 * `ledgerTotals` scopes on both sides — the entry's organization and the
 * account's — and with well-formed books either alone would appear to be
 * enough, because a business's entries only ever name its own accounts. So
 * this writes the row a bug would write: one balanced entry belonging to the
 * second business, with one of its lines pointing at the first business's
 * sales account. Drop either filter and one of these two assertions fails.
 */
test("a line crossing between businesses appears in neither's totals", async () => {
  const [entry] = await db
    .insert(schema.journalEntries)
    .values({
      organizationId: otherOrgId,
      memo: "a line that names the wrong business's account",
      source: "test",
      postedAt: new Date(Date.UTC(2024, 5, 5)),
    })
    .returning();
  if (!entry) throw new Error("could not create the crossing entry");
  await db.insert(schema.journalLines).values([
    { entryId: entry.id, accountId: otherCashId, debitCents: 31_000 },
    // The other business's account — this is the leak, written on purpose.
    { entryId: entry.id, accountId: salesId, creditCents: 31_000 },
  ]);
  try {
    const mine = balances(await ledgerTotals(orgId, {}));
    const theirs = balances(await ledgerTotals(otherOrgId, {}));
    expect(mine[salesId]).toBe(balancesBefore[salesId] as number);
    expect(theirs[salesId]).toBeUndefined();
    // Its own side of the entry still counts — only the crossing line is cut.
    expect(theirs[otherCashId]).toBe(777_000 + 31_000);
  } finally {
    await db
      .delete(schema.journalLines)
      .where(eq(schema.journalLines.entryId, entry.id));
    await db
      .delete(schema.journalEntries)
      .where(eq(schema.journalEntries.id, entry.id));
  }
});

test("a total past 2^31 cents is counted, not refused by a 32-bit cast", async () => {
  const big = await makeOrg("totals-big");
  const bank = await makeAccount(big, "1000", "Cash", "asset");
  const income = await makeAccount(big, "4000", "Sales", "income");
  try {
    // $21.5m is where `sum(...)::int` stops answering. Three of these is $60m,
    // which is a fifth year of trading, not a fantasy.
    for (let i = 0; i < 3; i += 1) {
      await postJournalEntry(
        big,
        `a large sale ${i}`,
        "test",
        [
          { accountId: bank, debitCents: 2_000_000_000 },
          { accountId: income, creditCents: 2_000_000_000 },
        ],
        new Date(Date.UTC(2024, i, 1)),
      );
    }
    const totals = await ledgerTotals(big, {});
    const cash = totals.find((a) => a.accountId === bank);
    expect(cash?.debitCents).toBe(6_000_000_000);
    expect(typeof cash?.debitCents).toBe("number");
  } finally {
    const entries = await db
      .select({ id: schema.journalEntries.id })
      .from(schema.journalEntries)
      .where(eq(schema.journalEntries.organizationId, big));
    const ids = entries.map((e) => e.id);
    if (ids.length > 0) {
      await db
        .delete(schema.journalLines)
        .where(inArray(schema.journalLines.entryId, ids));
      await db
        .delete(schema.journalEntries)
        .where(eq(schema.journalEntries.organizationId, big));
    }
    await db
      .delete(schema.accounts)
      .where(eq(schema.accounts.organizationId, big));
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, big));
  }
});
