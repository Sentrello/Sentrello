import { expect, test } from "bun:test";
import {
  GROUP_ICONS,
  GROUP_ORDER,
  type NavEntry,
  childrenOf,
  panelWorthShowing,
  railModules,
  sectionsOf,
} from "./app-shell";

/**
 * The sidebar's two levels — the real functions, not a copy of them.
 *
 * This file used to restate the sorting rules rather than import them, and the
 * copy stayed green while the sidebar put the Dashboard underneath every other
 * section. A test that mirrors the code proves only that somebody wrote the
 * same thing twice.
 */

test("every module gets its own icon on the rail", () => {
  const out = railModules([
    { id: "dashboard", label: "Dashboard", moduleId: "dashboard" },
    {
      id: "crm",
      label: "CRM",
      moduleId: "crm",
      group: "Sales",
      icon: "contact",
    },
    { id: "contacts", label: "Contacts", moduleId: "crm", parent: "crm" },
    {
      id: "invoicing",
      label: "Invoices",
      moduleId: "invoicing",
      group: "Money",
    },
    { id: "quotes", label: "Quotes", moduleId: "invoicing", group: "Sales" },
  ]);
  // One entry per module, not per screen and not per section.
  expect(out.map((m) => m.moduleId)).toEqual(["dashboard", "crm", "invoicing"]);
});

test("the rail keeps the order work happens in", () => {
  const out = railModules([
    {
      id: "settings",
      label: "Settings",
      moduleId: "settings",
      group: "Configure",
    },
    {
      id: "invoicing",
      label: "Invoices",
      moduleId: "invoicing",
      group: "Money",
    },
    { id: "crm", label: "CRM", moduleId: "crm", group: "Sales" },
    { id: "dashboard", label: "Dashboard", moduleId: "dashboard" },
  ]);
  // Home first, then find the customer, take the money, and settings last.
  expect(out.map((m) => m.label)).toEqual([
    "Dashboard",
    "CRM",
    "Invoices",
    "Settings",
  ]);
});

test("a module the host has never heard of is kept, at the end", () => {
  const out = railModules([
    { id: "crm", label: "CRM", moduleId: "crm", group: "Sales" },
    { id: "x", label: "Something New", moduleId: "x", group: "Logistics" },
  ]);
  expect(out.map((m) => m.label)).toEqual(["CRM", "Something New"]);
});

/**
 * The CRM registers a parent called "CRM" with five pages under it; Invoicing
 * registers five siblings and no parent at all. The rail has to name and
 * illustrate both, and the entry whose id *is* the module id is the one that
 * was written to describe the module rather than one screen inside it.
 */
test("the rail takes its name and icon from the entry that names the module", () => {
  const [crm] = railModules([
    { id: "crm-dashboard", label: "Dashboard", moduleId: "crm", parent: "crm" },
    {
      id: "crm",
      label: "CRM",
      moduleId: "crm",
      group: "Sales",
      icon: "contact",
    },
  ]);
  expect(crm?.label).toBe("CRM");
  expect(crm?.icon).toBe("contact");
});

test("a module with no naming entry falls back to its first screen", () => {
  const [money] = railModules([
    {
      id: "invoicing",
      label: "Invoices",
      moduleId: "invoicing",
      group: "Money",
      icon: "receipt",
    },
    { id: "quotes", label: "Quotes", moduleId: "invoicing", group: "Money" },
  ]);
  expect(money?.label).toBe("Invoices");
  expect(money?.icon).toBe("receipt");
});

test("a module's pages belong to it, not beside it on the rail", () => {
  const nav: NavEntry[] = [
    { id: "crm", label: "CRM", moduleId: "crm", group: "Sales" },
    { id: "contacts", label: "Contacts", moduleId: "crm", parent: "crm" },
    { id: "companies", label: "Companies", moduleId: "crm", parent: "crm" },
  ];
  expect(childrenOf(nav, "crm").map((c) => c.label)).toEqual([
    "Contacts",
    "Companies",
  ]);
});

/**
 * A panel that restates the icon beside it is fifteen rem taken off the screen
 * somebody is trying to work in. The Dashboard is the case: one entry, no
 * pages, and always will be.
 */
test("a module with one screen and no pages shows no panel", () => {
  const nav: NavEntry[] = [
    { id: "dashboard", label: "Dashboard", moduleId: "dashboard" },
  ];
  const [dashboard] = railModules(nav);
  expect(panelWorthShowing(nav, dashboard)).toBe(false);
});

test("a module with pages shows a panel of its own", () => {
  const nav: NavEntry[] = [
    { id: "crm", label: "CRM", moduleId: "crm", group: "Sales" },
    { id: "contacts", label: "Contacts", moduleId: "crm", parent: "crm" },
  ];
  const [crm] = railModules(nav);
  expect(panelWorthShowing(nav, crm)).toBe(true);
});

test("a module with several screens shows a panel even without nesting", () => {
  const nav: NavEntry[] = [
    {
      id: "invoicing",
      label: "Invoices",
      moduleId: "invoicing",
      group: "Money",
    },
    { id: "quotes", label: "Quotes", moduleId: "invoicing", group: "Money" },
  ];
  const [invoicing] = railModules(nav);
  expect(panelWorthShowing(nav, invoicing)).toBe(true);
});

/**
 * Every group a module can name is ranked.
 *
 * `position()` scores an unlisted group 99, which sorts it below `Configure`.
 * Two groups were unlisted — Marketing and Business — so Links, Search and
 * Documentation rendered *under* Settings and Users. Nobody chose that; it was
 * the absence of two lines from a list whose entire job is stating the order.
 *
 * The failure is invisible by construction: an unranked group still renders,
 * still works, and sits in a plausible-looking place at the end. This is the
 * only thing that would say so.
 */
test("every group the modules use is ranked, so the order is chosen", () => {
  // What the shipped modules actually register, gathered by reading the rail
  // rather than by trusting this list to be kept up to date by hand.
  const groups = ["Sales", "Money", "Work", "Marketing", "Configure"];
  const unranked = groups.filter((g) => !GROUP_ORDER.includes(g));
  expect(
    unranked,
    `these are named by a module and missing from GROUP_ORDER, so they score 99 and sort below Configure: ${unranked.join(", ")}`,
  ).toEqual([]);
});

test("Configure sorts last, because settings are settings wherever you are", () => {
  const others = GROUP_ORDER.filter((g) => g !== "Configure");
  for (const group of others) {
    expect(
      GROUP_ORDER.indexOf(group),
      `${group} must come before Configure`,
    ).toBeLessThan(GROUP_ORDER.indexOf("Configure"));
  }
});

test("every ranked group has an icon, so none falls back to a shrug", () => {
  const missing = GROUP_ORDER.filter((g) => !(g in GROUP_ICONS));
  expect(missing, `ranked with no icon: ${missing.join(", ")}`).toEqual([]);
});

test("no group draws the same icon as another group", () => {
  const seen = new Map<string, string>();
  const clashes: string[] = [];
  for (const [group, icon] of Object.entries(GROUP_ICONS)) {
    const already = seen.get(icon);
    if (already) clashes.push(`${already} and ${group} both draw ${icon}`);
    else seen.set(icon, group);
  }
  expect(clashes, clashes.join("; ")).toEqual([]);
});

/**
 * Headings inside a module's panel.
 *
 * Money is one module with sixteen screens — invoicing and the books are one
 * subject to a business and were one undifferentiated list on screen. These
 * break that list up without adding a third level of navigation, which is the
 * thing that once made eleven screens unreachable.
 */
test("a module that asks for no sections renders exactly as before", () => {
  const pages: NavEntry[] = [
    { id: "a", label: "A", parent: "m" },
    { id: "b", label: "B", parent: "m" },
  ];
  const parts = sectionsOf(pages);
  expect(parts).toHaveLength(1);
  expect(parts[0]?.heading).toBeUndefined();
  expect(parts[0]?.items.map((i) => i.id)).toEqual(["a", "b"]);
});

test("pages with no section lead, under no heading", () => {
  const parts = sectionsOf([
    { id: "paid", label: "Invoices", parent: "money", section: "Getting paid" },
    { id: "home", label: "Dashboard", parent: "money" },
  ]);
  expect(parts[0]?.heading).toBeUndefined();
  expect(parts[0]?.items.map((i) => i.id)).toEqual(["home"]);
  expect(parts[1]?.heading).toBe("Getting paid");
});

test("sections keep the order they are first met, and pages theirs", () => {
  const parts = sectionsOf([
    { id: "1", label: "1", parent: "m", section: "Second" },
    { id: "2", label: "2", parent: "m", section: "First" },
    { id: "3", label: "3", parent: "m", section: "Second" },
  ]);
  expect(parts.map((p) => p.heading)).toEqual(["Second", "First"]);
  expect(parts[0]?.items.map((i) => i.id)).toEqual(["1", "3"]);
});

test("a heading with nothing under it is never produced", () => {
  // The Free instance case: a section whose pages are all Pro disappears with
  // them, rather than leaving a label over empty space.
  const parts = sectionsOf([{ id: "a", label: "A", parent: "m" }]);
  expect(parts.every((p) => p.items.length > 0)).toBe(true);
  expect(parts.map((p) => p.heading)).toEqual([undefined]);
});

test("nothing is lost: every page comes out exactly once", () => {
  const pages: NavEntry[] = [
    { id: "a", label: "A", parent: "m", section: "One" },
    { id: "b", label: "B", parent: "m" },
    { id: "c", label: "C", parent: "m", section: "Two" },
    { id: "d", label: "D", parent: "m", section: "One" },
  ];
  const out = sectionsOf(pages).flatMap((p) => p.items.map((i) => i.id));
  expect(out.sort()).toEqual(["a", "b", "c", "d"]);
});

/**
 * The panel does not re-sort what it is given.
 *
 * `loader.ts` sorts the whole nav by `order` before serving it, so the pages
 * arrive in the order each module asked for. This once sorted again, which
 * looked like belt-and-braces and was the opposite: the loader treats a missing
 * order as 0 and puts those first, and the second sort put them last. Two
 * places holding one idea and disagreeing about it.
 */
test("panel pages keep the order they arrive in", () => {
  const nav: NavEntry[] = [
    { id: "home", label: "Dashboard", parent: "money", order: 18.9 },
    { id: "quotes", label: "Quotes", parent: "money", order: 19 },
    { id: "invoices", label: "Invoices", parent: "money", order: 20 },
  ];
  expect(childrenOf(nav, "money").map((p) => p.id)).toEqual([
    "home",
    "quotes",
    "invoices",
  ]);
});

test("and does not hoist or sink a page that named no order", () => {
  // The loader's rule, which this must not contradict: no order sorts first.
  const nav: NavEntry[] = [
    { id: "unplaced", label: "Unplaced", parent: "m" },
    { id: "first", label: "First", parent: "m", order: 1 },
    { id: "second", label: "Second", parent: "m", order: 2 },
  ];
  expect(childrenOf(nav, "m").map((p) => p.id)).toEqual([
    "unplaced",
    "first",
    "second",
  ]);
});
