import { afterAll, beforeAll, expect, test } from "bun:test";
import { db, eq, inArray, schema } from "@sentrello/db";
import {
  cashBasisEntries,
  ensureAccount,
  ledgerRows,
  postJournalEntry,
} from "@sentrello/db/ledger";
import {
  cashBasisRows,
  cashBasisRowsFor,
  cashBasisVatRows,
  cashBasisVatRowsFor,
} from "./cash-basis";

/**
 * The bounded read answers what the whole-history read answered.
 *
 * A cash-basis report cannot be a `group by`: what a period recognises
 * depends on every settlement before it, so the conversion walks the ledger
 * in order. What changed is how much of the ledger it walks — only the lines
 * it can read, nothing posted after the period, and before the period only
 * the entries that left a receivable or a payable behind — and the only thing
 * that makes that trade worth making is that the figures do not move.
 *
 * So every test here asks the same question both ways: the old path, which
 * loads the business's entire ledger and converts the array, against the new
 * one, which streams. They must agree row for row, not merely in total.
 *
 * The fixture is built so a lazier bound would be caught. Income is invoiced
 * in one year and received in the next, twice, so a report on the later year
 * is wrong unless the walk carried the earlier year's receivable into it; and
 * there is an unpaid invoice older than every period asked about, which is
 * the opening position a report that started at `from` would lose.
 */

let orgId: string;
/** A second business on the same instance, trading in the same months. */
let otherOrgId: string;
const account: Record<string, string> = {};
const otherAccount: Record<string, string> = {};

const CHART: [string, string, string][] = [
  ["1000", "Cash", "asset"],
  ["1100", "Accounts Receivable", "asset"],
  ["1200", "Inventory", "asset"],
  ["2000", "Accounts Payable", "liability"],
  ["2200", "Tax Payable", "liability"],
  ["4000", "Sales", "income"],
  ["6000", "General Expenses", "expense"],
];

async function makeOrg(label: string): Promise<string> {
  const id = crypto.randomUUID();
  const [org] = await db
    .insert(schema.organizations)
    .values({
      id,
      name: `${label}-${id}`,
      slug: `${label}-${id}`,
      createdAt: new Date(),
    })
    .returning();
  if (!org) throw new Error("could not create test organization");
  return org.id;
}

async function chartFor(
  org: string,
  into: Record<string, string>,
): Promise<void> {
  for (const [code, name, type] of CHART) {
    into[code] = await ensureAccount(org, { code, name, type });
  }
}

const at = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

/** One entry, named by account code so the fixture reads like the books. */
const post = (
  org: string,
  chart: Record<string, string>,
  memo: string,
  when: string,
  lines: [string, number, number][],
) =>
  postJournalEntry(
    org,
    memo,
    "test",
    lines.map(([code, debit, credit]) => {
      const accountId = chart[code];
      if (!accountId) throw new Error(`no account ${code} in the fixture`);
      return { accountId, debitCents: debit, creditCents: credit };
    }),
    at(when),
  );

beforeAll(async () => {
  orgId = await makeOrg("cash-streamed");
  otherOrgId = await makeOrg("cash-streamed-other");
  await chartFor(orgId, account);
  await chartFor(otherOrgId, otherAccount);

  const mine = (
    memo: string,
    when: string,
    lines: [string, number, number][],
  ) => post(orgId, account, memo, when, lines);

  /*
   * 2022: an invoice nobody ever paid. It is older than every period asked
   * about below and it never settles, so it must sit in the pool for the
   * whole run — and a walk that started at the period would have lost it.
   */
  await mine("invoice never paid", "2022-04-05", [
    ["1100", 60_000, 0],
    ["4000", 0, 50_000],
    ["2200", 0, 10_000],
  ]);

  /* 2023: invoiced, and paid in two parts — one that year, one the next. */
  await mine("invoice raised", "2023-11-02", [
    ["1100", 12_000, 0],
    ["4000", 0, 10_000],
    ["2200", 0, 2_000],
  ]);
  await mine("part paid", "2023-12-20", [
    ["1000", 5_000, 0],
    ["1100", 0, 5_000],
  ]);
  await mine("the rest, next year", "2024-02-14", [
    ["1000", 7_000, 0],
    ["1100", 0, 7_000],
  ]);

  /* A supplier bill in one year, settled in the next. */
  await mine("a bill arrives", "2023-12-01", [
    ["6000", 8_000, 0],
    ["2000", 0, 8_000],
  ]);
  await mine("the supplier is paid", "2024-03-09", [
    ["2000", 8_000, 0],
    ["1000", 0, 8_000],
  ]);

  /*
   * Entries that touch neither control account, in every year. These are the
   * ones the bound drops when they fall before the period: the money moved as
   * they were posted, so both bases already agree about them.
   */
  for (const [when, amount] of [
    ["2022-06-01", 1_100],
    ["2023-06-01", 1_300],
    ["2024-06-01", 1_700],
    ["2025-06-01", 1_900],
  ] as [string, number][]) {
    await mine("a counter sale", when, [
      ["1000", amount, 0],
      ["4000", 0, amount],
    ]);
    await mine("what it cost", when, [
      ["6000", Math.round(amount / 2), 0],
      ["1200", 0, Math.round(amount / 2)],
    ]);
  }

  /* An invoice and a credit note against it, the second year. */
  await mine("invoice later credited", "2024-08-01", [
    ["1100", 2_400, 0],
    ["4000", 0, 2_000],
    ["2200", 0, 400],
  ]);
  await mine("credit note", "2024-09-01", [
    ["1100", 0, 2_400],
    ["4000", 2_000, 0],
    ["2200", 400, 0],
  ]);

  /* And one raised in 2024 and received in 2025, so the last year needs it. */
  await mine("invoice raised late", "2024-12-15", [
    ["1100", 18_000, 0],
    ["4000", 0, 15_000],
    ["2200", 0, 3_000],
  ]);
  await mine("received in the new year", "2025-01-20", [
    ["1000", 18_000, 0],
    ["1100", 0, 18_000],
  ]);

  /* The other business, trading in the same months at different figures. */
  await post(otherOrgId, otherAccount, "their invoice", "2024-05-05", [
    ["1100", 777_000, 0],
    ["4000", 0, 777_000],
  ]);
  await post(otherOrgId, otherAccount, "their receipt", "2025-02-02", [
    ["1000", 777_000, 0],
    ["1100", 0, 777_000],
  ]);
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
      .delete(schema.accounts)
      .where(eq(schema.accounts.organizationId, org));
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, org));
  }
});

const year = (y: number) => ({
  from: new Date(Date.UTC(y, 0, 1)),
  to: new Date(Date.UTC(y, 11, 31, 23, 59, 59, 999)),
});

const PERIODS: [string, { from?: Date; to?: Date }][] = [
  ["all time", {}],
  ["2023", year(2023)],
  ["2024", year(2024)],
  ["2025", year(2025)],
  [
    "one month",
    {
      from: new Date(Date.UTC(2024, 1, 1)),
      to: new Date(Date.UTC(2024, 1, 29, 23, 59, 59, 999)),
    },
  ],
  ["as at a date", { to: new Date(Date.UTC(2024, 5, 30, 23, 59, 59, 999)) }],
  ["from a date", { from: new Date(Date.UTC(2024, 5, 1)) }],
];

/** Sorted, so two runs of the same books compare as sets of facts. */
const ordered = <T extends { entryId: string; accountId: string }>(rows: T[]) =>
  [...rows].sort((a, b) =>
    a.entryId === b.entryId
      ? a.accountId.localeCompare(b.accountId)
      : a.entryId.localeCompare(b.entryId),
  );

test("the streamed walk agrees with the whole-history walk, row for row", async () => {
  const all = await ledgerRows(orgId);
  for (const [label, period] of PERIODS) {
    expect({
      label,
      rows: ordered(await cashBasisRowsFor(orgId, period)),
    }).toEqual({
      label,
      rows: ordered(cashBasisRows(all, period)),
    });
  }
});

test("and so does the cash accounting scheme's view of the VAT", async () => {
  const all = await ledgerRows(orgId);
  for (const [label, period] of PERIODS) {
    expect({
      label,
      rows: ordered(await cashBasisVatRowsFor(orgId, period)),
    }).toEqual({ label, rows: ordered(cashBasisVatRows(all, period)) });
  }
});

/**
 * The figures themselves, written down once, because agreeing with the old
 * path would also be agreeing with it if it were wrong.
 *
 * 2024 received 7,000 against an invoice for 12,000 that carried 10,000 of
 * income and 2,000 of tax — so 7,000 of receipt realises its share of the
 * income, not the whole of itself. Plus the counter sale, which is income on
 * both bases the day it happens.
 */
test("income lands in the year the money arrived, not the year it was billed", async () => {
  const income = async (period: { from?: Date; to?: Date }) =>
    (await cashBasisRowsFor(orgId, period))
      .filter((row) => row.type === "income")
      .reduce((total, row) => total + row.amountCents, 0);

  // 2023: 5,000 received of a 12,000 invoice → 5,000 × 10,000 / 12,000, plus
  // the 1,300 counter sale.
  expect(await income(year(2023))).toBe(
    Math.round((10_000 * 5_000) / 12_000) + 1_300,
  );
  // 2024: the remaining 7,000 settles the invoice, so the pool empties — what
  // is left of the 10,000 — plus that year's counter sale. The credit note
  // cancels an invoice nobody paid, so it recognises nothing either way.
  expect(await income(year(2024))).toBe(
    10_000 - Math.round((10_000 * 5_000) / 12_000) + 1_700,
  );
  // 2025: the December invoice is received in January.
  expect(await income(year(2025))).toBe(15_000 + 1_900);
});

test("an expense lands when the supplier was paid", async () => {
  const expense = async (period: { from?: Date; to?: Date }) =>
    (await cashBasisRowsFor(orgId, period))
      .filter((row) => row.type === "expense")
      .reduce((total, row) => total + row.amountCents, 0);

  // The bill arrived in 2023 and was paid in March 2024. 2023 sees only the
  // cost of its own counter sale.
  expect(await expense(year(2023))).toBe(650);
  expect(await expense(year(2024))).toBe(8_000 + 850);
});

/**
 * The bound, asserted directly rather than inferred from a timing.
 *
 * A report on 2025 has to read 2025, and before it only the entries that left
 * a receivable or a payable behind. The counter sales of 2022, 2023 and 2024
 * recognised their money the day they were posted and can contribute nothing
 * to a later period, so they are not read at all — which is the whole of why
 * this stopped getting slower every year the business trades.
 */
test("a period reads its own entries and the opening position, and nothing else", async () => {
  const memos = new Map<string, string>();
  const rows = await db
    .select({ id: schema.journalEntries.id, memo: schema.journalEntries.memo })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));
  for (const row of rows) memos.set(row.id, row.memo ?? "");

  const seen: string[] = [];
  for await (const entry of cashBasisEntries(orgId, year(2025))) {
    seen.push(memos.get(entry.id) ?? "?");
  }

  // Everything unsettled, and everything that happened in 2025.
  expect(seen.filter((m) => m === "invoice never paid")).toHaveLength(1);
  expect(seen.filter((m) => m === "invoice raised late")).toHaveLength(1);
  expect(seen.filter((m) => m === "received in the new year")).toHaveLength(1);
  // And none of the eight entries that moved money with no control account
  // in them, of which six are before the period.
  expect(seen.filter((m) => m === "a counter sale")).toHaveLength(1);
  expect(seen.filter((m) => m === "what it cost")).toHaveLength(1);
  expect(rows.length).toBeGreaterThan(seen.length);
});

test("a profit and loss does not read the tax lines at all", async () => {
  const codes = async (tax: boolean) => {
    const found = new Set<string>();
    for await (const entry of cashBasisEntries(orgId, {}, { tax })) {
      for (const row of entry.rows) found.add(row.code);
    }
    return found;
  };
  // The bank and the stock account are never read either way: neither is
  // pooled, recognised or named in anything this produces.
  expect([...(await codes(false))].sort()).toEqual([
    "1100",
    "2000",
    "4000",
    "6000",
  ]);
  expect([...(await codes(true))].sort()).toEqual([
    "1100",
    "2000",
    "2200",
    "4000",
    "6000",
  ]);
});

test("another business's trading is never in these figures", async () => {
  const mine = await cashBasisRowsFor(orgId, {});
  expect(mine.some((row) => row.amountCents === 777_000)).toBe(false);
  expect(mine.some((row) => row.accountId === otherAccount["4000"])).toBe(
    false,
  );

  const theirs = await cashBasisRowsFor(otherOrgId, {});
  expect(theirs.map((row) => row.amountCents)).toEqual([777_000]);
});

/**
 * The one row that tells the two organization filters apart.
 *
 * The read scopes on both sides — the entry's organization and the account's
 * — and with well-formed books either alone looks sufficient, because a
 * business's entries only ever name its own accounts. So this writes the row
 * a bug would write: a balanced entry belonging to the second business with
 * one line pointing at the first business's sales account. Remove either
 * filter and one of these two assertions fails.
 */
test("a line crossing between businesses appears in neither's figures", async () => {
  const sales = account["4000"];
  const theirCash = otherAccount["1000"];
  if (!sales || !theirCash) throw new Error("the fixture is incomplete");

  const before = await cashBasisRowsFor(orgId, {});
  const [entry] = await db
    .insert(schema.journalEntries)
    .values({
      organizationId: otherOrgId,
      memo: "a line that names the wrong business's account",
      source: "test",
      postedAt: at("2024-07-07"),
    })
    .returning();
  if (!entry) throw new Error("could not create the crossing entry");
  await db.insert(schema.journalLines).values([
    { entryId: entry.id, accountId: theirCash, debitCents: 31_000 },
    // The other business's account — this is the leak, written on purpose.
    { entryId: entry.id, accountId: sales, creditCents: 31_000 },
  ]);
  try {
    expect(ordered(await cashBasisRowsFor(orgId, {}))).toEqual(ordered(before));
    const theirs = await cashBasisRowsFor(otherOrgId, {});
    expect(theirs.some((row) => row.accountId === sales)).toBe(false);
    expect(theirs.some((row) => row.amountCents === 31_000)).toBe(false);
  } finally {
    await db
      .delete(schema.journalLines)
      .where(eq(schema.journalLines.entryId, entry.id));
    await db
      .delete(schema.journalEntries)
      .where(eq(schema.journalEntries.id, entry.id));
  }
});
