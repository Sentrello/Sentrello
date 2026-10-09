/**
 * `Number([])` is 0, and that is the whole of this.
 *
 * Every numeric field in the product was read with `Number(body.x)` and then
 * range-checked — correctly, and against the wrong thing. An empty list coerces
 * to zero, a one-element list to its element, `true` to one: all of them pass
 * `Number.isInteger`, so a price of `[]` was a subscription for nothing and a
 * quantity of `[2]` was two.
 */
import { expect, test } from "bun:test";
import {
  RequestFieldError,
  asFlag,
  asNumber,
  asWholeNumber,
} from "./request-values";

test("a list is not a number, however well it coerces", () => {
  expect(() => asWholeNumber([], "unitPriceCents")).toThrow(RequestFieldError);
  expect(() => asWholeNumber(["500"], "unitPriceCents")).toThrow(
    RequestFieldError,
  );
});

test("nor is an object, or true, or a word", () => {
  for (const sent of [{}, true, false, "nine", "5px", "1e3"]) {
    expect(() => asWholeNumber(sent, "quantity")).toThrow(RequestFieldError);
  }
});

test("a number is, and so is a string of digits", () => {
  expect(asWholeNumber(500, "cents")).toBe(500);
  expect(asWholeNumber("500", "cents")).toBe(500);
  expect(asWholeNumber(" -12 ", "cents")).toBe(-12);
});

test("a fraction is not a whole number", () => {
  expect(() => asWholeNumber(2.5, "cents")).toThrow(RequestFieldError);
  expect(() => asWholeNumber("2.5", "cents")).toThrow(RequestFieldError);
  // And where a fraction is the point, it is allowed and a list still is not.
  expect(asNumber("2.5", "hours")).toBe(2.5);
  expect(() => asNumber([], "hours")).toThrow(RequestFieldError);
});

test("absent means the fallback, and without one it is refused", () => {
  expect(asWholeNumber(undefined, "quantity", 1)).toBe(1);
  expect(asWholeNumber(null, "quantity", 1)).toBe(1);
  // An empty box on a form is an absent value, not a zero.
  expect(asWholeNumber("", "quantity", 1)).toBe(1);
  expect(() => asWholeNumber(undefined, "quantity")).toThrow(RequestFieldError);
});

test("the refusal names the field and says what arrived", () => {
  try {
    asWholeNumber([], "unitPriceCents");
    throw new Error("should have refused");
  } catch (err) {
    expect(err).toBeInstanceOf(RequestFieldError);
    expect((err as RequestFieldError).field).toBe("unitPriceCents");
    expect((err as Error).message).toContain("a list");
  }
});

test("a flag is true or false, and nothing else reads as false", () => {
  expect(asFlag(true, "askName")).toBe(true);
  expect(asFlag(false, "askName", true)).toBe(false);
  expect(asFlag(undefined, "askName", true)).toBe(true);
  expect(asFlag(null, "askName", false)).toBe(false);
  for (const nonsense of [{}, [], [true], "true", 1]) {
    expect(() => asFlag(nonsense, "askName", true)).toThrow(RequestFieldError);
  }
  expect(() => asFlag(undefined, "askName")).toThrow(RequestFieldError);
});
