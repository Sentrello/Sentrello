import { expect, test } from "bun:test";
import { inTreeOrder } from "./accounting";

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
