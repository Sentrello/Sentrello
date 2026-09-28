import { expect, test } from "bun:test";
import { cashBasisRows, cashBasisVatRows } from "./cash-basis";
import type { LedgerRow } from "./reports";
import { flatRateVatReturn, vatReturn } from "./vat-return";

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

/**
 * The VAT return, on the cash accounting scheme.
 *
 * Under cash accounting VAT is accounted for when money moves, not when the
 * invoice is raised. `cashBasisVatRows` reads the same ledger the accrual
 * return reads and hands back rows the return arithmetic already understands —
 * so the difference between the two returns is entirely the timing of the
 * rows, which is the whole of what the scheme changes.
 */

/** A supplier's bill: £300 of expense and £60 of reclaimable VAT. */
const bill = (at: string, expense = 300, tax = 60) =>
  entry(at, [
    { code: "6000", type: "expense", debit: expense },
    { code: "2200", type: "liability", debit: tax },
    { code: "2000", type: "liability", credit: expense + tax },
  ]);

/** Money out against that bill. */
const billPayment = (at: string, amount: number) =>
  entry(at, [
    { code: "2000", type: "liability", debit: amount },
    { code: "1000", type: "asset", credit: amount },
  ]);

test("an invoice unpaid at period end owes no VAT yet on the cash basis", () => {
  const all = [...invoice("2026-03-10T00:00:00Z")];
  const period = {
    from: new Date("2026-03-01T00:00:00Z"),
    to: new Date("2026-03-31T23:59:59Z"),
  };

  // The accrual return sees the VAT the day the invoice was raised.
  const accrual = vatReturn(all);
  expect(accrual.vatDueSales).toBe(200);
  expect(accrual.totalValueSalesExVAT).toBe(1_000);

  // The cash return sees nothing until somebody pays.
  const cash = vatReturn(cashBasisVatRows(all, period));
  expect(cash.vatDueSales).toBe(0);
  expect(cash.totalValueSalesExVAT).toBe(0);
});

test("once everything is paid, the two bases agree to the penny", () => {
  const all = [
    ...invoice("2026-03-10T00:00:00Z"),
    ...receipt("2026-03-20T00:00:00Z", 1_200),
    ...bill("2026-03-12T00:00:00Z"),
    ...billPayment("2026-03-25T00:00:00Z", 360),
  ];
  const period = {
    from: new Date("2026-03-01T00:00:00Z"),
    to: new Date("2026-03-31T23:59:59Z"),
  };

  const accrual = vatReturn(all);
  const cash = vatReturn(cashBasisVatRows(all, period));
  expect(cash.vatDueSales).toBe(accrual.vatDueSales);
  expect(cash.vatReclaimedCurrPeriod).toBe(accrual.vatReclaimedCurrPeriod);
  expect(cash.netVatDue).toBe(accrual.netVatDue);
  expect(cash.totalValueSalesExVAT).toBe(accrual.totalValueSalesExVAT);
  expect(cash.totalValuePurchasesExVAT).toBe(accrual.totalValuePurchasesExVAT);
});

/**
 * A document carrying two named taxes posts each to an account of its own —
 * "2200-" plus the definition's id — and the cash-basis conversion matched the
 * bare code, so that invoice's VAT was neither pooled against the receivable
 * nor emitted when the money arrived. The return read zero.
 */
test("VAT on an authority's own account is pooled and released like any other", () => {
  const split = (at: string) =>
    entry(at, [
      { code: "1100", type: "asset", debit: 1_200 },
      { code: "4000", type: "income", credit: 1_000 },
      {
        code: "2200-1a2b3c4d",
        type: "liability",
        credit: 160,
        name: "VAT 20%",
      },
      { code: "2200-5e6f7a8b", type: "liability", credit: 40, name: "VAT 5%" },
    ]);
  const all = [
    ...split("2026-03-10T00:00:00Z"),
    ...receipt("2026-03-20T00:00:00Z", 1_200),
  ];
  const cash = vatReturn(
    cashBasisVatRows(all, {
      from: new Date("2026-03-01T00:00:00Z"),
      to: new Date("2026-03-31T23:59:59Z"),
    }),
  );
  expect(cash.vatDueSales).toBe(200);
  expect(cash.totalValueSalesExVAT).toBe(1_000);
});

test("VAT lands in the period the money moved, not the period of the invoice", () => {
  const all = [
    ...invoice("2026-03-10T00:00:00Z"),
    ...receipt("2026-05-02T00:00:00Z", 1_200),
  ];

  const march = vatReturn(
    cashBasisVatRows(all, {
      from: new Date("2026-03-01T00:00:00Z"),
      to: new Date("2026-03-31T23:59:59Z"),
    }),
  );
  expect(march.vatDueSales).toBe(0);

  const may = vatReturn(
    cashBasisVatRows(all, {
      from: new Date("2026-05-01T00:00:00Z"),
      to: new Date("2026-05-31T23:59:59Z"),
    }),
  );
  expect(may.vatDueSales).toBe(200);
  expect(may.totalValueSalesExVAT).toBe(1_000);
});

test("a part payment carries its share of the VAT with it", () => {
  const all = [
    ...invoice("2026-03-10T00:00:00Z"),
    ...receipt("2026-03-20T00:00:00Z", 600),
  ];
  const cash = vatReturn(
    cashBasisVatRows(all, { to: new Date("2026-03-31T23:59:59Z") }),
  );
  // Half the invoice paid: half the VAT due, half the turnover.
  expect(cash.vatDueSales).toBe(100);
  expect(cash.totalValueSalesExVAT).toBe(500);
});

test("input VAT is reclaimed when the supplier is paid, not when billed", () => {
  const all = [...bill("2026-03-12T00:00:00Z")];
  const unpaid = vatReturn(
    cashBasisVatRows(all, { to: new Date("2026-03-31T23:59:59Z") }),
  );
  expect(unpaid.vatReclaimedCurrPeriod).toBe(0);
  expect(unpaid.totalValuePurchasesExVAT).toBe(0);

  const paid = vatReturn(
    cashBasisVatRows([...all, ...billPayment("2026-04-02T00:00:00Z", 360)], {
      from: new Date("2026-04-01T00:00:00Z"),
    }),
  );
  expect(paid.vatReclaimedCurrPeriod).toBe(60);
  expect(paid.totalValuePurchasesExVAT).toBe(300);
});

/**
 * The two schemes combine: HMRC's cash-based turnover method for the Flat
 * Rate Scheme is the flat percentage applied to gross *receipts* rather than
 * gross invoicing. The cash rows carry the VAT beside the income they were
 * recognised with, so the flat-rate arithmetic works on them unchanged.
 */
test("flat rate on the cash basis applies the percentage to gross receipts", () => {
  const all = [
    ...invoice("2026-03-10T00:00:00Z"),
    ...receipt("2026-03-20T00:00:00Z", 600),
  ];
  const out = flatRateVatReturn(
    cashBasisVatRows(all, { to: new Date("2026-03-31T23:59:59Z") }),
    145_000,
  );
  // £6.00 of gross receipts at 14.5% = £0.87.
  expect(out.totalValueSalesExVAT).toBe(600);
  expect(out.vatDueSales).toBe(87);
});

test("a credit note against an unpaid invoice never surfaces in the cash VAT", () => {
  const all = [
    ...invoice("2026-03-10T00:00:00Z"),
    // The whole invoice credited back: income and VAT unwound, nobody paid.
    ...entry("2026-03-15T00:00:00Z", [
      { code: "1100", type: "asset", credit: 1_200 },
      { code: "4000", type: "income", debit: 1_000 },
      { code: "2200", type: "liability", debit: 200 },
    ]),
  ];
  const cash = vatReturn(cashBasisVatRows(all));
  expect(cash.vatDueSales).toBe(0);
  expect(cash.vatReclaimedCurrPeriod).toBe(0);
  expect(cash.totalValueSalesExVAT).toBe(0);
});

test("money that moved with its entry needs no deferral on either side", () => {
  // A card sale and a till expense, both settled the moment they were posted.
  const all = [
    ...entry("2026-03-10T00:00:00Z", [
      { code: "1000", type: "asset", debit: 1_200 },
      { code: "4000", type: "income", credit: 1_000 },
      { code: "2200", type: "liability", credit: 200 },
    ]),
    ...entry("2026-03-11T00:00:00Z", [
      { code: "6000", type: "expense", debit: 300 },
      { code: "2200", type: "liability", debit: 60 },
      { code: "1000", type: "asset", credit: 360 },
    ]),
  ];
  const cash = vatReturn(cashBasisVatRows(all));
  const accrual = vatReturn(all);
  expect(cash.vatDueSales).toBe(accrual.vatDueSales);
  expect(cash.vatReclaimedCurrPeriod).toBe(accrual.vatReclaimedCurrPeriod);
  expect(cash.totalValueSalesExVAT).toBe(accrual.totalValueSalesExVAT);
  expect(cash.totalValuePurchasesExVAT).toBe(accrual.totalValuePurchasesExVAT);
});
