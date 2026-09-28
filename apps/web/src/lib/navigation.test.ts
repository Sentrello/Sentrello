import { expect, test } from "bun:test";
import { pathOf, viewFromPath } from "./navigation";

/**
 * The address bar is the state. Two things have to hold for that to be worth
 * anything: a link somebody sends opens the same screen they were looking at,
 * and a path this instance cannot serve never leaves somebody on an empty
 * shell.
 */

const known = [
  { id: "dashboard", label: "Dashboard" },
  { id: "contacts", label: "Contacts" },
  { id: "invoicing", label: "Invoices" },
];

test("a view has one address, and it round-trips", () => {
  const list = { moduleId: "contacts", title: "Contacts" };
  expect(pathOf(list)).toBe("/contacts");
  expect(viewFromPath(pathOf(list), known)).toEqual(list);

  const record = {
    moduleId: "invoicing",
    recordId: "8f3ac1e2-0000-4000-8000-000000000000",
    title: "Invoices",
  };
  expect(pathOf(record)).toBe(
    "/invoicing/8f3ac1e2-0000-4000-8000-000000000000",
  );
  expect(viewFromPath(pathOf(record), known)).toEqual(record);
});

test("a module this instance does not have is not opened", () => {
  // An old bookmark, or a link from somebody whose licence includes more.
  expect(viewFromPath("/scheduling", known)).toBeNull();
  expect(viewFromPath("/scheduling/abc", known)).toBeNull();
  expect(viewFromPath("/", known)).toBeNull();
  expect(viewFromPath("", known)).toBeNull();
});

test("slashes and encoding do not change which screen opens", () => {
  expect(viewFromPath("/contacts/", known)?.moduleId).toBe("contacts");
  expect(viewFromPath("//contacts//", known)?.moduleId).toBe("contacts");

  // An id with a character that has to be escaped comes back as it went in.
  const view = { moduleId: "contacts", recordId: "a b/c", title: "Contacts" };
  expect(pathOf(view)).toBe("/contacts/a%20b%2Fc");
});

test("the title falls back to the module until the record says otherwise", () => {
  // A deep link carries an id and no name; the screen that loads the record
  // reports the real one.
  expect(viewFromPath("/contacts/abc", known)?.title).toBe("Contacts");
});
