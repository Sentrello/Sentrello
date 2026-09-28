import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Tabs, activeTab } from "./ui";

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

/**
 * A count belongs on the tab, which is what turns a list into a summary.
 *
 * Invoices had this and the shared strip did not, so invoices kept its own
 * forty-line copy — including its own version of the contrast fix the shared
 * one already carried, which is the part that would have quietly rotted.
 */
test("a tab can carry a count beside its label", () => {
  const html = renderToStaticMarkup(
    <Tabs
      tabs={[
        { id: "open", label: "Open", badge: 12 },
        { id: "paid", label: "Paid" },
      ]}
      active="open"
      onChange={() => {}}
    />,
  );
  expect(html).toContain("Open");
  expect(html).toContain("12");
});

/**
 * Which tab you are on, said rather than coloured.
 *
 * The selected one was a border colour and a text colour and nothing else:
 * plain to look at, and nothing at all to anybody not looking. `aria-current`
 * rather than `role="tab"` and `aria-selected`, because that role promises a
 * keyboard model — arrows, Home, End — this does not implement, and a role
 * that lies is worse than no role. The same reasoning took `role="menu"` off
 * the row menu the same afternoon.
 */
test("the selected tab says so, and the others do not", () => {
  const html = renderToStaticMarkup(
    <Tabs
      tabs={[
        { id: "open", label: "Open" },
        { id: "paid", label: "Paid" },
      ]}
      active="paid"
      onChange={() => {}}
    />,
  );
  // Exactly one, and it is the one that is selected.
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  expect(html.slice(html.indexOf('aria-current="page"'))).toContain("Paid");
});

/**
 * A handle for the browser walk, which had no way to find a tab strip.
 *
 * Every tab changes `?tab=` and draws a different screen's worth of UI, and
 * the accessibility walk only ever saw the one a screen opens on — so Access,
 * Activity and Sessions were as unchecked as an unopened row menu.
 */
test("the strip is findable", () => {
  const html = renderToStaticMarkup(
    <Tabs
      tabs={[{ id: "open", label: "Open" }]}
      active="open"
      onChange={() => {}}
    />,
  );
  expect(html).toContain("data-tab-strip");
});
