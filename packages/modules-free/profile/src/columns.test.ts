import { expect, test } from "bun:test";
import { normalizeColumns } from "./columns";

/**
 * What a column choice may be, before it reaches a screen.
 *
 * Everything here arrives from a browser, and a field name is interpolated into
 * a lookup on the other side — so the shape is checked rather than trusted. The
 * rule throughout is to drop what is not recognisable rather than refuse the
 * save: a column menu that errors because one entry is odd is a column menu
 * people stop using.
 */
test("a column choice is a map of list names to field names", () => {
  expect(normalizeColumns({ invoices: ["due", "tax"] })).toEqual({
    invoices: ["due", "tax"],
  });
  expect(normalizeColumns({ "pos:receipts": ["taken-by"] })).toEqual({
    "pos:receipts": ["taken-by"],
  });
});

test("anything that is not a name is dropped and the rest is kept", () => {
  expect(
    normalizeColumns({
      invoices: ["due", 7, null, "tax", "../../etc/passwd", "a b"],
      "bad name": ["due"],
      quotes: "not a list",
    }),
  ).toEqual({ invoices: ["due", "tax"] });
});

/**
 * Hidden, never shown — which is the decision the whole feature rests on.
 *
 * A list that stored what to *show* would hide every column added after
 * somebody last touched their columns, so a new figure would be invisible to
 * exactly the people who care enough to have arranged them. An empty entry is
 * therefore the same as no entry.
 */
test("nothing hidden is no entry at all", () => {
  expect(normalizeColumns({ invoices: [] })).toEqual({});
  expect(normalizeColumns({})).toEqual({});
  expect(normalizeColumns(null)).toEqual({});
  expect(normalizeColumns("columns")).toEqual({});
  expect(normalizeColumns(["invoices"])).toEqual({});
});

test("a duplicate is stored once, and the row is bounded", () => {
  expect(normalizeColumns({ invoices: ["due", "due", "tax"] })).toEqual({
    invoices: ["due", "tax"],
  });
  const many = Object.fromEntries(
    Array.from({ length: 200 }, (_, i) => [`list${i}`, ["due"]]),
  );
  expect(Object.keys(normalizeColumns(many))).toHaveLength(60);
  const wide = { invoices: Array.from({ length: 200 }, (_, i) => `f${i}`) };
  expect(normalizeColumns(wide).invoices).toHaveLength(80);
});
