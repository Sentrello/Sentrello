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
  asChoice,
  asFlag,
  asIdOrNothing,
  asNumber,
  asNumberOrNothing,
  asTextOrNothing,
  asWholeNumber,
  asWholeNumberOrNothing,
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

test("a choice is one of its words, and an unknown one is refused, not defaulted", () => {
  const kinds = ["public", "private"] as const;
  expect(asChoice("public", "visibility", kinds, "private")).toBe("public");
  expect(asChoice(undefined, "visibility", kinds, "private")).toBe("private");
  expect(asChoice("", "visibility", kinds, "private")).toBe("private");
  for (const nonsense of ["pubic", "PUBLIC", {}, [], ["public"], true, 1]) {
    expect(() => asChoice(nonsense, "visibility", kinds, "private")).toThrow(
      RequestFieldError,
    );
  }
  expect(() => asChoice(undefined, "visibility", kinds)).toThrow(
    RequestFieldError,
  );
  try {
    asChoice("pubic", "visibility", kinds, "private");
  } catch (err) {
    expect((err as Error).message).toContain("public, private");
    expect((err as RequestFieldError).field).toBe("visibility");
  }
});

test("an id is an id, nothing is null, and anything else is refused", () => {
  const id = "0b7f3a52-4a8e-4c1e-9f55-2f3c1d9e8a10";
  expect(asIdOrNothing(id, "categoryId")).toBe(id);
  expect(asIdOrNothing(null, "categoryId")).toBeNull();
  expect(asIdOrNothing("", "categoryId")).toBeNull();
  for (const nonsense of [{}, [], [id], "shoes", 7]) {
    expect(() => asIdOrNothing(nonsense, "categoryId")).toThrow(
      RequestFieldError,
    );
  }
});

test("text is a string, nothing is null, and anything else is refused, not emptied", () => {
  expect(asTextOrNothing("Ada", "name")).toBe("Ada");
  expect(asTextOrNothing("", "name")).toBe("");
  expect(asTextOrNothing(undefined, "name")).toBeNull();
  expect(asTextOrNothing(null, "name")).toBeNull();
  for (const nonsense of [{}, [], ["Ada"], 7, true]) {
    expect(() => asTextOrNothing(nonsense, "name")).toThrow(RequestFieldError);
  }
});

test("a number or nothing: absent is null, a wrong shape is refused, not defaulted", () => {
  expect(asWholeNumberOrNothing(3, "seats")).toBe(3);
  expect(asWholeNumberOrNothing("3", "seats")).toBe(3);
  expect(asWholeNumberOrNothing(undefined, "seats")).toBeNull();
  expect(asWholeNumberOrNothing(null, "seats")).toBeNull();
  expect(asWholeNumberOrNothing("", "seats")).toBeNull();
  expect(asNumberOrNothing(1.5, "position")).toBe(1.5);
  expect(asNumberOrNothing(undefined, "position")).toBeNull();
  for (const nonsense of [{}, [], [3], "three", true, 1.5]) {
    expect(() => asWholeNumberOrNothing(nonsense, "seats")).toThrow(
      RequestFieldError,
    );
  }
  for (const nonsense of [{}, [2], "two", Number.NaN]) {
    expect(() => asNumberOrNothing(nonsense, "position")).toThrow(
      RequestFieldError,
    );
  }
});
