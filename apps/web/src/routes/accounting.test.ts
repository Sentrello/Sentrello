import { expect, test } from "bun:test";
import { inTreeOrder, matchingAccounts } from "./accounting";

/**
 * The chart is a tree, and a tree that loses rows is worse than a flat list.
 *
 * These are the two ways the ordering can go wrong in a way nobody notices: a
 * child whose parent is not on screen quietly disappearing, and a loop in the
 * data — which the server refuses, but the screen also renders charts it was
 * handed rather than ones it made.
 */
const account = (
  id: string,
  code: string,
  parentId: string | null = null,
): Parameters<typeof inTreeOrder>[0][number] => ({
  id,
  code,
  name: `Account ${code}`,
  type: "expense",
  parentId,
  archivedAt: null,
});

test("children sit under their parent, and everything is in code order", () => {
  const order = inTreeOrder([
    account("c", "6200", "a"),
    account("a", "6000"),
    account("b", "6100"),
    account("d", "6210", "c"),
  ]);

  expect(order.map((row) => row.account.code)).toEqual([
    "6000",
    "6200",
    "6210",
    "6100",
  ]);
  expect(order.map((row) => row.depth)).toEqual([0, 1, 2, 0]);
});

test("an account whose parent is not on the list is still shown", () => {
  // The parent is archived and the child is not — hiding the child would lose
  // a live account from the chart.
  const order = inTreeOrder([account("child", "6300", "archived-parent")]);
  expect(order).toHaveLength(1);
  expect(order[0]?.depth).toBe(0);
});

test("a loop in the data cannot hang the screen", () => {
  const order = inTreeOrder([
    account("a", "6000", "b"),
    account("b", "6100", "a"),
  ]);
  // Neither is reachable from the top, so neither is drawn — but it returns.
  expect(order.length).toBeLessThanOrEqual(2);
});

/**
 * Finding an account in a chart, without breaking the chart.
 *
 * The search is done on the client rather than by the list machinery the
 * other Money lists use, for three reasons that are all silent failures: ten
 * places read `/api/accounts` to fill a picker and paging would quietly offer
 * them the first twenty-five; this screen draws a tree, where a parent
 * falling off a page orphans its children; and both look like working
 * screens.
 *
 * What the filter must not do is lose the branch a match hangs from —
 * `inTreeOrder` drops a child whose parent is absent, so a match whose parent
 * does not also match would disappear along with it.
 */
const chart = [
  account("expenses", "6000"),
  account("fuel", "6100", "expenses"),
  account("rent", "6200", "expenses"),
  account("cash", "1000"),
];

test("a match keeps the branch it hangs from", () => {
  const found = matchingAccounts(chart, "6100");
  expect(found.map((a) => a.id)).toEqual(["expenses", "fuel"]);
  // And the tree still draws, which is the thing that would have broken.
  expect(inTreeOrder(found).map((row) => row.account.id)).toEqual([
    "expenses",
    "fuel",
  ]);
});

test("a match brings nothing it does not own", () => {
  expect(matchingAccounts(chart, "6000").map((a) => a.id)).toEqual([
    "expenses",
  ]);
});

test("a name matches as well as a code", () => {
  expect(matchingAccounts(chart, "account 1000").map((a) => a.id)).toEqual([
    "cash",
  ]);
});

test("no term is the whole chart, not an empty one", () => {
  expect(matchingAccounts(chart, "   ")).toHaveLength(chart.length);
});
