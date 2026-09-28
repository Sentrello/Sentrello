import { expect, test } from "bun:test";
import type {
  Runtime,
  SentrelloListUi,
} from "@sentrello/module-sdk/ui-runtime";
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

/**
 * `Runtime` (the SDK's description of what a module is handed) and
 * `SentrelloRuntime` (what this file actually publishes) are two descriptions
 * of the same object, and nothing before this checked them against each
 * other — the same class of defect the rest of this branch removed. If this
 * file stopped publishing something `Runtime` promises, `installRuntime()`'s
 * return type would no longer satisfy `Runtime` and this line would fail to
 * compile.
 *
 * `SentrelloRuntime` also carries `react`, `jsxRuntime` and `reactQuery`,
 * which `Runtime` does not declare. That is deliberate rather than an
 * omission: a module never reaches those three through `makeModuleRuntime()`
 * or any other SDK call — its bundler points its own `import React from
 * "react"` at `window.__sentrello.react` before the script ships, invisibly
 * to the module's code. `Runtime` documents what a module can ask the host
 * for; `react`/`jsxRuntime`/`reactQuery` are how the host avoids shipping a
 * second copy of React, which is a build concern, not part of that contract.
 *
 * `listUi.FilterGroup` is checked against `Omit<..., "FilterGroup">`, same
 * exception and same reason as `runtime-surface.test.ts`: the SDK widens its
 * `icon` prop to `string` rather than the app's `IconName`, so as not to put a
 * dependency on Core's icon set into the SDK.
 */
test("the published runtime satisfies the SDK's declared Runtime", () => {
  (globalThis as { window?: unknown }).window = globalThis;
  const runtime = installRuntime();
  const contract: Omit<Runtime, "listUi"> & {
    listUi: Omit<SentrelloListUi, "FilterGroup">;
  } = runtime;
  expect(contract.ui).toBe(runtime.ui);
});
