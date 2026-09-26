import { expect, test } from "bun:test";
import { invoiceRetention } from "./personal-data";

/**
 * What a business is told to copy into its own privacy notice.
 *
 * This sentence read "Invoices are kept … six years in the UK." to all four
 * markets, on the one screen whose entire purpose is telling a customer what
 * is true about their own data. An American shop was handed a British
 * retention period as if it were its own.
 *
 * The figures are the statutory record-keeping period and belong to an
 * accountant rather than to this file — they are in one table in
 * `personal-data.ts`, with the authority named beside each. What this holds
 * is the shape: every market gets its own answer, and a country we cannot
 * speak for gets no number rather than somebody else's.
 */
test("each market is told its own rule", () => {
  expect(invoiceRetention("GB")).toContain("six years");
  expect(invoiceRetention("CA")).toContain("six years");
  // Not one figure, because the IRS period of limitations is not one figure.
  expect(invoiceRetention("US")).toContain("at least three years");
  // Set by each member state and genuinely different across them.
  expect(invoiceRetention("DE")).toContain("between six and ten years");
  expect(invoiceRetention("FR")).toContain("between six and ten years");
});

/**
 * And nowhere is told somebody else's. This is the whole bug: a country
 * outside the four markets, or one nobody has filled in, used to read the
 * British period.
 */
test("a country we cannot speak for is given no number at all", () => {
  for (const country of [null, "", "JP", "BR", "Germany"]) {
    const said = invoiceRetention(country);
    expect([country, said.includes("six years")]).toEqual([country, false]);
    expect([country, said.includes("three years")]).toEqual([country, false]);
    expect(said).toContain("set by the country it is in");
  }
});

/** Whatever the country, the part that is true everywhere still gets said. */
test("the obligation itself is stated wherever the business is", () => {
  for (const country of ["GB", "US", "DE", "JP", null]) {
    expect(invoiceRetention(country)).toContain("not deleted on request");
  }
});
