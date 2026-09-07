import { expect, test } from "bun:test";
import {
  type NavEntry,
  childrenOf,
  panelWorthShowing,
  railModules,
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
