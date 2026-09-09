import { expect, test } from "bun:test";
import type { LedgerRow } from "./reports";
import { forHmrc, vatReturn } from "./vat-return";

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
