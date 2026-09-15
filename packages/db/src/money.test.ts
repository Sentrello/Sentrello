import { expect, test } from "bun:test";
import {
  MoneyError,
  documentTotals,
  earlyPaymentTerms,
  invoiceStatus,
  lineTotals,
  parseAmountToCents,
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

/**
 * The two implementations of one calculation must not drift apart.
 *
 * `lineTotals` and `documentTotals` both work out a net per line as
 * `round(quantity × unitPrice)` and tax as `round(net × rateBp / 10000)`. With
 * no discount, `documentTotals` is doing exactly what `lineTotals` does with
 * banding on top, so the two must agree to the penny.
 *
 * Each was already covered on its own: removing the rounding from either one
 * fails a test. Neither covered the thing that actually goes wrong with two
 * copies of a calculation — somebody changes one. A quote priced through one
 * and invoiced through the other would then differ by pennies, which is the
 * kind of discrepancy a customer finds and an accountant cannot explain.
 *
 * Swept rather than sampled: the interesting cases are fractional quantities
 * and rates that do not divide evenly, and picking three by hand is how the
 * fourth gets missed.
 */
test("both ways of totalling a document agree, to the penny", () => {
  const quantities = [1, 2, 3, 0.5, 1.5, 2.25, 7, 0.333];
  const prices = [1, 99, 100, 333, 1234, 99_999, 7];
  const rates = [0, 500, 1750, 2000, 2350, 875];

  let checked = 0;
  for (const quantity of quantities) {
    for (const unitPrice of prices) {
      for (const taxRateBp of rates) {
        const lines = [
          { quantity, unitPrice, taxRateBp },
          // A second line at a different rate, because banding is where the
          // two could diverge and a single-line document would never show it.
          {
            quantity: 1,
            unitPrice: 1999,
            taxRateBp: rates[0] === taxRateBp ? 2000 : 0,
          },
        ];

        const one = lineTotals(lines);
        const other = documentTotals(lines, null);

        expect(other.subtotal, `subtotal for ${quantity}×${unitPrice}`).toBe(
          one.subtotal,
        );
        expect(
          other.tax,
          `tax for ${quantity}×${unitPrice} @ ${taxRateBp}`,
        ).toBe(one.tax);
        expect(other.total).toBe(one.total);
        checked += 1;
      }
    }
  }

  // A sweep that swept nothing passes every assertion above it.
  expect(checked).toBeGreaterThan(300);
});

test("amounts arrive in more shapes than one", () => {
  expect(parseAmountToCents("1,250.00")).toBe(125_000);
  expect(parseAmountToCents("(15.00)")).toBe(-1_500);
  expect(parseAmountToCents("-15.00")).toBe(-1_500);
  expect(parseAmountToCents("£1.234,56")).toBe(123_456);
  expect(parseAmountToCents("1,234")).toBe(123_400);
  expect(parseAmountToCents("$99")).toBe(9_900);
  expect(parseAmountToCents("not a number")).toBeNull();
  expect(parseAmountToCents("")).toBeNull();
});

/**
 * More than one tax on a line.
 *
 * Canada is why this exists: GST and a provincial PST are two distinct taxes
 * on the same line, filed to two different authorities, and a combined rate
 * loses the split the filings need. Each tax is computed and rounded on the
 * line it was charged on — the same rule the single-tax path has always used.
 */
test("a Canadian line carries GST and PST as two taxes, to the cent", () => {
  const totals = documentTotals([
    {
      quantity: 1,
      unitPrice: 10_000,
      taxRateBp: 0,
      taxes: [
        { taxDefinitionId: "gst", name: "GST 5%", rateBp: 500 },
        {
          taxDefinitionId: "pst",
          name: "PST 7% (British Columbia)",
          rateBp: 700,
        },
      ],
    },
    {
      quantity: 1,
      unitPrice: 5_000,
      taxRateBp: 0,
      taxes: [{ taxDefinitionId: "gst", name: "GST 5%", rateBp: 500 }],
    },
  ]);

  // 100.00 × 5% + 100.00 × 7% + 50.00 × 5% = 5.00 + 7.00 + 2.50
  expect(totals.tax).toBe(1450);
  expect(totals.total).toBe(16_450);

  // The split the filings need: one band per definition, each whole.
  const gst = totals.bands.find((b) => b.taxDefinitionId === "gst");
  const pst = totals.bands.find((b) => b.taxDefinitionId === "pst");
  expect(gst?.taxableCents).toBe(15_000);
  expect(gst?.taxCents).toBe(750);
  expect(pst?.taxableCents).toBe(10_000);
  expect(pst?.taxCents).toBe(700);
});

test("a Quebec line carries GST and QST and lands on whole cents", () => {
  // QST ships as 998 basis points — the closest whole-basis-point figure to
  // Revenu Québec's 9.975%.
  const totals = documentTotals([
    {
      quantity: 1,
      unitPrice: 8_765,
      taxRateBp: 0,
      taxes: [
        { taxDefinitionId: "gst", name: "GST 5%", rateBp: 500 },
        { taxDefinitionId: "qst", name: "QST 9.975%", rateBp: 998 },
      ],
    },
  ]);
  // 87.65 × 5% = 4.3825 → 4.38; 87.65 × 9.98% = 8.747… → 8.75
  expect(totals.tax).toBe(438 + 875);
  expect(totals.total).toBe(8_765 + 1_313);
  for (const band of totals.bands) {
    expect(Number.isInteger(band.taxCents)).toBe(true);
  }
});

test("each tax rounds per line, on the line it was charged on", () => {
  // Three 3.33 lines at GST 5%: 16.65 rounds to 17 on each line, so the
  // document owes 51 — not 50, which is what rounding a 9.99 subtotal gives.
  // Rounding per line is what the single-tax path has always done, and the
  // second tax on a line follows the same rule independently.
  const line = {
    quantity: 1,
    unitPrice: 333,
    taxRateBp: 0,
    taxes: [
      { taxDefinitionId: "gst", name: "GST", rateBp: 500 },
      { taxDefinitionId: "pst", name: "PST", rateBp: 700 },
    ],
  };
  const totals = documentTotals([line, line, line]);
  expect(totals.bands.find((b) => b.taxDefinitionId === "gst")?.taxCents).toBe(
    17 * 3,
  );
  expect(totals.bands.find((b) => b.taxDefinitionId === "pst")?.taxCents).toBe(
    23 * 3,
  );
  expect(totals.tax).toBe(51 + 69);
});

test("a compound tax is charged on the net plus the taxes before it", () => {
  const totals = documentTotals([
    {
      quantity: 1,
      unitPrice: 10_000,
      taxRateBp: 0,
      taxes: [
        { taxDefinitionId: "a", name: "First 5%", rateBp: 500 },
        {
          taxDefinitionId: "b",
          name: "Stacked 10%",
          rateBp: 1000,
          compound: true,
        },
      ],
    },
  ]);
  // 5% of 100.00 = 5.00; the compound 10% is charged on 105.00 = 10.50.
  expect(totals.tax).toBe(500 + 1050);
  const stacked = totals.bands.find((b) => b.taxDefinitionId === "b");
  expect(stacked?.taxableCents).toBe(10_500);
  expect(stacked?.taxCents).toBe(1050);
});

test("a discount reaches every tax on the line, not just the first", () => {
  const totals = documentTotals(
    [
      {
        quantity: 1,
        unitPrice: 10_000,
        taxRateBp: 0,
        taxes: [
          { taxDefinitionId: "gst", name: "GST 5%", rateBp: 500 },
          { taxDefinitionId: "pst", name: "PST 7%", rateBp: 700 },
        ],
      },
    ],
    { type: "percent", value: 1000 },
  );
  // Both taxes on 90.00, not 100.00.
  expect(totals.discount).toBe(1000);
  expect(totals.tax).toBe(450 + 630);
  expect(totals.total).toBe(9_000 + 1_080);
});

test("a one-entry taxes list totals exactly as the same line written the old way", () => {
  // The migration guarantee: every document written before a line could carry
  // two taxes keeps totalling to the cent as it always has, because a single
  // tax follows the identical arithmetic whichever way it is spelled.
  const oldWay = documentTotals(
    [
      {
        quantity: 1.5,
        unitPrice: 6_667,
        taxRateBp: 875,
        taxDefinitionId: "t1",
      },
      { quantity: 1, unitPrice: 3_333, taxRateBp: 0 },
    ],
    { type: "amount", value: 500 },
  );
  const newWay = documentTotals(
    [
      {
        quantity: 1.5,
        unitPrice: 6_667,
        taxRateBp: 0,
        taxes: [{ taxDefinitionId: "t1", rateBp: 875 }],
      },
      { quantity: 1, unitPrice: 3_333, taxRateBp: 0 },
    ],
    { type: "amount", value: 500 },
  );
  expect(newWay.subtotal).toBe(oldWay.subtotal);
  expect(newWay.tax).toBe(oldWay.tax);
  expect(newWay.total).toBe(oldWay.total);
  expect(newWay.bands).toEqual(oldWay.bands);
});

test("a multi-tax line's bands still add up to the document's tax", () => {
  const totals = documentTotals(
    [
      {
        quantity: 2.5,
        unitPrice: 1_999,
        taxRateBp: 0,
        taxes: [
          { taxDefinitionId: "gst", name: "GST 5%", rateBp: 500 },
          { taxDefinitionId: "pst", name: "PST 7%", rateBp: 700 },
        ],
      },
      {
        quantity: 1,
        unitPrice: 3_333,
        taxRateBp: 500,
        taxDefinitionId: "gst",
        taxName: "GST 5%",
      },
    ],
    { type: "amount", value: 750 },
  );
  const banded = totals.bands.reduce((sum, b) => sum + b.taxCents, 0);
  expect(banded).toBe(totals.tax);
});

test("an unreadable rate inside a taxes list names the line and is refused", () => {
  expect(() =>
    documentTotals([
      {
        quantity: 1,
        unitPrice: 1_000,
        taxRateBp: 0,
        taxes: [{ rateBp: 8.75 as number }],
      },
    ]),
  ).toThrow(MoneyError);
});
