/**
 * The check that stops `{}` becoming the words "[object Object]" in a book.
 *
 * The database does not refuse this one. A text column takes whatever the
 * driver hands it, and the driver stringifies an object — so a name of `{}` is
 * stored, drawn on every list, and cannot be searched for or corrected by name.
 * Found on 6 October when a probe sent one at the groups route and the result
 * appeared on four screens.
 */
import { expect, test } from "bun:test";
import * as schema from "./schema";
import { checkedText, notText } from "./text-columns";

test("an object where text belongs is named and refused", () => {
  const out = checkedText(schema.userGroups, { name: {} });
  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.field).toBe("name");
});

test("an array is the same mistake and reads worse", () => {
  // `["a","b"]` is stored as `a,b`, which looks deliberate.
  expect(checkedText(schema.accounts, { name: ["a", "b"] }).ok).toBe(false);
});

test("text, numbers and booleans pass", () => {
  // "123" and "true" are usually what somebody meant; `{}` never is.
  expect(checkedText(schema.accounts, { name: "Bank", code: 1200 }).ok).toBe(
    true,
  );
  expect(checkedText(schema.userGroups, { name: "The office" }).ok).toBe(true);
});

test("null is absent rather than an object", () => {
  expect(checkedText(schema.accounts, { name: null }).ok).toBe(true);
});

/**
 * A jsonb column takes an object by design, and that is the whole reason this
 * asks the table rather than carrying a list of field names.
 */
test("a jsonb column still takes an object", () => {
  expect(
    checkedText(schema.contacts, { customValues: { size: "large" } }).ok,
  ).toBe(true);
});

test("a date is not an object for this purpose", () => {
  expect(checkedText(schema.contacts, { lastSeenAt: new Date() }).ok).toBe(
    true,
  );
});

test("the refusal names the field and says what would happen", () => {
  expect(notText("name")).toContain("name");
  expect(notText("name")).toContain("[object Object]");
});
