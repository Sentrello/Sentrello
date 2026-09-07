import { expect, test } from "bun:test";
import { roles } from "@sentrello/auth";
import { canOwnCrmRecords } from "./managers";

/**
 * Who counts as a CRM manager.
 *
 * The whole definition is one predicate, and it is easy to get backwards —
 * so it is tested against the real role definitions rather than against a
 * hand-written copy of them. If somebody changes what Staff may do in the
 * CRM, this test is what notices.
 */

/** The built-in roles, in the shape the predicate reads. */
function permissionsFor(role: string): Record<string, string[]> {
  const known = roles as unknown as Record<
    string,
    { statements?: Record<string, readonly string[]> } | undefined
  >;
  const statements = known[role]?.statements ?? {};
  const out: Record<string, string[]> = {};
  for (const [resource, actions] of Object.entries(statements)) {
    if (Array.isArray(actions)) out[resource] = [...actions];
  }
  return out;
}

test("seeing the CRM is not the same as running it", () => {
  // The complaint this answers: an owner dropdown listing the whole company
  // is a dropdown nobody can use. Read alone puts you on neither list.
  expect(canOwnCrmRecords({ crm: ["read"] })).toBe(false);
  expect(canOwnCrmRecords({ crm: [] })).toBe(false);
  expect(canOwnCrmRecords({})).toBe(false);
});

test("anybody who can change a CRM record can own one", () => {
  expect(canOwnCrmRecords({ crm: ["read", "create"] })).toBe(true);
  expect(canOwnCrmRecords({ crm: ["read", "update"] })).toBe(true);
});

test("a permission on another module does not make somebody a CRM manager", () => {
  // A bookkeeper is not a salesperson, however much they may edit.
  expect(
    canOwnCrmRecords({ bookkeeping: ["create", "update"], crm: ["read"] }),
  ).toBe(false);
});

test("the built-in roles land where a business would expect", () => {
  // Read from the real role definitions, not from a second copy of them: a
  // list written down twice is a screen that disagrees with the permission
  // checks, and people believe the screen.
  //
  // Two of them, because two is all that is compiled in. Staff used to be
  // asserted here and is the business's own role now — that it may create CRM
  // records is asserted where its permissions are defined, in the users
  // module's defaults.
  expect(canOwnCrmRecords(permissionsFor("admin"))).toBe(true);

  // A customer signs in to look at their own records and nothing else.
  expect(canOwnCrmRecords(permissionsFor("customer"))).toBe(false);
});
