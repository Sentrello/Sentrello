import { expect, test } from "bun:test";
import { RETENTION_YEARS, retentionYears } from "@sentrello/db/archive";
import { invoiceRetention } from "./personal-data";

/**
 * What a business is told to copy into its own privacy notice.
 *
 * This sentence read "Invoices are kept … six years in the UK." to all four
 * markets, on the one screen whose entire purpose is telling a customer what
 * is true about their own data. An American shop was handed a British
 * retention period as if it were its own.
 *
 * Then it acquired a second fault of the same family: it kept its own table
 * of statutory periods beside the deletion floors in `@sentrello/db/archive`,
 * and on 27 September 2026 an accountant moved the floors and the two tables
 * disagreed. The notice promised six years in the UK while Archive refused to
 * delete for seven. A notice that understates retention is worse than one
 * that names no figure at all, so there is one table now and this holds it to
 * that: whatever the floor says, the sentence says.
 */
test("the notice says the floor, whatever the floor is", () => {
  for (const country of Object.keys(RETENTION_YEARS)) {
    const said = invoiceRetention(country);
    const floor = retentionYears(country);
    const word = { 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten" }[
      floor
    ];
    expect([country, said.includes(`${word} years`)]).toEqual([country, true]);
  }
});

/** And each market is told its own, not its neighbour's. */
test("each market is told its own rule", () => {
  expect(invoiceRetention("GB")).toContain("seven years");
  expect(invoiceRetention("CA")).toContain("seven years");
  expect(invoiceRetention("US")).toContain("seven years");
  expect(invoiceRetention("DE")).toContain("ten years");
  expect(invoiceRetention("FR")).toContain("ten years");
});

/**
 * A country outside the four markets is still never quoted somebody else's
 * statute — that was the original bug. What it is told is what this instance
 * does, which is the default floor, and who decides the real answer.
 */
test("a country we cannot speak for is quoted no foreign statute", () => {
  for (const country of [null, "", "JP", "BR", "Germany"]) {
    const said = invoiceRetention(country);
    expect([country, said.includes("seven years")]).toEqual([country, false]);
    expect(said).toContain("set by the country it is in");
    // But it is told the truth about this instance rather than nothing.
    expect(said).toContain("ten years");
  }
});

/** Whatever the country, the part that is true everywhere still gets said. */
test("the obligation itself is stated wherever the business is", () => {
  for (const country of ["GB", "US", "DE", "JP", null]) {
    expect(invoiceRetention(country)).toContain("not deleted on request");
  }
});
