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

/**
 * The floor under every write, which is the half of this that cannot be
 * forgotten. The polite check above has to be called; 27 hand-written routes
 * did not call it.
 *
 * Asked of a fake handle rather than the real one, because what is being
 * tested is the wrapper's arithmetic and not Postgres: whether it finds the
 * method, whether it finds a second write hiding in an upsert, whether it lets
 * a `sql` expression through, and whether a transaction's handle is wrapped
 * too.
 */
import { sql } from "drizzle-orm";
import { TextColumnError, guardWrites } from "./text-columns";

function pretend() {
  const seen: unknown[] = [];
  const builder = {
    values: (v: unknown) => {
      seen.push(v);
      return builder;
    },
    set: (v: unknown) => {
      seen.push(v);
      return builder;
    },
    onConflictDoUpdate: (v: unknown) => {
      seen.push(v);
      return builder;
    },
    returning: () => seen,
  };
  const handle = {
    insert: (_table: unknown) => builder,
    update: (_table: unknown) => builder,
    transaction: (fn: (tx: unknown) => unknown) => fn(handle),
    select: () => "read",
  };
  return { handle: guardWrites(handle), seen };
}

test("an insert of an object into a text column is refused", () => {
  const { handle } = pretend();
  expect(() => handle.insert(schema.userGroups).values({ name: {} })).toThrow(
    TextColumnError,
  );
});

test("and so is the second row of a bulk insert", () => {
  const { handle } = pretend();
  expect(() =>
    handle
      .insert(schema.userGroups)
      .values([{ name: "The office" }, { name: ["a", "b"] }]),
  ).toThrow(TextColumnError);
});

test("and the `set` of an upsert, which is a write the first check walks past", () => {
  const { handle } = pretend();
  expect(() =>
    handle
      .insert(schema.userGroups)
      .values({ name: "The office" })
      .onConflictDoUpdate({ target: schema.userGroups.id, set: { name: {} } }),
  ).toThrow(TextColumnError);
});

test("an update is checked the same way", () => {
  const { handle } = pretend();
  expect(() => handle.update(schema.accounts).set({ name: {} })).toThrow(
    TextColumnError,
  );
});

test("a `sql` expression is an object and is not the mistake", () => {
  const { handle } = pretend();
  expect(() =>
    handle.update(schema.accounts).set({ name: sql`upper(name)` }),
  ).not.toThrow();
});

test("a jsonb column still takes an object", () => {
  const { handle, seen } = pretend();
  handle.insert(schema.licenseCache).values({ modules: ["pos", "shop"] });
  expect(seen.length).toBe(1);
});

test("a transaction's own handle is wrapped too", () => {
  const { handle } = pretend();
  expect(() =>
    handle.transaction((tx) =>
      (tx as typeof handle).insert(schema.accounts).values({ name: {} }),
    ),
  ).toThrow(TextColumnError);
});

test("a read is passed straight through", () => {
  const { handle } = pretend();
  expect(handle.select()).toBe("read");
});
