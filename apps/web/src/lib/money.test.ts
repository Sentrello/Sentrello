import { expect, test } from "bun:test";
import { lineTotals } from "@sentrello/db/money";
import { type Line, toAmountInput, toCents, totals } from "./money";

const line = (over: Partial<Line> = {}): Line => ({
  description: "Work",
  quantity: 1,
  unitPrice: 10_000,
  taxRateBp: 0,
  ...over,
});

test("an amount typed by a person becomes integer cents", () => {
  expect(toCents("12.50")).toBe(1250);
  expect(toCents("0.01")).toBe(1);
  expect(toCents("1000")).toBe(100_000);
  // the classic float: 19.99 * 100 is 1998.9999... in binary
  expect(toCents("19.99")).toBe(1999);
});

test("nonsense in the box is zero, never NaN", () => {
  for (const bad of ["", "abc", "-", "."]) expect(toCents(bad)).toBe(0);
});

test("cents round-trip back into the box", () => {
  expect(toAmountInput(1250)).toBe("12.5");
  expect(toCents(toAmountInput(1999))).toBe(1999);
  expect(toAmountInput(0)).toBe(""); // an empty box, not "0"
});

test("tax is worked out per line, in basis points", () => {
  // 8.75% of $100.00 is $8.75
  const t = totals([line({ taxRateBp: 875 })]);
  expect(t.subtotal).toBe(10_000);
  expect(t.tax).toBe(875);
  expect(t.total).toBe(10_875);
});

test("the browser agrees with the server, to the cent", () => {
  // This is the whole point of the file: a customer must never be shown a
  // total the invoice then disagrees with.
  const lines = [
    line({ quantity: 3, unitPrice: 3333, taxRateBp: 875 }),
    line({ quantity: 1, unitPrice: 199, taxRateBp: 2000 }),
    line({ quantity: 7, unitPrice: 1, taxRateBp: 1 }),
  ];
  const mine = totals(lines);
  const theirs = lineTotals(
    lines.map((l) => ({
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      taxRateBp: l.taxRateBp,
    })),
  );
  expect(mine).toEqual(theirs);
});

test("no lines is zero, not NaN", () => {
  expect(totals([])).toEqual({ subtotal: 0, tax: 0, total: 0 });
});
