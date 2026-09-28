import { expect, test } from "bun:test";
import {
  type CaTaxDefinition,
  caReturnKind,
  caReturns,
  caTaxAccountCode,
} from "./ca-tax";
import type { LedgerRow } from "./ledger";

/**
 * Canadian returns are three different legal declarations to three kinds of
 * authority, and the arithmetic that separates them is what these tests pin
 * down: GST/HST nets input tax credits, QST stands beside it rather than
 * inside it, and PST recovers nothing. A figure on the wrong return is a
 * remittance to the wrong government.
 */

const gst: CaTaxDefinition = {
  id: "11111111-0000-0000-0000-000000000000",
  name: "GST 5%",
  jurisdiction: "CA",
  recoverable: true,
};
const hst: CaTaxDefinition = {
  id: "22222222-0000-0000-0000-000000000000",
  name: "HST 13%",
  jurisdiction: "CA-ON",
  recoverable: true,
};
const qst: CaTaxDefinition = {
  id: "33333333-0000-0000-0000-000000000000",
  name: "QST 9.975%",
  jurisdiction: "CA-QC",
  recoverable: true,
};
const pst: CaTaxDefinition = {
  id: "44444444-0000-0000-0000-000000000000",
  name: "PST 7%",
  jurisdiction: "CA-BC",
  recoverable: false,
};

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
  postedAt: new Date("2026-07-15"),
  ...over,
});

const taxRow = (def: CaTaxDefinition, over: Partial<LedgerRow>): LedgerRow =>
  row({
    code: caTaxAccountCode(def.id),
    type: "liability",
    name: def.name,
    ...over,
  });

test("recoverability and jurisdiction decide which return a tax is on", () => {
  expect(caReturnKind(gst)).toBe("gst-hst");
  expect(caReturnKind(hst)).toBe("gst-hst");
  expect(caReturnKind(qst)).toBe("qst");
  expect(caReturnKind(pst)).toBe("pst");
});

test("a GST-only sale lands on the federal return and nowhere else", () => {
  // $1,000 in Alberta: GST 5% = $50, no provincial tax at all.
  const out = caReturns(
    [
      row({ entryId: "s1", creditCents: 100_000 }),
      taxRow(gst, { entryId: "s1", creditCents: 5_000 }),
    ],
    [gst, pst, qst],
  );
  expect(out.gstHst?.line101SalesCents).toBe(100_000);
  expect(out.gstHst?.line105CollectedCents).toBe(5_000);
  expect(out.gstHst?.line108ItcsCents).toBe(0);
  expect(out.gstHst?.line109NetTaxCents).toBe(5_000);
  expect(out.qst?.line205CollectedCents).toBe(0);
  expect(out.pst[0]?.collectedCents).toBe(0);
});

test("GST and HST share one federal return; the provinces differ in rate, not form", () => {
  const out = caReturns(
    [
      row({ entryId: "s1", creditCents: 100_000 }),
      taxRow(gst, { entryId: "s1", creditCents: 5_000 }),
      row({ entryId: "s2", creditCents: 100_000 }),
      taxRow(hst, { entryId: "s2", creditCents: 13_000 }),
    ],
    [gst, hst],
  );
  expect(out.gstHst?.line105CollectedCents).toBe(18_000);
  expect(out.gstHst?.taxes).toHaveLength(2);
  expect(out.qst).toBeNull();
  expect(out.pst).toHaveLength(0);
});

test("a GST+PST sale splits between the federal and the provincial return", () => {
  // $2,000 in BC: GST $100 to the CRA, PST $140 to the province — two
  // returns to two governments, never one return with more boxes.
  const out = caReturns(
    [
      row({ entryId: "s1", creditCents: 200_000 }),
      taxRow(gst, { entryId: "s1", creditCents: 10_000 }),
      taxRow(pst, { entryId: "s1", creditCents: 14_000 }),
    ],
    [gst, pst],
  );
  expect(out.gstHst?.line105CollectedCents).toBe(10_000);
  expect(out.pst).toHaveLength(1);
  expect(out.pst[0]?.jurisdiction).toBe("CA-BC");
  expect(out.pst[0]?.collectedCents).toBe(14_000);
  expect(out.pst[0]?.dueCents).toBe(14_000);
  // The provincial figure never leaks into the federal return.
  expect(out.gstHst?.line109NetTaxCents).toBe(10_000);
});

test("a Quebec sale files GST federally and QST beside it, not inside it", () => {
  // $1,000 in Quebec: GST $50, QST 9.975% = $99.75 → $100 (99750 ppm rounds
  // per line before it ever reaches the ledger; here it arrives as posted).
  const out = caReturns(
    [
      row({ entryId: "s1", creditCents: 100_000 }),
      taxRow(gst, { entryId: "s1", creditCents: 5_000 }),
      taxRow(qst, { entryId: "s1", creditCents: 9_975 }),
    ],
    [gst, qst],
  );
  expect(out.gstHst?.line105CollectedCents).toBe(5_000);
  expect(out.qst?.line201SalesCents).toBe(100_000);
  expect(out.qst?.line205CollectedCents).toBe(9_975);
  expect(out.qst?.line209NetTaxCents).toBe(9_975);
});

test("input tax credits reduce GST/HST owed, and ITRs reduce QST", () => {
  const out = caReturns(
    [
      row({ entryId: "s1", creditCents: 100_000 }),
      taxRow(gst, { entryId: "s1", creditCents: 5_000 }),
      taxRow(qst, { entryId: "s1", creditCents: 9_975 }),
      // A purchase: Dr expense, Dr each recoverable tax, Cr bank.
      row({ entryId: "p1", code: "5000", type: "expense", debitCents: 40_000 }),
      taxRow(gst, { entryId: "p1", debitCents: 2_000 }),
      taxRow(qst, { entryId: "p1", debitCents: 3_990 }),
    ],
    [gst, qst],
  );
  expect(out.gstHst?.line108ItcsCents).toBe(2_000);
  expect(out.gstHst?.line109NetTaxCents).toBe(3_000);
  expect(out.qst?.line208ItrsCents).toBe(3_990);
  expect(out.qst?.line209NetTaxCents).toBe(9_975 - 3_990);
});

test("PST recovers nothing: a purchase-side debit never reduces what the province is owed", () => {
  const out = caReturns(
    [
      row({ entryId: "s1", creditCents: 200_000 }),
      taxRow(pst, { entryId: "s1", creditCents: 14_000 }),
      // A mis-posting: PST on a purchase belongs in the purchase's cost,
      // not on the liability account. The return refuses to net it.
      row({ entryId: "p1", code: "5000", type: "expense", debitCents: 10_000 }),
      taxRow(pst, { entryId: "p1", debitCents: 700 }),
    ],
    [pst],
  );
  expect(out.pst[0]?.collectedCents).toBe(14_000);
  expect(out.pst[0]?.dueCents).toBe(14_000);
  expect(out.pst[0]?.taxes[0]?.paidOnPurchasesCents).toBe(0);
});

test("a credit note reduces collected tax, never the purchases side", () => {
  // The sale, then its credit note: the note debits income and debits each
  // tax account inside one entry — a sale entry, so the debit nets out of
  // what was collected instead of masquerading as an input credit.
  const out = caReturns(
    [
      row({ entryId: "s1", creditCents: 200_000 }),
      taxRow(gst, { entryId: "s1", creditCents: 10_000 }),
      taxRow(pst, { entryId: "s1", creditCents: 14_000 }),
      row({ entryId: "c1", debitCents: 50_000 }),
      taxRow(gst, { entryId: "c1", debitCents: 2_500 }),
      taxRow(pst, { entryId: "c1", debitCents: 3_500 }),
    ],
    [gst, pst],
  );
  expect(out.gstHst?.line101SalesCents).toBe(150_000);
  expect(out.gstHst?.line105CollectedCents).toBe(7_500);
  expect(out.gstHst?.line108ItcsCents).toBe(0);
  expect(out.pst[0]?.collectedCents).toBe(10_500);
});

test("a refund position is a signed net, not an absolute value", () => {
  // ITCs beyond collections: the CRA owes the business, claimed on line
  // 114 — the sign carries the direction, unlike the UK's box 5.
  const out = caReturns(
    [
      row({ entryId: "s1", creditCents: 10_000 }),
      taxRow(gst, { entryId: "s1", creditCents: 500 }),
      row({ entryId: "p1", code: "5000", type: "expense", debitCents: 80_000 }),
      taxRow(gst, { entryId: "p1", debitCents: 4_000 }),
    ],
    [gst],
  );
  expect(out.gstHst?.line109NetTaxCents).toBe(-3_500);
});

test("a manual adjustment keeps the account's own reading, as the UK return does", () => {
  const out = caReturns(
    [
      // An adjustment posted by hand, touching neither income nor expense.
      taxRow(gst, { entryId: "a1", creditCents: 1_000 }),
      taxRow(gst, { entryId: "a2", debitCents: 300 }),
      taxRow(pst, { entryId: "a3", creditCents: 250 }),
      taxRow(pst, { entryId: "a4", debitCents: 100 }),
    ],
    [gst, pst],
  );
  expect(out.gstHst?.line105CollectedCents).toBe(1_000);
  expect(out.gstHst?.line108ItcsCents).toBe(300);
  // PST has no purchases side, so a lone debit adjusts collected instead.
  expect(out.pst[0]?.collectedCents).toBe(150);
});

test("two PST provinces are two returns, never one figure", () => {
  const mb: CaTaxDefinition = {
    id: "55555555-0000-0000-0000-000000000000",
    name: "RST 7%",
    jurisdiction: "CA-MB",
    recoverable: false,
  };
  const out = caReturns(
    [
      row({ entryId: "s1", creditCents: 100_000 }),
      taxRow(pst, { entryId: "s1", creditCents: 7_000 }),
      row({ entryId: "s2", creditCents: 50_000 }),
      taxRow(mb, { entryId: "s2", creditCents: 3_500 }),
    ],
    [pst, mb],
  );
  expect(out.pst.map((p) => p.jurisdiction)).toEqual(["CA-BC", "CA-MB"]);
  expect(out.pst[0]?.collectedCents).toBe(7_000);
  expect(out.pst[1]?.collectedCents).toBe(3_500);
});

test("a business with no Canadian taxes of a kind never sees that return", () => {
  const out = caReturns(
    [
      row({ entryId: "s1", creditCents: 100_000 }),
      taxRow(gst, { entryId: "s1", creditCents: 5_000 }),
    ],
    [gst],
  );
  expect(out.gstHst).not.toBeNull();
  expect(out.qst).toBeNull();
  expect(out.pst).toHaveLength(0);
});

test("the lines the ledger cannot know are explicit zeros, not missing boxes", () => {
  const out = caReturns([], [gst]);
  expect(out.gstHst?.line110InstalmentsCents).toBe(0);
  expect(out.gstHst?.line111RebatesCents).toBe(0);
  expect(out.gstHst?.line205RealPropertyCents).toBe(0);
  expect(out.gstHst?.line405SelfAssessedCents).toBe(0);
});
