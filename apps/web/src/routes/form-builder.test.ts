import { expect, test } from "bun:test";
import { fieldName } from "./form-builder";

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
