import { expect, test } from "bun:test";
import type { LedgerRow } from "./ledger";
import {
  flatRateVatReturn,
  forHmrc,
  limitedCostFigures,
  vatReturn,
} from "./tax";

/**
 * A VAT return is a legal declaration, signed by a person who is liable for it.
 *
 * These are arithmetic tests rather than plumbing tests, because arithmetic is
 * what goes wrong here and the consequence is a wrong figure on a form somebody
 * has attested to.
 */
const row = (over: Partial<LedgerRow>): LedgerRow => ({
  entryId: "e",
  classId: null,
  locationId: null,
  accountId: "a",
  code: "4000",
  name: "Sales",
  type: "income",
  debitCents: 0,
  creditCents: 0,
  postedAt: new Date("2026-04-15"),
  ...over,
});

test("VAT charged is box 1, VAT reclaimed is box 4, and box 3 is their sum", () => {
  const out = vatReturn([
    // £1,000 of sales at 20%: £200 charged.
    row({ code: "2200", type: "liability", name: "VAT", creditCents: 20_000 }),
    // £300 of purchases at 20%: £60 reclaimed.
    row({ code: "2200", type: "liability", name: "VAT", debitCents: 6_000 }),
  ]);
  expect(out.vatDueSales).toBe(20_000);
  expect(out.vatReclaimedCurrPeriod).toBe(6_000);
  // HMRC checks this arithmetic and rejects a return where it does not hold.
  expect(out.totalVatDue).toBe(out.vatDueSales + out.vatDueAcquisitions);
  expect(out.netVatDue).toBe(14_000);
});

/**
 * A business owed money by HMRC puts the amount it is owed in box 5, not a
 * negative number. The direction is implied by boxes 3 and 4.
 */
test("a repayment position gives a positive box 5", () => {
  const out = vatReturn([
    row({ code: "2200", type: "liability", name: "VAT", creditCents: 5_000 }),
    row({ code: "2200", type: "liability", name: "VAT", debitCents: 12_000 }),
  ]);
  expect(out.netVatDue).toBe(7_000);
});

/**
 * Boxes 6 and 7 are turnover, not tax — a different sum over different
 * accounts, and the reason a return needs more than the tax summary gives.
 */
test("turnover excludes the VAT, because the VAT was never posted to income", () => {
  const out = vatReturn([
    row({ creditCents: 100_000 }), // £1,000 of sales
    row({ code: "2200", type: "liability", name: "VAT", creditCents: 20_000 }),
    row({
      code: "5000",
      type: "expense",
      name: "Materials",
      debitCents: 30_000,
    }),
  ]);
  expect(out.totalValueSalesExVAT).toBe(100_000);
  expect(out.totalValuePurchasesExVAT).toBe(30_000);
});

/** A credit note reduces the period's sales rather than adding to purchases. */
test("a credit note comes off box 6", () => {
  const out = vatReturn([
    row({ creditCents: 100_000 }),
    row({ debitCents: 25_000 }), // credited back
  ]);
  expect(out.totalValueSalesExVAT).toBe(75_000);
});

/**
 * The units HMRC demands, and the reason the rounding lives at the edge.
 *
 * Boxes 1 to 5 to two decimals, 6 to 9 as whole pounds rounded down. Rounding
 * in the computation instead would round twice, and a return that disagrees
 * with the report it came from by a penny makes somebody distrust all of it.
 */
test("the submitted shape uses HMRC's units", () => {
  const sent = forHmrc(
    vatReturn([
      row({
        code: "2200",
        type: "liability",
        name: "VAT",
        creditCents: 20_050,
      }),
      row({ creditCents: 100_099 }),
    ]),
  );
  expect(sent.vatDueSales).toBe(200.5);
  // £1,000.99 of sales is declared as £1,000 — rounded down, per HMRC.
  expect(sent.totalValueSalesExVAT).toBe(1_000);
  expect(Number.isInteger(sent.totalValueSalesExVAT)).toBe(true);
});

/**
 * The Northern Ireland boxes are zero and say so.
 *
 * This module has no concept of an EU acquisition. Returning zero is honest;
 * what would not be is letting a business in Northern Ireland believe the
 * return is complete. That warning belongs on the screen, and this test is
 * here so the zeroes are a decision rather than an accident.
 */
test("the EU boxes are zero, deliberately", () => {
  const out = vatReturn([row({ creditCents: 100_000 })]);
  expect(out.vatDueAcquisitions).toBe(0);
  expect(out.totalValueGoodsSuppliedExVAT).toBe(0);
  expect(out.totalAcquisitionsExVAT).toBe(0);
});

/**
 * The Flat Rate Scheme changes the shape of the return, not just a figure.
 *
 * VAT due becomes the sector's percentage of gross — VAT-inclusive — turnover,
 * there is no box 4 reclaim in the ordinary way, and box 6 is the gross
 * flat-rate turnover rather than sales net of VAT. HMRC's rules, and every one
 * of them is the opposite of the standard return's, which is why this is its
 * own computation rather than a flag on the other one.
 */

/** An invoice's rows: £1,000 of income and £200 of VAT charged, one entry. */
const flatInvoice = (entryId: string, income = 100_000, vat = 20_000) => [
  row({ entryId, creditCents: income }),
  row({
    entryId,
    code: "2200",
    type: "liability",
    name: "VAT",
    creditCents: vat,
  }),
];

test("flat rate VAT is the sector percentage of gross turnover", () => {
  // £1,200 gross at 14.5% = £174.
  const out = flatRateVatReturn(flatInvoice("e1"), 145_000);
  expect(out.vatDueSales).toBe(17_400);
  expect(out.totalVatDue).toBe(17_400);
  expect(out.netVatDue).toBe(17_400);
  // Box 6 under this scheme is the gross flat-rate turnover, VAT included.
  expect(out.totalValueSalesExVAT).toBe(120_000);
});

test("no ordinary input reclaim: purchases leave boxes 4 and 7 at zero", () => {
  const out = flatRateVatReturn(
    [
      ...flatInvoice("e1"),
      // A purchase of £300 with £60 of VAT — reclaimable on the standard
      // scheme, not on this one.
      row({
        entryId: "e2",
        code: "6000",
        type: "expense",
        name: "Expenses",
        debitCents: 30_000,
      }),
      row({
        entryId: "e2",
        code: "2200",
        type: "liability",
        name: "VAT",
        debitCents: 6_000,
      }),
    ],
    145_000,
  );
  expect(out.vatReclaimedCurrPeriod).toBe(0);
  expect(out.totalValuePurchasesExVAT).toBe(0);
  // And the purchase's VAT did not leak into the turnover either.
  expect(out.totalValueSalesExVAT).toBe(120_000);
  expect(out.vatDueSales).toBe(17_400);
});

test("a credit note reduces the gross turnover the percentage applies to", () => {
  const out = flatRateVatReturn(
    [
      ...flatInvoice("e1"),
      // A credit note for £240 gross, in the same shape an invoice posts.
      row({ entryId: "e2", debitCents: 20_000 }),
      row({
        entryId: "e2",
        code: "2200",
        type: "liability",
        name: "VAT",
        debitCents: 4_000,
      }),
    ],
    145_000,
  );
  // £1,200 − £240 = £960 gross; 14.5% of that is £139.20.
  expect(out.totalValueSalesExVAT).toBe(96_000);
  expect(out.vatDueSales).toBe(13_920);
});

test("the flat rate return still satisfies HMRC's arithmetic checks", () => {
  const out = flatRateVatReturn(flatInvoice("e1"), 165_000);
  expect(out.totalVatDue).toBe(out.vatDueSales + out.vatDueAcquisitions);
  expect(out.netVatDue).toBe(
    Math.abs(out.totalVatDue - out.vatReclaimedCurrPeriod),
  );
  const sent = forHmrc(out);
  // 16.5% of £1,200 = £198, in HMRC's units.
  expect(sent.vatDueSales).toBe(198);
  expect(sent.totalValueSalesExVAT).toBe(1_200);
});

/**
 * The limited cost figures are surfaced, never decided.
 *
 * Whether a business is a limited cost trader turns on what its *relevant
 * goods* cost — a category the ledger cannot see, because it excludes
 * services, capital, vehicles, food and fuel by rules that need a human who
 * knows the business. So this returns the figures the determination is made
 * from and nothing that looks like the determination itself: no boolean, no
 * chosen rate.
 */
test("limited cost figures at, just below, and just above two percent", () => {
  const at = limitedCostFigures([
    ...flatInvoice("e1"),
    row({
      entryId: "e2",
      code: "6000",
      type: "expense",
      name: "Expenses",
      debitCents: 2_400,
    }),
  ]);
  // £1,200 gross; 2% of it is £24; £24.00 of recorded spending sits exactly at it.
  expect(at.grossTurnoverCents).toBe(120_000);
  expect(at.twoPercentOfTurnoverCents).toBe(2_400);
  expect(at.spendingCents).toBe(2_400);

  const below = limitedCostFigures([
    ...flatInvoice("e1"),
    row({
      entryId: "e2",
      code: "6000",
      type: "expense",
      name: "Expenses",
      debitCents: 2_399,
    }),
  ]);
  expect(below.spendingCents).toBe(2_399);
  expect(below.twoPercentOfTurnoverCents).toBe(2_400);

  const above = limitedCostFigures([
    ...flatInvoice("e1"),
    row({
      entryId: "e2",
      code: "6000",
      type: "expense",
      name: "Expenses",
      debitCents: 2_401,
    }),
  ]);
  expect(above.spendingCents).toBe(2_401);
  expect(above.twoPercentOfTurnoverCents).toBe(2_400);
});

test("the limited cost figures carry no verdict", () => {
  const out = limitedCostFigures(flatInvoice("e1"));
  // Only figures. A boolean or a chosen rate here would be the software
  // making an accountant's call.
  expect(Object.keys(out).sort()).toEqual([
    "grossTurnoverCents",
    "spendingCents",
    "twoPercentOfTurnoverCents",
  ]);
  for (const value of Object.values(out)) {
    expect(typeof value).toBe("number");
  }
});
