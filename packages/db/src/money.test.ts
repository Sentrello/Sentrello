import { expect, test } from "bun:test";
import {
  MoneyError,
  documentTotals,
  earlyPaymentTerms,
  invoiceStatus,
  lineTotals,
} from "./money";

test("lineTotals sums integer cents with per-line tax", () => {
  const t = lineTotals([
    { quantity: 2, unitPrice: 5000, taxRateBp: 875 }, // 10000 net, 875 tax
    { quantity: 1, unitPrice: 2500, taxRateBp: 0 }, // 2500 net, 0 tax
  ]);
  expect(t).toEqual({ subtotal: 12500, tax: 875, total: 13375 });
});

test("tax rounds per line, not on the invoice total", () => {
  // 333 * 875bp = 29.1375 -> 29 per line; three lines = 87, not round(87.4125) = 87
  const perLine = lineTotals([
    { quantity: 1, unitPrice: 333, taxRateBp: 875 },
    { quantity: 1, unitPrice: 333, taxRateBp: 875 },
    { quantity: 1, unitPrice: 333, taxRateBp: 875 },
  ]);
  expect(perLine.tax).toBe(87);
  expect(perLine.total).toBe(1086);
});

test("every total is an integer number of cents", () => {
  const t = lineTotals([{ quantity: 3, unitPrice: 1999, taxRateBp: 725 }]);
  expect(Number.isInteger(t.subtotal)).toBe(true);
  expect(Number.isInteger(t.tax)).toBe(true);
  expect(Number.isInteger(t.total)).toBe(true);
  expect(t).toEqual({ subtotal: 5997, tax: 435, total: 6432 });
});

test("empty invoice totals zero", () => {
  expect(lineTotals([])).toEqual({ subtotal: 0, tax: 0, total: 0 });
});

test("invoiceStatus tracks open, partial, and paid", () => {
  expect(invoiceStatus(10000, 0)).toEqual({
    balanceDue: 10000,
    status: "open",
  });
  expect(invoiceStatus(10000, 2500)).toEqual({
    balanceDue: 7500,
    status: "partial",
  });
  expect(invoiceStatus(10000, 10000)).toEqual({
    balanceDue: 0,
    status: "paid",
  });
});

test("overpayment is paid, never negative status", () => {
  expect(invoiceStatus(10000, 12000)).toEqual({
    balanceDue: -2000,
    status: "paid",
  });
});

/**
 * Money arithmetic must not be able to produce a value that is not money.
 *
 * A line whose field names did not match — the shape a client gets wrong most
 * often — multiplied out to NaN, passed through the totals untouched, and
 * stopped only at Postgres, which answered with a 500 and a stack trace.
 */
test("a line with the wrong field names is rejected, not turned into NaN", () => {
  const wrong = [
    {
      description: "Consumer unit replacement",
      quantity: 1,
      unitPriceCents: 48500,
    },
  ] as unknown as Parameters<typeof lineTotals>[0];

  expect(() => lineTotals(wrong)).toThrow(MoneyError);
  expect(() => lineTotals(wrong)).toThrow(/unitPrice/);
});

test("every way a number can stop being one is refused", () => {
  const cases: [string, unknown][] = [
    ["a string price", { quantity: 1, unitPrice: "4850", taxRateBp: 0 }],
    ["a missing price", { quantity: 1, taxRateBp: 0 }],
    ["a null price", { quantity: 1, unitPrice: null, taxRateBp: 0 }],
    ["fractional cents", { quantity: 1, unitPrice: 48.5, taxRateBp: 0 }],
    [
      "an infinite price",
      { quantity: 1, unitPrice: Number.POSITIVE_INFINITY, taxRateBp: 0 },
    ],
    ["NaN quantity", { quantity: Number.NaN, unitPrice: 100, taxRateBp: 0 }],
    ["a string tax rate", { quantity: 1, unitPrice: 100, taxRateBp: "875" }],
  ];

  for (const [name, line] of cases) {
    expect(() =>
      lineTotals([line] as unknown as Parameters<typeof lineTotals>[0]),
    ).toThrow(MoneyError);
    // The message must name the line, so a five-line invoice is debuggable.
    try {
      lineTotals([line] as unknown as Parameters<typeof lineTotals>[0]);
    } catch (err) {
      expect((err as Error).message).toContain("line 1");
    }
    expect(name).toBeTruthy();
  }
});

test("the offending line is named, not just the first one", () => {
  expect(() =>
    lineTotals([
      { quantity: 1, unitPrice: 1000, taxRateBp: 0 },
      { quantity: 2, unitPrice: 2000, taxRateBp: 0 },
      { quantity: 1, unitPrice: "oops", taxRateBp: 0 },
    ] as unknown as Parameters<typeof lineTotals>[0]),
  ).toThrow(/line 3/);
});

test("a fractional quantity is allowed and lands on whole cents", () => {
  // 2.5 hours at $47.33 is 11832.5 cents before rounding — money must not
  // carry a half-cent into the ledger.
  const t = lineTotals([{ quantity: 2.5, unitPrice: 4733, taxRateBp: 0 }]);
  expect(t.subtotal).toBe(11833);
  expect(Number.isInteger(t.total)).toBe(true);
});

test("an omitted tax rate is nil tax, not a rejection", () => {
  const t = lineTotals([
    { quantity: 1, unitPrice: 5000 },
  ] as unknown as Parameters<typeof lineTotals>[0]);
  expect(t).toEqual({ subtotal: 5000, tax: 0, total: 5000 });
});

// ---------------------------------------------------------------------------
// Document totals: a discount, and the tax banded by rate
// ---------------------------------------------------------------------------

test("tax is charged on what is left after the discount, not before it", () => {
  // The order every tax authority expects. Taxing first and discounting after
  // overstates the tax, which is money the business hands over and cannot get
  // back — so it is worth a test that fails loudly if anybody reorders it.
  const lines = [{ quantity: 1, unitPrice: 10_000, taxRateBp: 2000 }];

  const undiscounted = documentTotals(lines);
  expect(undiscounted.tax).toBe(2000);

  const halfOff = documentTotals(lines, { type: "percent", value: 5000 });
  expect(halfOff.discount).toBe(5000);
  // 20% of 50.00, not of 100.00.
  expect(halfOff.tax).toBe(1000);
  expect(halfOff.total).toBe(6000);
});

test("the bands always add up to the tax on the document", () => {
  // The failure this catches: a discount apportioned by rounding leaves the
  // bands a cent short of the total, and a tax return built from the bands
  // disagrees with the invoice it came from.
  const lines = [
    { quantity: 1, unitPrice: 3333, taxRateBp: 2000 },
    { quantity: 1, unitPrice: 3333, taxRateBp: 2000 },
    { quantity: 1, unitPrice: 3334, taxRateBp: 500 },
  ];
  const totals = documentTotals(lines, { type: "amount", value: 1000 });

  const banded = totals.bands.reduce((sum, b) => sum + b.taxCents, 0);
  expect(banded).toBe(totals.tax);

  const taxable = totals.bands.reduce((sum, b) => sum + b.taxableCents, 0);
  expect(taxable).toBe(totals.subtotal - totals.discount);
});

test("lines at the same rate are one band, and different rates are not", () => {
  const totals = documentTotals([
    { quantity: 1, unitPrice: 1000, taxRateBp: 2000, taxName: "VAT 20%" },
    { quantity: 2, unitPrice: 1000, taxRateBp: 2000, taxName: "VAT 20%" },
    { quantity: 1, unitPrice: 1000, taxRateBp: 500, taxName: "Reduced" },
  ]);
  expect(totals.bands).toHaveLength(2);
  // Highest rate first, which is the order a tax summary reads in.
  expect(totals.bands[0]?.rateBp).toBe(2000);
  expect(totals.bands[0]?.taxableCents).toBe(3000);
  expect(totals.bands[1]?.taxableCents).toBe(1000);
});

test("a discount bigger than the document does not owe the customer money", () => {
  // A typo, not a refund. An invoice for a negative amount is a credit note,
  // and producing one by accident is worse than refusing.
  const totals = documentTotals(
    [{ quantity: 1, unitPrice: 5000, taxRateBp: 2000 }],
    { type: "amount", value: 999_999 },
  );
  expect(totals.discount).toBe(5000);
  expect(totals.total).toBe(0);
  expect(totals.tax).toBe(0);
});

test("a negative discount is refused rather than added on", () => {
  expect(() =>
    documentTotals([{ quantity: 1, unitPrice: 1000, taxRateBp: 0 }], {
      type: "amount",
      value: -500,
    }),
  ).toThrow(MoneyError);
});

test("a fractional quantity is billed at what it comes to", () => {
  // 1.5 hours at 66.67 is an ordinary line on a service invoice.
  const totals = documentTotals([
    { quantity: 1.5, unitPrice: 6667, taxRateBp: 2000 },
  ]);
  expect(totals.subtotal).toBe(10_001);
  expect(totals.tax).toBe(2000);
});

test("the zero-rated band is kept, not dropped", () => {
  // A zero-rated line still has to appear on a tax return — "we sold this and
  // charged no tax on it" is a statement, not an absence.
  const totals = documentTotals([
    { quantity: 1, unitPrice: 1000, taxRateBp: 0, categoryCode: "Z" },
    { quantity: 1, unitPrice: 1000, taxRateBp: 2000 },
  ]);
  expect(totals.bands).toHaveLength(2);
  const zero = totals.bands.find((b) => b.categoryCode === "Z");
  expect(zero?.taxableCents).toBe(1000);
  expect(zero?.taxCents).toBe(0);
});

/**
 * "Within 10 days" means the tenth day counts, all of it.
 *
 * Somebody paying at four in the afternoon on the last day has met the terms.
 * An invoice that says otherwise is one nobody trusts twice — and the bug is
 * invisible until a customer is refused on the day they were told.
 */
test("the early-payment window runs to the end of its last day", () => {
  const issue = new Date("2026-03-01T09:00:00.000Z");
  const offer = {
    type: "percent",
    value: 200,
    days: 10,
    issueDate: issue,
    totalCents: 100_000,
  };

  expect(
    earlyPaymentTerms(offer, new Date("2026-03-11T16:00:00.000Z")).open,
  ).toBe(true);
  expect(
    earlyPaymentTerms(offer, new Date("2026-03-12T00:30:00.000Z")).open,
  ).toBe(false);

  const terms = earlyPaymentTerms(offer, issue);
  expect(terms.savingCents).toBe(2_000);
  expect(terms.discountedTotalCents).toBe(98_000);
});

test("an offer larger than the invoice does not make the invoice owe money", () => {
  const terms = earlyPaymentTerms({
    type: "amount",
    value: 500_000,
    days: 5,
    issueDate: new Date("2026-03-01T00:00:00.000Z"),
    totalCents: 10_000,
  });
  expect(terms.savingCents).toBe(10_000);
  expect(terms.discountedTotalCents).toBe(0);
});

test("nothing offered is nothing owed differently", () => {
  const terms = earlyPaymentTerms({
    type: null,
    value: 0,
    days: null,
    issueDate: new Date("2026-03-01T00:00:00.000Z"),
    totalCents: 10_000,
  });
  expect(terms.deadline).toBeNull();
  expect(terms.discountedTotalCents).toBe(10_000);
  expect(terms.open).toBe(false);
});
