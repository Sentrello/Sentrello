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

/**
 * An amount as a whole number of cents, or null if it cannot be read.
 *
 * Null rather than zero, always. A row whose amount could not be parsed is a
 * row the business has to look at — importing it as nothing would silently
 * lose money from a reconciliation that then never balances.
 */
export function parseAmountToCents(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;

  // Accountants' parentheses mean money out: (1,234.56) is -1234.56.
  const negative = /^\(.*\)$/.test(text) || text.startsWith("-");
  const digits = text.replace(/[()\-\s]/g, "").replace(/[^0-9.,]/g, "");
  if (!digits) return null;

  /**
   * Which separator is the decimal point.
   *
   * "1.234,56" is a European thousand separator and a comma decimal; "1,234.56"
   * is the other way round. The last separator in the string is the decimal one
   * when it is followed by exactly two digits, and a thousands separator
   * otherwise — which is how "1,234" stays 1234 rather than becoming 12.34.
   */
  const lastComma = digits.lastIndexOf(",");
  const lastDot = digits.lastIndexOf(".");
  const lastSeparator = Math.max(lastComma, lastDot);
  const decimals = lastSeparator >= 0 ? digits.length - lastSeparator - 1 : 0;

  let normalized: string;
  if (lastSeparator >= 0 && (decimals === 1 || decimals === 2)) {
    normalized = `${digits.slice(0, lastSeparator).replace(/[.,]/g, "")}.${digits.slice(
      lastSeparator + 1,
    )}`;
  } else {
    normalized = digits.replace(/[.,]/g, "");
  }

  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  const cents = Math.round(value * 100);
  return negative ? -cents : cents;
}

/** Where a column is, whatever this bank chose to call it. */
export function columnIndex(header: string[], ...candidates: string[]): number {
  const normalized = header.map((cell) => cell.trim().toLowerCase());
  for (const candidate of candidates) {
    const found = normalized.indexOf(candidate);
    if (found !== -1) return found;
  }
  return -1;
}
