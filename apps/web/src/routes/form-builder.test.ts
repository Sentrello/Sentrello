import { expect, test } from "bun:test";
import { parseChoices } from "../lib/choice-options";
import { fieldName, kept, moved, withInfo } from "./form-builder";

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

/**
 * A Choice goes wherever the form wants it.
 *
 * Reported as "I can't move Choice up", and there was never a rule about
 * Choice: the reorder reads no field type at all, and a Choice carries its
 * answers and their panels on the field object, so it travels whole. What was
 * true is that the first field's ↑ was a live button that did nothing, on a
 * row tall enough to hide that nothing happened. The buttons are disabled at
 * the ends now; this proves the movement itself, which nothing covered.
 */
const choice = {
  name: "what_brings_you",
  label: "What brings you here?",
  type: "select",
  options: ["A quote", "Support", "Something else"],
  info: { "A quote": { title: "We'll price it" } },
};
const text = { name: "name", label: "Your name", type: "text" };
const email = { name: "email", label: "Email", type: "email" };

test("a choice moves up, and takes its answers with it", () => {
  const order = moved([text, choice, email], 1, -1);
  expect(order.map((f) => f.name)).toEqual([
    "what_brings_you",
    "name",
    "email",
  ]);
  // The options and their panels are properties of the field, not a side
  // table, so they are still there on the other side of the move.
  expect(order[0]?.options).toEqual(["A quote", "Support", "Something else"]);
  expect(order[0]?.info).toEqual({ "A quote": { title: "We'll price it" } });
});

test("a choice moves down, and to the end, and back to the top", () => {
  expect(moved([choice, text, email], 0, 1).map((f) => f.name)).toEqual([
    "name",
    "what_brings_you",
    "email",
  ]);
  expect(moved([choice, text, email], 0, 2).map((f) => f.name)).toEqual([
    "name",
    "email",
    "what_brings_you",
  ]);
  expect(moved([text, email, choice], 2, -2).map((f) => f.name)).toEqual([
    "what_brings_you",
    "name",
    "email",
  ]);
});

test("a move off either end changes nothing, and says so by identity", () => {
  const rows = [choice, text];
  // The same array back, not a copy — the caller is a state setter, and a new
  // array that holds the same fields re-renders the list for nothing.
  expect(moved(rows, 0, -1)).toBe(rows);
  expect(moved(rows, 1, 1)).toBe(rows);
});
