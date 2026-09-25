import { expect, test } from "bun:test";
import { LIST_UI_MEMBERS, UI_MEMBERS } from "@sentrello/module-sdk/ui-runtime";
import type {
  SentrelloListUi,
  SentrelloUi,
} from "@sentrello/module-sdk/ui-runtime";
import * as listUi from "./list-ui";
import * as ui from "./ui";

/**
 * What modules are promised, and what Core actually exports, are the same list.
 *
 * Each module used to carry its own hand-written copy of this declaration —
 * eleven of them, none agreeing, several missing primitives that had existed
 * for months. A module can only use what its copy declares, so `Tabs` being
 * absent from three of them is the whole reason three modules hand-rolled tab
 * strips. One declaration, checked here against the real thing.
 */
test("every primitive the SDK promises modules is exported by ui.tsx", () => {
  const exported = new Set(Object.keys(ui));
  const missing = UI_MEMBERS.filter((name) => !exported.has(name));
  expect(missing).toEqual([]);
});

/**
 * Host-only exports — real members of `ui.tsx`, deliberately left out of what
 * modules are promised. Adding a name here is a decision, not a place to park
 * something the SDK side forgot: say why, the way the one entry below does.
 */
const UI_HOST_ONLY = [
  // Sets formatting for the whole application (currency, locale). A module
  // choosing that for every other module would be a module setting policy for
  // the host, not a screen using a primitive.
  "setFormats",
  // The raised-surface style object, exported for `AuthShell` — the card on
  // the four screens that draw before anybody is signed in, and therefore
  // before any module exists to want it. A module wanting a raised surface
  // wants `Card`, which is the same thing with the padding decided.
  "raised",
];

/**
 * The reverse of the test above: a primitive added to `ui.tsx` and forgotten
 * in `UI_MEMBERS` reaches every module at runtime through `window.__sentrello`
 * but stays invisible to a TypeScript-strict module, which can only see what
 * the SDK declares. That gap is the one this branch exists to close — the old
 * per-module declarations missed primitives that had existed for months, and
 * a single shared list that only checks one direction reproduces the same
 * failure in one place instead of eleven.
 */
test("every export of ui.tsx is either promised to modules or explicitly host-only", () => {
  const exported = Object.keys(ui);
  const known = new Set([...UI_MEMBERS, ...UI_HOST_ONLY]);
  const unaccounted = exported.filter((name) => !known.has(name));
  expect(unaccounted).toEqual([]);
});

/**
 * The type side of the same question.
 *
 * The test above catches a name that went away. This catches a name whose
 * *shape* changed — a prop renamed, an argument added — which the runtime check
 * cannot see and which reaches a module as a broken screen rather than an error.
 */
test("ui.tsx still satisfies the declared surface", () => {
  const surface: SentrelloUi = ui;
  expect(typeof surface.Card).toBe("function");
});

/**
 * The same drift check, one layer down, for the list machinery.
 *
 * `SentrelloListUi` promises modules `useListState`, `Pagination`, and the
 * rest. Without this, a member could be renamed or removed in `list-ui.tsx`
 * and nothing here would notice until a module's screen broke on it.
 */
test("every member the SDK promises modules is exported by list-ui.tsx", () => {
  const exported = new Set(Object.keys(listUi));
  const missing = LIST_UI_MEMBERS.filter((name) => !exported.has(name));
  expect(missing).toEqual([]);
});

/**
 * The reverse, for the list machinery — no exceptions today. Unlike `ui.tsx`,
 * nothing in `list-ui.tsx` is host-only: every export is something a list
 * screen uses, Core's own included.
 */
test("every export of list-ui.tsx is promised to modules", () => {
  const exported = Object.keys(listUi);
  const known = new Set<string>(LIST_UI_MEMBERS);
  const unaccounted = exported.filter((name) => !known.has(name));
  expect(unaccounted).toEqual([]);
});

/**
 * The shape check for the list machinery, same reasoning as the one above for
 * `SentrelloUi`: a member surviving under the same name but a changed shape —
 * a renamed prop, an added argument — passes the name checks above and would
 * only surface as a broken module screen.
 *
 * `FilterGroup.icon` is excluded: the SDK widens it to `string` rather than
 * `IconName`, because typing it precisely would put a dependency on Core's
 * icon set into the SDK, which every module and Pro would then inherit.
 */
test("list-ui.tsx still satisfies the declared surface, apart from FilterGroup", () => {
  const surface: Omit<SentrelloListUi, "FilterGroup"> = listUi;
  expect(typeof surface.useListState).toBe("function");
});
