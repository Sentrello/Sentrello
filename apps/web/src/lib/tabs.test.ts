import { expect, test } from "bun:test";
import { activeTab } from "./ui";

/**
 * The rule a tab strip lives or dies by: what it shows when the id it was
 * given is not one of the tabs.
 *
 * This imports `activeTab` from `./ui` rather than restating it here. The
 * sibling `navigation.test.tsx` does the opposite — it copies
 * `NavigationProvider.open` into the test file and exercises the copy — and a
 * test shaped that way cannot fail when the real component breaks, which is
 * the only thing a test is for. `activeTab` is exported precisely so the rule
 * can be tested as itself without a DOM.
 */

const tabs = [
  { id: "people", label: "People" },
  { id: "groups", label: "Groups" },
  { id: "events", label: "Events" },
];

test("the tab that was asked for is the tab that is chosen", () => {
  expect(activeTab(tabs, "groups")?.id).toBe("groups");
  expect(activeTab(tabs, "events")?.id).toBe("events");
});

test("an id that names no tab falls back to the first, rather than to nothing", () => {
  // A screen keeps the active tab in the URL, so a bookmark outlives the tab
  // it names — somebody's saved link to a tab a later version removed must
  // open the screen, not a blank panel with a working tab strip above it.
  expect(activeTab(tabs, "a-tab-that-was-deleted")?.id).toBe("people");
  expect(activeTab(tabs, "")?.id).toBe("people");
});

test("no tabs at all resolves to nothing, and does not invent one", () => {
  // The empty case is the one place returning nothing is right: a caller with
  // no tabs has nothing to make active, and inventing a tab here would put a
  // label on screen that names no panel.
  expect(activeTab([], "people")).toBeUndefined();
});
