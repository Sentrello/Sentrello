import { parseCsv } from "@sentrello/module-sdk";

export { parseCsv };

/**
 * Reading what a bank gives you.
 *
 * The row splitter moved into the module SDK on 2026-08-28: Newsletter imports
 * a subscriber list and lives in another repository, and two CSV parsers is
 * two sets of quoting bugs.
 *
 * Every bank exports CSV and every one of them does it slightly differently:
 * quoted fields with commas inside, amounts in parentheses for money out,
 * currency symbols, thousands separators, and a header row whose column names
 * are whatever that bank happens to call them. This is the smallest parser that
 * copes with all of that, and nothing more.
 */

// The amount reader lives in `@sentrello/db/money` now, beside the other
// money arithmetic: text into integer cents is a money invariant, not a CSV
// detail, and the paid half reads it from there.
export { parseAmountToCents } from "@sentrello/db/money";

/** Where a column is, whatever this bank chose to call it. */
export function columnIndex(header: string[], ...candidates: string[]): number {
  const normalized = header.map((cell) => cell.trim().toLowerCase());
  for (const candidate of candidates) {
    const found = normalized.indexOf(candidate);
    if (found !== -1) return found;
  }
  return -1;
}
