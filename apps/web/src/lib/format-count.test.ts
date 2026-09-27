import { expect, test } from "bun:test";
import { formatCount } from "./ui";

/**
 * Counts read as digits and money did not.
 *
 * `formatMoney` has gone through `Intl` since the beginning, so "$12,480.00"
 * sat one line above "12480 entries" on the same screen. The journal is the
 * figure that grows — a line per invoice and a line per payment — so this is
 * the number a business two years in actually reads.
 */
test("a big count is grouped", () => {
  expect(formatCount(12480)).toBe("12,480");
});

test("a small one is left alone", () => {
  expect(formatCount(0)).toBe("0");
  expect(formatCount(1)).toBe("1");
  expect(formatCount(999)).toBe("999");
});

/**
 * The same refusal `formatMoney` makes, and for the same reason: a figure
 * nobody computed must not come out looking like an answer.
 */
test("a figure that is not a number is a dash", () => {
  expect(formatCount(Number.NaN)).toBe("—");
  expect(formatCount(Number.POSITIVE_INFINITY)).toBe("—");
});
