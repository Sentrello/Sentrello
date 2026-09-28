import { expect, test } from "bun:test";
import { findCopiedCsv, findCopiedDisposition } from "./copied-helpers";

/**
 * The scanner itself, on the four copies it was written from.
 *
 * Each of these is the real shape, reduced: they were found by hand on
 * 25 September and every one had drifted from the original in its own
 * direction. What this file holds is that the scanner still recognises them,
 * and — the part that rots faster — that it says nothing about the ordinary
 * code around them.
 */

test("a filename quoted by hand is a copy", () => {
  const found = findCopiedDisposition(
    '"content-disposition": `attachment; filename="${attachment.name.replaceAll(\'"\', "")}"`,',
  );
  expect(found).toHaveLength(1);
  expect(found[0]?.say).toContain("contentDisposition(");
});

test("one built with the helper is not", () => {
  expect(
    findCopiedDisposition(
      '"content-disposition": contentDisposition("attachment", name),',
    ),
  ).toEqual([]);
});

/**
 * A constant filename cannot carry anybody's control characters, and three
 * exports in the CRM name their file outright. Reporting those would be the
 * guard crying wolf on its first run, which is how a guard gets switched off.
 */
test("a filename nobody interpolated is left alone", () => {
  expect(
    findCopiedDisposition(
      '"content-disposition": \'attachment; filename="contacts.csv"\',',
    ),
  ).toEqual([]);
});

test("a comma-joined file served as csv is a copy", () => {
  const source = [
    "const csv = rows.map((row) => row.map(cell).join(\",\")).join('\\n');",
    'return c.body(csv, 200, { "content-type": "text/csv; charset=utf-8" });',
  ].join("\n");
  const found = findCopiedCsv(source);
  expect(found).toHaveLength(1);
  expect(found[0]?.say).toContain("toCsv(");
});

/**
 * Either half alone is ordinary code. A `join(",")` builds a sentence as
 * often as a spreadsheet, and plenty of routes answer `text/csv` with a file
 * the SDK built for them.
 */
test("a join or a csv header on its own says nothing", () => {
  expect(findCopiedCsv('const list = names.join(", ");')).toEqual([]);
  expect(
    findCopiedCsv(
      'return c.body(toCsv(headers, rows), 200, { "content-type": "text/csv" });',
    ),
  ).toEqual([]);
});

/** And the helpers' own definitions are not copies of themselves. */
test("the SDK's own file is not reported", () => {
  const source = [
    "export function toCsv(headers: string[], rows: unknown[][]): string {",
    '  const lines = [headers.map(field).join(",")];',
    '  return `${lines.join("\\r\\n")}\\r\\n`;',
    "}",
    'const headers = { "content-type": "text/csv" };',
  ].join("\n");
  expect(findCopiedCsv(source)).toEqual([]);
});
