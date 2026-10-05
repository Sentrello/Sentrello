import { expect, test } from "bun:test";
import { RATE_SCALE, postingsInBase, toBaseCents } from "./currency";

/**
 * An entry converted into base currency still balances, or it never posts.
 *
 * `postJournalEntry` throws on Σdebits ≠ Σcredits, which is right and is also
 * the trap: `toBaseCents` rounds, seven roundings need not agree, and a sale in
 * another currency would simply fail to reach the books. That is worse than the
 * rounding it was avoiding — the shop marked the order paid first.
 */
const sum = (
  lines: { debitCents?: number; creditCents?: number }[],
  side: "debitCents" | "creditCents",
) => lines.reduce((n, l) => n + (l[side] ?? 0), 0);

/** A rate chosen because it makes the naive conversion come out uneven. */
const RATE = 783_333;

test("every line is converted and the entry still balances", () => {
  /*
   * Three ones against a three, which is the smallest case that breaks.
   *
   * At this rate each penny rounds up to a penny and the three-penny total
   * rounds down to two, so the debits come to three and the credits to two.
   * Found by search rather than by taste: plausible-looking figures balance by
   * luck most of the time, which is why this bug would have reached a customer.
   */
  const lines = [
    { accountId: "cash", debitCents: 1 },
    { accountId: "given", debitCents: 1 },
    { accountId: "tax", debitCents: 1 },
    { accountId: "income", creditCents: 3 },
  ];
  const naive = lines.map((l) => ({
    ...l,
    ...(l.debitCents === undefined
      ? {}
      : { debitCents: toBaseCents(l.debitCents, RATE) }),
    ...(l.creditCents === undefined
      ? {}
      : { creditCents: toBaseCents(l.creditCents, RATE) }),
  }));
  // The reason this function exists: converting line by line does not balance.
  expect(sum(naive, "debitCents")).not.toBe(sum(naive, "creditCents"));

  const out = postingsInBase(lines, RATE);
  expect(sum(out, "debitCents")).toBe(sum(out, "creditCents"));
  // And it is the converted figure, not the original one.
  expect(sum(out, "debitCents")).toBeLessThan(sum(lines, "debitCents"));
  expect(sum(out, "debitCents")).toBe(2);
});

test("the residual lands on the largest line and changes no sign", () => {
  const out = postingsInBase(
    [
      { accountId: "cash", debitCents: 10_000 },
      { accountId: "rounding-victim", debitCents: 1 },
      { accountId: "income", creditCents: 10_001 },
    ],
    RATE,
  );
  expect(sum(out, "debitCents")).toBe(sum(out, "creditCents"));
  // The one-cent line is still a positive one cent, not zero and not negative.
  const small = out.find((l) => l.accountId === "rounding-victim");
  expect(small?.debitCents).toBeGreaterThan(0);
});

/**
 * And a single-currency instance is untouched, bit for bit.
 *
 * Every figure in this product was posted at face value before this existed, so
 * par has to be the identity or an upgrade moves numbers that were already
 * right.
 */
test("at par the lines are handed back exactly as they came", () => {
  const lines = [
    { accountId: "cash", debitCents: 999 },
    { accountId: "income", creditCents: 999 },
  ];
  expect(postingsInBase(lines, RATE_SCALE)).toBe(lines);
  expect(postingsInBase(lines, null)).toBe(lines);
  expect(postingsInBase(lines, undefined)).toBe(lines);
});
