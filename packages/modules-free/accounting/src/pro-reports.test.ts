import { expect, test } from "bun:test";
import { ageBucket, cashFlow, taxSummary, toCsv } from "./pro-reports";
import type { LedgerRow } from "./reports";
import { totalsByAccount } from "./reports";

/**
 * The arithmetic behind the reports, which nothing checked.
 *
 * Four of the seven Pro reports had no screen until 2026-09-05, and the suite
 * covering them asserted one thing: that they answer 404 on a Free instance.
 * Their numbers had never been tested at all — including the tax summary,
 * which is what a return is filed from. Putting a screen on a figure nobody
 * has checked is how a business files a wrong return and believes the
 * software.
 *
 * These run against rows rather than the database because that is where the
 * arithmetic lives; `pro.test.ts` already proves the routes reach it.
 */

let seq = 0;
function row(
  over: Partial<LedgerRow> & { code: string; type: string },
): LedgerRow {
  seq += 1;
  return {
    // One line per entry unless a test says otherwise, which is what these
    // report figures assume: they add lines up, they do not pair them.
    entryId: over.entryId ?? `entry-${seq}`,
    // No class and no location unless a test says otherwise: most lines belong
    // to the business as a whole.
    classId: over.classId ?? null,
    locationId: over.locationId ?? null,
    accountId: over.accountId ?? `acct-${over.code}`,
    name: over.name ?? `Account ${over.code}`,
    debitCents: 0,
    creditCents: 0,
    postedAt: new Date(`2026-0${(seq % 9) + 1}-01T00:00:00Z`),
    ...over,
  };
}

/** Tax charged on a sale is a credit on 2200; reclaimed or paid over is a debit. */
test("what is owed is what was charged less what was reclaimed", () => {
  const summary = taxSummary([
    row({ code: "2200", type: "liability", creditCents: 2_000 }),
    row({ code: "2200", type: "liability", creditCents: 500 }),
    row({ code: "2200", type: "liability", debitCents: 300 }),
    // Everything else on the books is none of this report's business.
    row({ code: "4000", type: "income", creditCents: 10_000 }),
    row({ code: "1000", type: "asset", debitCents: 10_000 }),
  ]);
  expect(summary.chargedCents).toBe(2_500);
  expect(summary.reclaimedCents).toBe(300);
  expect(summary.dueCents).toBe(2_200);
});

/**
 * A liability account that is not the tax account must not be counted.
 *
 * The filter is on code as well as type, and a business with a loan or a
 * supplier balance has other liabilities. Counting one of them would put a
 * figure on a tax return that has nothing to do with tax.
 */
test("another liability is not tax", () => {
  const summary = taxSummary([
    row({ code: "2100", type: "liability", creditCents: 50_000 }),
    row({ code: "2200", type: "liability", creditCents: 1_000 }),
  ]);
  expect(summary.chargedCents).toBe(1_000);
  expect(summary.dueCents).toBe(1_000);
});

test("no tax at all is nought owed, not an empty report", () => {
  const summary = taxSummary([
    row({ code: "4000", type: "income", creditCents: 1 }),
  ]);
  expect(summary).toEqual({
    chargedCents: 0,
    reclaimedCents: 0,
    dueCents: 0,
  });
});

/** More reclaimed than charged is a refund due, and must not clamp to nought. */
test("reclaiming more than was charged is owed the other way", () => {
  const summary = taxSummary([
    row({ code: "2200", type: "liability", creditCents: 1_000 }),
    row({ code: "2200", type: "liability", debitCents: 4_000 }),
  ]);
  expect(summary.dueCents).toBe(-3_000);
});

/**
 * Cash flow reads the accounts money sits in, not profit.
 *
 * A profitable month with every invoice unpaid has no cash in it, which is the
 * whole reason this report exists beside the profit and loss.
 */
test("cash flow counts cash and bank accounts and nothing else", () => {
  const flow = cashFlow([
    row({ code: "1000", type: "asset", debitCents: 5_000 }),
    row({ code: "1010", type: "asset", debitCents: 2_000 }),
    // Matched by name rather than code: a business adds its own bank accounts.
    row({
      code: "1050",
      type: "asset",
      name: "Barclays Bank",
      debitCents: 1_000,
    }),
    row({ code: "1000", type: "asset", creditCents: 3_000 }),
    // Receivables are not cash. Counting them is the mistake this report
    // exists to avoid.
    row({ code: "1100", type: "asset", debitCents: 90_000 }),
  ]);
  expect(flow.inCents).toBe(8_000);
  expect(flow.outCents).toBe(3_000);
  expect(flow.netCents).toBe(5_000);
});

test("an age bucket puts a bill where a person would put it", () => {
  expect(ageBucket(0)).toBe("current");
  expect(ageBucket(-5)).toBe("current");
  expect(ageBucket(1)).toBe("days30");
  expect(ageBucket(30)).toBe("days30");
  expect(ageBucket(31)).toBe("days60");
  expect(ageBucket(60)).toBe("days60");
  expect(ageBucket(61)).toBe("days90plus");
});

/**
 * The export an accountant opens in a spreadsheet.
 *
 * A description carrying a comma or a quote is the ordinary case, not the
 * exotic one — "Repairs, parts" would silently become two columns and every
 * figure after it would land in the wrong one.
 */
test("a field with a comma or a quote survives the spreadsheet", () => {
  const csv = toCsv([
    ["memo", "amount"],
    ["Repairs, parts", 1_000],
    ['He said "urgent"', 2_000],
    [null, 0],
  ]);
  const lines = csv.trim().split("\n");
  expect(lines[1]).toContain('"Repairs, parts"');
  expect(lines[2]).toContain('""urgent""');
  expect(lines).toHaveLength(4);
});

/**
 * Where the money goes, by category.
 *
 * The report a business plans from — "what do we spend on software" is not
 * answerable from a total — and the sign convention is the whole of it. An
 * expense is a debit and income is a credit, so counting both the same way
 * would report every expense as negative and every refund as spending.
 */
test("income and expenses are each counted the way their side runs", () => {
  const rows = [
    row({ code: "4000", type: "income", name: "Sales", creditCents: 10_000 }),
    // A refund against sales: income going the other way.
    row({ code: "4000", type: "income", name: "Sales", debitCents: 1_500 }),
    row({ code: "5000", type: "expense", name: "Software", debitCents: 4_000 }),
    // A credit note from a supplier: an expense going the other way.
    row({ code: "5000", type: "expense", name: "Software", creditCents: 500 }),
    row({ code: "5100", type: "expense", name: "Rent", debitCents: 20_000 }),
  ];

  const income = totalsByAccount(rows, "income");
  expect(income).toHaveLength(1);
  expect(income[0]?.balanceCents).toBe(8_500);

  const expenses = totalsByAccount(rows, "expense");
  expect(expenses.map((e) => e.name).sort()).toEqual(["Rent", "Software"]);
  expect(expenses.find((e) => e.name === "Software")?.balanceCents).toBe(3_500);
  expect(expenses.find((e) => e.name === "Rent")?.balanceCents).toBe(20_000);
});

test("an account with nothing on it is not a category", () => {
  expect(
    totalsByAccount(
      [row({ code: "1000", type: "asset", debitCents: 5 })],
      "expense",
    ),
  ).toEqual([]);
});
