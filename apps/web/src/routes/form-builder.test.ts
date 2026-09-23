import { expect, test } from "bun:test";
import { parseChoices } from "../lib/choice-options";
import { fieldName, kept, withInfo } from "./form-builder";

/**
 * The key a submission is stored under, derived from what somebody typed.
 *
 * Nobody should be asked to invent an identifier, and the submissions table
 * has to stay readable to whoever opens it months later.
 */
test("a question becomes a usable key", () => {
  expect(fieldName("What needs doing?", [])).toBe("what_needs_doing");
  expect(fieldName("Your email", [])).toBe("your_email");
});

test("punctuation and spacing do not leak into the key", () => {
  expect(fieldName("  Phone / mobile!  ", [])).toBe("phone_mobile");
  expect(fieldName("***", [])).toBe("field");
});

/**
 * Two fields with the same key would silently overwrite each other in the
 * payload, and the second question's answer would be the only one kept.
 */
test("a repeated question gets its own key", () => {
  expect(fieldName("Address", ["address"])).toBe("address_2");
  expect(fieldName("Address", ["address", "address_2"])).toBe("address_3");
});

test("an absurdly long question is cut rather than stored whole", () => {
  expect(fieldName("a".repeat(200), []).length).toBeLessThanOrEqual(40);
});

/**
 * Choices used not to survive being typed.
 *
 * The editor rendered `options.join(", ")` and parsed it back on every
 * keystroke, so the comma that starts a second choice produced an empty tail,
 * the tail was dropped, and the separator was rendered away again. A form
 * could only ever hold one answer unless somebody pasted the whole list. The
 * text is the state now; these guard the parse either side of it.
 */
test("a comma starts a second choice, and the space after it survives", () => {
  expect(parseChoices("Sales,")).toEqual(["Sales"]);
  expect(parseChoices("Sales, Support")).toEqual(["Sales", "Support"]);
});

test("a choice can be more than one word", () => {
  expect(parseChoices("Key safe, Tenant lets us in")).toEqual([
    "Key safe",
    "Tenant lets us in",
  ]);
});

test("blank choices are not choices", () => {
  expect(parseChoices(" , ,")).toEqual([]);
  expect(parseChoices("Sales, , Support")).toEqual(["Sales", "Support"]);
});

/** A panel with nothing in it is not stored, so a form stays readable. */
test("emptying every part of a panel removes the panel", () => {
  const withTitle = withInfo(
    { name: "why", label: "Why", type: "radio" },
    "Get support",
    { title: "Also consider" },
  );
  expect(withTitle.info).toEqual({ "Get support": { title: "Also consider" } });
  expect(
    withInfo(withTitle, "Get support", { title: "  " }).info,
  ).toBeUndefined();
});

/** Rename a choice and its panel has nothing left to open under. */
test("a panel whose choice is gone is dropped", () => {
  const info = { Sales: { body: "one" }, Support: { body: "two" } };
  expect(kept(info, ["Sales"])).toEqual({ Sales: { body: "one" } });
  expect(kept(info, ["Accounts"])).toBeUndefined();
});
