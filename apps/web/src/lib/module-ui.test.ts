import { expect, test } from "bun:test";
import { installRuntime } from "./module-ui";

/**
 * A module list should behave like a Core list.
 *
 * Core's lists search, filter, sort, and page at twenty-five rows with a choice
 * of page size, because `list-ui.tsx` does all of it for them. Modules were
 * never handed it, so mod-shop and mod-newsletter wrote their own paging and
 * nine other modules simply have none — a customer's Orders list and their
 * Contacts list being different products for no reason anybody chose.
 */
test("the runtime lends modules the same list machinery Core uses", () => {
  (globalThis as { window?: unknown }).window = globalThis;
  const runtime = installRuntime();
  for (const name of [
    "useListState",
    "useListQuery",
    "FilterPanel",
    "FilterGroup",
    "FilterToggle",
    "SortMenu",
    "Pagination",
  ]) {
    expect(runtime.listUi).toHaveProperty(name);
  }
  expect(runtime.listUi.PAGINATION_THRESHOLD).toBe(25);
});
