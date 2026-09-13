import { expect, test } from "bun:test";
import { defaultLayout, normalizeLayout } from "./pro";

/**
 * How a dashboard is laid out, without a database.
 *
 * `normalizeLayout` and `defaultLayout` are the two decisions worth pinning:
 * what a stored layout is allowed to say, and what somebody sees before they
 * have arranged anything. Both are pure, so neither needs an instance.
 */

/**
 * A module's panel is a widget of its own, wherever somebody put it.
 *
 * The widget list is closed and core-only, which is as far as it can go — Shop
 * and Booking are in another repository and Core must not import them. Each
 * module already declares what it is worth showing, and every one of those is
 * now a panel that can be placed rather than all of them being lumped into one
 * card nobody could arrange.
 */
test("a module's panel survives being saved and read back", () => {
  const tabs = normalizeLayout([
    { name: "Shop", widgets: ["summary:shop", "money"] },
  ]);
  expect(tabs).toEqual([{ name: "Shop", widgets: ["summary:shop", "money"] }]);
});

/**
 * Kept even when the module is not loaded right now.
 *
 * A licence that lapses and is renewed, or a module switched off for a week,
 * should find its panel where it was left rather than having been quietly
 * deleted from the layout while it was away. Nothing is drawn for it in the
 * meantime — the screen renders what the server sends, not what is stored.
 */
test("a panel from a module that is not loaded is kept, not dropped", () => {
  const tabs = normalizeLayout([
    { name: "Anything", widgets: ["summary:not-installed-today"] },
  ]);
  expect(tabs[0]?.widgets).toEqual(["summary:not-installed-today"]);
});

/** An id is module-chosen, so its shape is checked rather than a list of them. */
test("a widget id that is neither built in nor a module panel is dropped", () => {
  const tabs = normalizeLayout([
    {
      name: "Mixed",
      widgets: ["money", "summary:SHOUTING", "summary:", "nonsense", "health"],
    },
  ]);
  expect(tabs[0]?.widgets).toEqual(["money", "health"]);
});

/**
 * Every module gets a tab, without anybody arranging anything.
 *
 * A business with the Shop opens the dashboard and finds a Shop tab. That is
 * the shape the product is meant to have, and it is what the default has to
 * produce because most people never open the arranging screen at all.
 */
test("the default layout gives each loaded module a tab of its own", () => {
  const tabs = defaultLayout([
    { id: "shop", label: "Shop" },
    { id: "scheduling", label: "Booking" },
  ]);
  const names = tabs.map((t) => t.name);

  expect(names).toContain("Shop");
  expect(names).toContain("Booking");
  // Between the core screens and System, which stays last.
  expect(names.at(-1)).toBe("System");
  expect(tabs.find((t) => t.name === "Shop")?.widgets).toEqual([
    "summary:shop",
  ]);
  // The card that listed every module at once is gone from the default: each
  // has a panel now, so that one was the same figures twice.
  expect(tabs.flatMap((t) => t.widgets)).not.toContain("modules");
});

test("an instance with no modules still gets the core tabs", () => {
  const names = defaultLayout([]).map((t) => t.name);
  expect(names).toEqual([
    "Overview",
    "Performance",
    "Sales",
    "Reports",
    "System",
  ]);
});
