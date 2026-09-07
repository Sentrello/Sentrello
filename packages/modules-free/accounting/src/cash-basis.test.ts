import { expect, test } from "bun:test";
import { cashBasisRows } from "./cash-basis";
import type { LedgerRow } from "./reports";

/**
 * The difference between the two bases, which is a difference of timing.
 *
 * An invoice raised in March and paid in May is March's income on the accrual
 * basis and May's on the cash basis. Both are correct answers to different
 * questions, and a business filing on the cash basis needs the second one —
 * so what is tested here is not "does it add up" but "does it land in the
 * right month".
 *
 * These run against rows rather than the database, because that is where the
 * arithmetic is; `pro.test.ts` proves the route reaches it.
 */

let seq = 0;

/** One entry, with its lines. */
function entry(
  postedAt: string,
  lines: {
    code: string;
    type: string;
    debit?: number;
    credit?: number;
    name?: string;
  }[],
): LedgerRow[] {
  seq += 1;
  const entryId = `entry-${seq}`;
  return lines.map((line) => ({
    entryId,
    classId: null,
    locationId: null,
    accountId: `acct-${line.code}`,
    code: line.code,
    name: line.name ?? `Account ${line.code}`,
    type: line.type,
    debitCents: line.debit ?? 0,
    creditCents: line.credit ?? 0,
    postedAt: new Date(postedAt),
  }));
}

/** An invoice for 1200: 1000 of income and 200 of tax collected for the state. */
const invoice = (at: string, income = 1_000, tax = 200) =>
  entry(at, [
    { code: "1100", type: "asset", debit: income + tax },
    { code: "4000", type: "income", credit: income },
    { code: "2200", type: "liability", credit: tax },
  ]);

/** Money in against that receivable. */
const receipt = (at: string, amount: number) =>
  entry(at, [
    { code: "1000", type: "asset", debit: amount },
    { code: "1100", type: "asset", credit: amount },
  ]);

const totalOf = (rows: ReturnType<typeof cashBasisRows>, type: string) =>
  rows
    .filter((row) => row.type === type)
    .reduce((n, r) => n + r.amountCents, 0);

test("an invoice nobody has paid is not income yet", () => {
  const rows = cashBasisRows([...invoice("2026-03-10T00:00:00Z")]);
  expect(totalOf(rows, "income")).toBe(0);
});

/**
 * The whole point, in one test.
 *
 * March raised it and May was paid for it. A report for March on this basis
 * shows nothing, and a report for May shows the lot — which is the opposite of
 * what the accrual report says about the same two months, and is what the
 * return is filed from.
 */
test("income lands in the month the money arrived, not the month it was earned", () => {
  const all = [
    ...invoice("2026-03-10T00:00:00Z"),
    ...receipt("2026-05-02T00:00:00Z", 1_200),
  ];

  const march = cashBasisRows(all, {
    from: new Date("2026-03-01T00:00:00Z"),
    to: new Date("2026-03-31T23:59:59Z"),
  });
  expect(totalOf(march, "income")).toBe(0);

  const may = cashBasisRows(all, {
    from: new Date("2026-05-01T00:00:00Z"),
    to: new Date("2026-05-31T23:59:59Z"),
  });
  // The income, and not the tax collected on top of it.
  expect(totalOf(may, "income")).toBe(1_000);
});

/**
 * The tax is not income and never becomes it.
 *
 * A receipt of 1200 against an invoice of 1000 plus 200 of tax recognises
 * 1000. Recognising the whole receipt would overstate a business's income by
 * its own tax rate on every cash-basis return it ever files.
 */
test("a receipt recognises the income on it, never the tax with it", () => {
  const rows = cashBasisRows([
    ...invoice("2026-03-10T00:00:00Z"),
    ...receipt("2026-03-20T00:00:00Z", 1_200),
  ]);
  expect(totalOf(rows, "income")).toBe(1_000);
});

test("a part payment recognises its share, and the rest when it follows", () => {
  const all = [
    ...invoice("2026-03-10T00:00:00Z"),
    ...receipt("2026-03-20T00:00:00Z", 600),
    ...receipt("2026-06-01T00:00:00Z", 600),
  ];
  const first = cashBasisRows(all, {
    to: new Date("2026-03-31T23:59:59Z"),
  });
  expect(totalOf(first, "income")).toBe(500);

  // And nothing is lost or invented between the two halves.
  expect(totalOf(cashBasisRows(all), "income")).toBe(1_000);
});

/**
 * Nothing may be stranded in the pool.
 *
 * Rounding a share down and dropping the fraction leaves income permanently
 * held back — a business whose cash-basis income is a few pennies short of
 * what it banked, every year, with nothing to point at. Swept across amounts
 * that do not divide.
 */
test("a fully paid invoice always recognises exactly its income", () => {
  for (const income of [999, 1_001, 7, 33_333, 1]) {
    for (const tax of [0, 1, 175, 2_000]) {
      for (const parts of [1, 2, 3, 7]) {
        const total = income + tax;
        /**
         * Across two income accounts that do not divide evenly.
         *
         * With one account every share is the whole of the amount and the
         * rounding never has anything to do. Two, split by a third, is where
         * flooring each share loses a penny a payment and strands income in
         * the pool forever.
         */
        const firstShare = Math.floor(income / 3);
        const rows = entry("2026-03-10T00:00:00Z", [
          { code: "1100", type: "asset", debit: total },
          { code: "4000", type: "income", credit: firstShare },
          { code: "4200", type: "income", credit: income - firstShare },
          ...(tax > 0
            ? [{ code: "2200", type: "liability", credit: tax }]
            : []),
        ]);
        let paid = 0;
        for (let i = 0; i < parts; i += 1) {
          const last = i === parts - 1;
          const amount = last ? total - paid : Math.floor(total / parts);
          paid += amount;
          rows.push(...receipt(`2026-0${4 + i}-01T00:00:00Z`, amount));
        }
        expect(totalOf(cashBasisRows(rows), "income")).toBe(income);
      }
    }
  }
});

/**
 * A part payment hands over exactly what it settled, to the penny.
 *
 * Split across accounts that do not divide, rounding each share down loses a
 * penny on every payment. The end of the invoice recovers it — the last
 * settlement takes whatever is left in the pool — so the loss is invisible in
 * any test that pays an invoice off, and shows up only as a month's figure
 * that is a few pennies light. Which is a month's figure that is wrong.
 */
test("a part payment recognises the whole of its share, to the penny", () => {
  const raised = entry("2026-03-10T00:00:00Z", [
    { code: "1100", type: "asset", debit: 1_000 },
    { code: "4000", type: "income", credit: 333 },
    { code: "4200", type: "income", credit: 667 },
  ]);
  const rows = cashBasisRows([
    ...raised,
    ...receipt("2026-03-20T00:00:00Z", 500),
  ]);
  expect(totalOf(rows, "income")).toBe(500);
});

/**
 * Two income accounts on one invoice come back in proportion.
 *
 * A part payment of half an invoice is half of each thing on it, not all of
 * the first line — which would put a business's product income and service
 * income in the wrong months on the only report it files from.
 */
test("a part payment is spread across what the invoice was made of", () => {
  const raised = entry("2026-03-10T00:00:00Z", [
    { code: "1100", type: "asset", debit: 1_000 },
    { code: "4000", type: "income", credit: 750, name: "Services" },
    { code: "4200", type: "income", credit: 250, name: "Products" },
  ]);
  const rows = cashBasisRows([
    ...raised,
    ...receipt("2026-03-20T00:00:00Z", 400),
  ]);
  const byName = new Map(rows.map((row) => [row.name, row.amountCents]));
  expect(byName.get("Services")).toBe(300);
  expect(byName.get("Products")).toBe(100);
});

/**
 * A bill is the same shape, the other way round.
 *
 * An expense incurred in March and paid in May is May's on this basis, and a
 * business that only ever converts the income half files a return showing what
 * it took and not what it spent.
 */
test("an expense lands in the month it was paid", () => {
  const bill = entry("2026-03-05T00:00:00Z", [
    { code: "6000", type: "expense", debit: 500 },
    { code: "2000", type: "liability", credit: 500 },
  ]);
  const paid = entry("2026-05-05T00:00:00Z", [
    { code: "2000", type: "liability", debit: 500 },
    { code: "1000", type: "asset", credit: 500 },
  ]);
  const all = [...bill, ...paid];

  expect(
    totalOf(
      cashBasisRows(all, { to: new Date("2026-03-31T23:59:59Z") }),
      "expense",
    ),
  ).toBe(0);
  expect(
    totalOf(
      cashBasisRows(all, {
        from: new Date("2026-05-01T00:00:00Z"),
        to: new Date("2026-05-31T23:59:59Z"),
      }),
      "expense",
    ),
  ).toBe(500);
});

/**
 * Money that moved when it was posted counts on its own date.
 *
 * A card sale, a bank fee, a statement line a rule categorised: no receivable
 * was ever involved, so both bases agree and there is nothing to defer.
 */
test("a cash sale and a cash expense count immediately", () => {
  const sale = entry("2026-04-01T00:00:00Z", [
    { code: "1000", type: "asset", debit: 900 },
    { code: "4000", type: "income", credit: 900 },
  ]);
  const fee = entry("2026-04-02T00:00:00Z", [
    { code: "6850", type: "expense", debit: 30 },
    { code: "1000", type: "asset", credit: 30 },
  ]);
  const rows = cashBasisRows([...sale, ...fee]);
  expect(totalOf(rows, "income")).toBe(900);
  expect(totalOf(rows, "expense")).toBe(30);
});

/**
 * Depreciation stays, on purpose.
 *
 * It is an expense with no cash behind it, and every regime this is sold into
 * allows it on a cash-basis return. Leaving it out because no money moved
 * would understate the expenses of any business that owns a van.
 */
test("depreciation counts, though no money moved", () => {
  const rows = cashBasisRows(
    entry("2026-04-30T23:59:59Z", [
      { code: "6500", type: "expense", debit: 250 },
      { code: "1590", type: "asset", credit: 250 },
    ]),
  );
  expect(totalOf(rows, "expense")).toBe(250);
});

/**
 * A write-off is recognised, and is why this follows the receivable.
 *
 * The debt goes away without money arriving. Something has to happen to the
 * income sitting against it, or it stays in the pool forever and every later
 * payment recognises somebody else's invoice.
 */
test("a receivable written off does not stay in the pool", () => {
  const written = entry("2026-06-01T00:00:00Z", [
    { code: "6900", type: "expense", debit: 1_200 },
    { code: "1100", type: "asset", credit: 1_200 },
  ]);
  const rows = cashBasisRows([...invoice("2026-03-10T00:00:00Z"), ...written]);
  expect(totalOf(rows, "income")).toBe(1_000);
  // And the write-off itself is an expense of the month it was written.
  expect(totalOf(rows, "expense")).toBe(1_200);
});

/**
 * A credit note is not a payment.
 *
 * The debt goes away and so does the income behind it. Recognising it as
 * income received would put money on a cash-basis return that nobody ever
 * paid — the exact error the basis exists to avoid.
 */
test("a credit note cancels the income rather than recognising it", () => {
  const note = entry("2026-04-01T00:00:00Z", [
    { code: "4000", type: "income", debit: 1_000 },
    { code: "1100", type: "asset", credit: 1_000 },
  ]);
  const rows = cashBasisRows([...invoice("2026-03-10T00:00:00Z"), ...note]);
  expect(totalOf(rows, "income")).toBe(0);
});

/**
 * Unless the invoice was already paid.
 *
 * Then the money did arrive, was recognised, and the credit is a real
 * reduction of income on the day it was raised.
 */
test("a credit note after payment reduces income on its own date", () => {
  const note = entry("2026-06-01T00:00:00Z", [
    { code: "4000", type: "income", debit: 1_000 },
    { code: "1100", type: "asset", credit: 1_000 },
  ]);
  const all = [
    ...invoice("2026-03-10T00:00:00Z"),
    ...receipt("2026-03-20T00:00:00Z", 1_200),
    ...note,
  ];
  expect(
    totalOf(
      cashBasisRows(all, { to: new Date("2026-03-31T23:59:59Z") }),
      "income",
    ),
  ).toBe(1_000);
  expect(
    totalOf(
      cashBasisRows(all, { from: new Date("2026-06-01T00:00:00Z") }),
      "income",
    ),
  ).toBe(-1_000);
  // And nothing is left over across the whole of it.
  expect(totalOf(cashBasisRows(all), "income")).toBe(0);
});

test("a receipt against nothing recognises nothing", () => {
  // A deposit into the bank that no invoice explains. Recognising income for
  // it would invent money from an entry that never earned any.
  const rows = cashBasisRows(receipt("2026-04-01T00:00:00Z", 5_000));
  expect(totalOf(rows, "income")).toBe(0);
});

test("entries are read in date order however they arrive", () => {
  const all = [
    ...receipt("2026-05-02T00:00:00Z", 1_200),
    ...invoice("2026-03-10T00:00:00Z"),
  ];
  // Handed the payment first, which is the order a database is free to return.
  expect(totalOf(cashBasisRows(all), "income")).toBe(1_000);
});
