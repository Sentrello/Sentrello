import { expect, test } from "bun:test";
import { formatMoney } from "./ui";

/**
 * Money on a screen is either a figure somebody computed or a dash.
 *
 * The screen that prompted this rendered "$NaN" beside every account on the
 * accounting Reports page: the component read `cents` from a response whose
 * field is `balanceCents`. Route right, arithmetic right, property name
 * wrong — and nothing but looking at the page could see it.
 */
test("integer cents are formatted as money", () => {
  expect(formatMoney(0)).toBe("$0.00");
  expect(formatMoney(1_050)).toBe("$10.50");
  expect(formatMoney(-2_500)).toBe("-$25.00");
});

test("a figure that is not a number is a dash, not a number", () => {
  const missing = undefined as unknown as number;
  expect(formatMoney(missing)).toBe("—");
  expect(formatMoney(Number.NaN)).toBe("—");
  expect(formatMoney(Number.POSITIVE_INFINITY)).toBe("—");
});

/**
 * And never a plausible-looking nought.
 *
 * "$0.00" for a figure nobody computed is the worse failure of the two: it
 * reads as an answer, and a business would act on it.
 */
test("a missing figure is never rendered as nought", () => {
  expect(formatMoney(undefined as unknown as number)).not.toBe("$0.00");
});
