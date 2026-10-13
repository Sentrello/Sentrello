import { expect, test } from "bun:test";
import { MOST_A_COLUMN_HOLDS } from "@sentrello/db/request-values";
import { columnIndex, parseAmountToCents, parseCsv } from "./csv";

test("columnIndex — case-insensitive header lookup with fallbacks", () => {
  const header = ["Date", "Description", "Amount"];
  expect(columnIndex(header, "date")).toBe(0);
  expect(columnIndex(header, "posted", "transaction date", "date")).toBe(0);
  expect(columnIndex(header, "reference")).toBe(-1);
});

/**
 * A row too big for where it is kept is set aside, and the rest come in.
 *
 * Every cents column is a 32-bit integer, so a $30M row in a statement was
 * "integer out of range" at the insert and failed the whole import. The
 * reader still says what it read — the figure is perfectly readable — and the
 * importer sets the row aside by line, with the true reason, against the one
 * ceiling `@sentrello/db/request-values` names.
 */
test("a statement with one oversized row reads every other row", () => {
  const [header = [], ...rows] = parseCsv(
    [
      "Date,Description,Amount",
      "2026-10-01,Coffee,-4.50",
      '2026-10-02,Typo,"30,000,000.00"',
      "2026-10-03,Refund,12.00",
      "2026-10-04,Largest that fits,21474836.47",
    ].join("\n"),
  );
  const at = columnIndex(header, "amount");
  const read: number[] = [];
  const setAside: { line: number; reason: string }[] = [];
  rows.forEach((row, i) => {
    const raw = row[at] ?? "";
    const cents = parseAmountToCents(raw);
    if (cents === null) {
      setAside.push({ line: i + 2, reason: `unreadable amount "${raw}"` });
    } else if (Math.abs(cents) > MOST_A_COLUMN_HOLDS) {
      setAside.push({
        line: i + 2,
        reason: `${raw} is more than one record can hold`,
      });
    } else read.push(cents);
  });
  // Read as the figure it is, not as something unreadable.
  expect(parseAmountToCents("30,000,000.00")).toBe(3_000_000_000);
  expect(setAside).toEqual([
    { line: 3, reason: "30,000,000.00 is more than one record can hold" },
  ]);
  expect(read).toEqual([-450, 1200, 2_147_483_647]);
});
