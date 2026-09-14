import { expect, test } from "bun:test";
import { findStaleInvalidations } from "./list-invalidation";

/**
 * `useListQuery` keys its cache as `[resource, query]`, one joined string —
 * not `[resource]` split into its path segments. A module written before that
 * hook existed invalidates the split way, or with a prefix that used to be
 * broad enough and no longer is, and the mutation "succeeds" while the list
 * on screen never refreshes. It shipped in Shop's conversion and again,
 * immediately, in Newsletter's — this is what should have caught both.
 */

test("a split-array key is a finding, with its line", () => {
  const findings = findStaleInvalidations(
    'listUi.useListQuery("shop/products", state);\n' +
      'qc.invalidateQueries({ queryKey: ["shop", "products"] });\n',
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.line).toBe(2);
  expect(findings[0]?.say).toMatch(/shop\/products/);
});

test("a broad prefix key is a finding, and says to keep it and add an explicit one", () => {
  const findings = findStaleInvalidations(
    'listUi.useListQuery("newsletter/subscribers", state);\n' +
      'qc.invalidateQueries({ queryKey: ["newsletter"] });\n',
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.say).toMatch(/keep/);
  expect(findings[0]?.say).toMatch(/newsletter\/subscribers/);
});

test("an exact match is not a finding", () => {
  expect(
    findStaleInvalidations(
      'listUi.useListQuery("newsletter/subscribers", state);\n' +
        'qc.invalidateQueries({ queryKey: ["newsletter/subscribers"] });\n',
    ),
  ).toEqual([]);
});

test("a key unrelated to any resource in the file is not a finding", () => {
  expect(
    findStaleInvalidations(
      'listUi.useListQuery("shop/products", state);\n' +
        'qc.invalidateQueries({ queryKey: ["shop", "shipping"] });\n',
    ),
  ).toEqual([]);
});

test("a by-id key is not a finding", () => {
  expect(
    findStaleInvalidations(
      'listUi.useListQuery("shop/orders", state);\n' +
        'qc.invalidateQueries({ queryKey: ["shop/orders", id] });\n',
    ),
  ).toEqual([]);
});

test("a dynamic resource matched by the same template shape is not a finding", () => {
  expect(
    findStaleInvalidations(
      "listUi.useListQuery(`shop/warehouses/${warehouseId}/stock`, state);\n" +
        "qc.invalidateQueries({ queryKey: [`shop/warehouses/${chosen}/stock`] });\n",
    ),
  ).toEqual([]);
});

/**
 * A key that only looks like a broad prefix. `["shop", "warehouses"]` is the
 * real, correct cache key for a plain `useQuery` declared right there in the
 * file — it just happens to share its first segments with an unrelated
 * `useListQuery` resource's own path. Found scanning the Shop module for
 * real: three call sites refreshing the warehouse picker, not a stale prefix.
 */
test("a key that exactly matches another real useQuery in the file is not a finding", () => {
  expect(
    findStaleInvalidations(
      'const places = useQuery({ queryKey: ["shop", "warehouses"], queryFn: load });\n' +
        "listUi.useListQuery(`shop/warehouses/${warehouseId}/stock`, state);\n" +
        'qc.invalidateQueries({ queryKey: ["shop", "warehouses"] });\n',
    ),
  ).toEqual([]);
});

test("a marked line is excepted", () => {
  expect(
    findStaleInvalidations(
      'listUi.useListQuery("shop/products", state);\n' +
        "// list-invalidation-ignore: covered by a broader refetch elsewhere\n" +
        'qc.invalidateQueries({ queryKey: ["shop", "products"] });\n',
    ),
  ).toEqual([]);
});

test("an excepted violation does not hide a later unexcepted one of the same kind", () => {
  const findings = findStaleInvalidations(
    'listUi.useListQuery("shop/products", state);\n' +
      "// list-invalidation-ignore: reviewed, fine here\n" +
      'qc.invalidateQueries({ queryKey: ["shop", "products"] });\n' +
      'qc.invalidateQueries({ queryKey: ["shop", "products"] });\n',
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.line).toBe(4);
});
