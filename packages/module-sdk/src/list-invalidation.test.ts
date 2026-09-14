import { expect, test } from "bun:test";
import { findStaleInvalidations } from "./list-invalidation";

/** `findStaleInvalidations` for one file's text, given directly rather than as a path. */
function stale(source: string) {
  return findStaleInvalidations([{ path: "", source }]);
}

/**
 * `useListQuery` keys its cache as `[resource, query]`, one joined string —
 * not `[resource]` split into its path segments. A module written before that
 * hook existed invalidates the split way, or with a prefix that used to be
 * broad enough and no longer is, and the mutation "succeeds" while the list
 * on screen never refreshes. It shipped in Shop's conversion and again,
 * immediately, in Newsletter's — this is what should have caught both.
 */

test("a split-array key is a finding, with its line", () => {
  const findings = stale(
    'listUi.useListQuery("shop/products", state);\n' +
      'qc.invalidateQueries({ queryKey: ["shop", "products"] });\n',
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.line).toBe(2);
  expect(findings[0]?.say).toMatch(/shop\/products/);
});

test("an unpaired broad prefix key is a finding, and says to keep it and add an explicit one", () => {
  const findings = stale(
    'listUi.useListQuery("newsletter/subscribers", state);\n' +
      'qc.invalidateQueries({ queryKey: ["newsletter"] });\n',
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.say).toMatch(/keep/);
  expect(findings[0]?.say).toMatch(/newsletter\/subscribers/);
});

/**
 * The paired form — the fix that actually shipped. The broad key stays,
 * because it still covers every other resource in the module that has not
 * converted; the explicit one beside it, in the same block, is what makes
 * the subscribers list refresh again. A guard that still reported this would
 * fail forever on code that is already correct, which is worse than no
 * guard at all — the first thing anyone does with a check like that is turn
 * it off.
 */
test("a broad prefix key paired with an explicit one in the same block is not a finding", () => {
  expect(
    stale(
      'listUi.useListQuery("newsletter/subscribers", state);\n' +
        "const refresh = () => {\n" +
        '  qc.invalidateQueries({ queryKey: ["newsletter"] });\n' +
        '  qc.invalidateQueries({ queryKey: ["newsletter/subscribers"] });\n' +
        "};\n",
    ),
  ).toEqual([]);
});

/** The pairing exception is scoped to the same block, not "anywhere in the file". */
test("a broad prefix key paired with an explicit one in a different function is still a finding", () => {
  const findings = stale(
    'listUi.useListQuery("newsletter/subscribers", state);\n' +
      "const refreshBroad = () => {\n" +
      '  qc.invalidateQueries({ queryKey: ["newsletter"] });\n' +
      "};\n" +
      "const refreshExplicit = () => {\n" +
      '  qc.invalidateQueries({ queryKey: ["newsletter/subscribers"] });\n' +
      "};\n",
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.say).toMatch(/keep/);
});

test("an exact match is not a finding", () => {
  expect(
    stale(
      'listUi.useListQuery("newsletter/subscribers", state);\n' +
        'qc.invalidateQueries({ queryKey: ["newsletter/subscribers"] });\n',
    ),
  ).toEqual([]);
});

test("a key unrelated to any resource in the file is not a finding", () => {
  expect(
    stale(
      'listUi.useListQuery("shop/products", state);\n' +
        'qc.invalidateQueries({ queryKey: ["shop", "shipping"] });\n',
    ),
  ).toEqual([]);
});

test("a by-id key is not a finding", () => {
  expect(
    stale(
      'listUi.useListQuery("shop/orders", state);\n' +
        'qc.invalidateQueries({ queryKey: ["shop/orders", id] });\n',
    ),
  ).toEqual([]);
});

test("a dynamic resource matched by the same template shape is not a finding", () => {
  expect(
    stale(
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
test("a key that exactly matches another real useQuery's key is not a finding", () => {
  expect(
    stale(
      'const places = useQuery({ queryKey: ["shop", "warehouses"], queryFn: load });\n' +
        "listUi.useListQuery(`shop/warehouses/${warehouseId}/stock`, state);\n" +
        'qc.invalidateQueries({ queryKey: ["shop", "warehouses"] });\n',
    ),
  ).toEqual([]);
});

/**
 * The exclusion above only ever excuses an exact match. A key that is itself
 * only a *prefix* of another query's real key is not that query's key — it
 * is still a broad guess, and if it also prefixes a `useListQuery` resource
 * it stays a finding.
 */
test("a key that is only a prefix of another useQuery's key is still a finding", () => {
  const findings = stale(
    'const detail = useQuery({ queryKey: ["shop", "warehouses", "detail"], queryFn: load });\n' +
      'listUi.useListQuery("shop/warehouses", state);\n' +
      'qc.invalidateQueries({ queryKey: ["shop"] });\n',
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.say).toMatch(/shop\/warehouses/);
});

test("a marked line is excepted", () => {
  expect(
    stale(
      'listUi.useListQuery("shop/products", state);\n' +
        "// list-invalidation-ignore: covered by a broader refetch elsewhere\n" +
        'qc.invalidateQueries({ queryKey: ["shop", "products"] });\n',
    ),
  ).toEqual([]);
});

test("an excepted violation does not hide a later unexcepted one of the same kind", () => {
  const findings = stale(
    'listUi.useListQuery("shop/products", state);\n' +
      "// list-invalidation-ignore: reviewed, fine here\n" +
      'qc.invalidateQueries({ queryKey: ["shop", "products"] });\n' +
      'qc.invalidateQueries({ queryKey: ["shop", "products"] });\n',
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.line).toBe(4);
});

/**
 * The real entry point: a module's screens, checked together. Shop's fourth
 * fix site was exactly this shape — `catalogue.tsx` invalidating the
 * products list that only `index.tsx` ever queries with `useListQuery`.
 */
test("a resource declared in one file is checked against an invalidation in another", () => {
  const findings = findStaleInvalidations([
    {
      path: "index.tsx",
      source: 'listUi.useListQuery("shop/products", state);\n',
    },
    {
      path: "catalogue.tsx",
      source: 'qc.invalidateQueries({ queryKey: ["shop", "products"] });\n',
    },
  ]);
  expect(findings).toHaveLength(1);
  expect(findings[0]?.file).toBe("catalogue.tsx");
  expect(findings[0]?.say).toMatch(/shop\/products/);
});

/**
 * The loop that matches a broad key against every queried resource used to
 * stop at the first one it found paired or not, so a bare `["newsletter"]`
 * key sitting beside an explicit `["newsletter/subscribers"]` pair — correct
 * for subscribers — hid a genuinely missing pairing for `newsletter/lists`
 * and `newsletter/campaigns`, resources declared later in the same file.
 * Resource order here matters: subscribers has to be the first `useListQuery`
 * in the file for this to exercise the old break, since that is the only
 * resource the broad key is actually paired for.
 */
test("a broad key paired for one resource still reports a second, unpaired resource it also prefixes", () => {
  const findings = stale(
    'listUi.useListQuery("newsletter/subscribers", state);\n' +
      'listUi.useListQuery("newsletter/lists", state);\n' +
      'listUi.useListQuery("newsletter/campaigns", state);\n' +
      "const refresh = () => {\n" +
      '  qc.invalidateQueries({ queryKey: ["newsletter"] });\n' +
      '  qc.invalidateQueries({ queryKey: ["newsletter/subscribers"] });\n' +
      "};\n",
  );
  expect(findings).toHaveLength(2);
  const said = findings.map((f) => f.say).join("\n");
  expect(said).toMatch(/newsletter\/lists/);
  expect(said).toMatch(/newsletter\/campaigns/);
  expect(said).not.toMatch(/newsletter\/subscribers/);
});

test("across files, an exact match in the invalidating file is still silent", () => {
  expect(
    findStaleInvalidations([
      {
        path: "index.tsx",
        source: 'listUi.useListQuery("shop/products", state);\n',
      },
      {
        path: "catalogue.tsx",
        source: 'qc.invalidateQueries({ queryKey: ["shop/products"] });\n',
      },
    ]),
  ).toEqual([]);
});

/**
 * `invalidateQueries()` has no `queryKey` of its own. Before the 300-char
 * lookahead was taught to stop at the end of its own statement, it kept
 * scanning past the empty call and picked up the *next* call's literal key,
 * producing a second, duplicate finding attributed to the wrong line.
 */
test("invalidateQueries() with no arguments does not borrow the next call's key", () => {
  const findings = stale(
    'listUi.useListQuery("shop/products", state);\n' +
      "qc.invalidateQueries();\n" +
      'qc.invalidateQueries({ queryKey: ["shop", "products"] });\n',
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.line).toBe(3);
});

/** Same borrowing bug, the other shape that triggers it: a `queryKey` given as a variable rather than a literal array. */
test("invalidateQueries({ queryKey: someVar }) does not borrow the next call's key", () => {
  const findings = stale(
    'listUi.useListQuery("shop/products", state);\n' +
      "qc.invalidateQueries({ queryKey: someVar });\n" +
      'qc.invalidateQueries({ queryKey: ["shop", "products"] });\n',
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.line).toBe(3);
});
