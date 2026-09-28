import { afterAll, beforeEach, expect, test } from "bun:test";
import {
  addAccountSection,
  addComputedColumns,
  addOnboarding,
  addPersonalData,
  addSummary,
  addWidget,
  allAccountSections,
  allOnboarding,
  allSummaries,
  allWidgets,
  clearAccountSections,
  clearComputedColumns,
  clearOnboarding,
  clearPersonalData,
  clearSummaries,
  clearWidgets,
  computedColumnsFor,
  personalDataSources,
} from "./index";

/**
 * Two modules cannot take each other's features off the screen.
 *
 * Every registry in the SDK replaced by the bare id a module chose for itself
 * — and a module author chooses that word without seeing the catalogue. Two
 * modules both calling a panel `money`, a checklist `setup`, a card
 * `overview`: not a remote possibility, just what happens the week the second
 * one ships. The later registration replaced the earlier, with no error and
 * no log line, and a business simply did not have a feature it had paid for.
 * Nobody could see why, because there was nothing to see.
 *
 * The key is the module and the word together now. Two modules is two
 * entries; one module registering the same word twice is still one, because
 * that is the same author's intent and it is what a host that loads its
 * modules twice in one process does.
 *
 * **No module had to change to get this.** Every case below registers exactly
 * what a module registered yesterday.
 */

const clearAll = () => {
  clearWidgets();
  clearSummaries();
  clearAccountSections();
  clearOnboarding();
  clearPersonalData();
  clearComputedColumns();
};

beforeEach(clearAll);
// And after, because these registries are one array for the whole process: a
// provider this file left behind is a provider another file's list answers
// with.
afterAll(clearAll);

test("two modules may both call their panel `money`, and both keep it", () => {
  addWidget({ moduleId: "dashboard", id: "money", label: "Money owed" });
  addWidget({ moduleId: "shop", id: "money", label: "Takings" });

  const widgets = allWidgets();
  expect(widgets).toHaveLength(2);
  // Addressed apart, so a layout can hold both and a renderer can tell them
  // apart. The module still declared the plain word.
  expect(widgets.map((w) => w.key)).toEqual(["dashboard:money", "shop:money"]);
  expect(widgets.map((w) => w.id)).toEqual(["money", "money"]);
  expect(widgets.map((w) => w.label)).toEqual(["Money owed", "Takings"]);
});

test("one module registering the same panel twice replaces it", () => {
  addWidget({ moduleId: "shop", id: "money", label: "Takings" });
  addWidget({ moduleId: "shop", id: "money", label: "Takings today" });

  expect(allWidgets()).toHaveLength(1);
  expect(allWidgets()[0]?.label).toBe("Takings today");
});

test("the same holds for every other registry a module writes into", () => {
  const figures = async () => [];

  addSummary({ moduleId: "a", id: "overview", label: "A", load: figures });
  addSummary({ moduleId: "b", id: "overview", label: "B", load: figures });
  addSummary({
    moduleId: "b",
    id: "overview",
    label: "B again",
    load: figures,
  });
  expect(allSummaries().map((s) => s.label)).toEqual(["A", "B again"]);

  const section = (moduleId: string, label: string) => ({
    moduleId,
    id: "orders",
    label,
    hasAny: async () => true,
    load: figures,
  });
  addAccountSection(section("shop", "Shop"));
  addAccountSection(section("booking", "Bookings"));
  addAccountSection(section("booking", "Your bookings"));
  expect(allAccountSections().map((s) => s.label)).toEqual([
    "Shop",
    "Your bookings",
  ]);

  const guide = (moduleId: string, label: string) => ({
    moduleId,
    id: "setup",
    label,
    steps: [],
  });
  addOnboarding(guide("shop", "Selling online"));
  addOnboarding(guide("booking", "Taking bookings"));
  addOnboarding(guide("booking", "Taking bookings online"));
  expect(allOnboarding().map((g) => g.label)).toEqual([
    "Selling online",
    "Taking bookings online",
  ]);
  // A dismissal is stored against this, so hiding one checklist must not hide
  // the other module's.
  expect(allOnboarding().map((g) => g.key)).toEqual([
    "shop:setup",
    "booking:setup",
  ]);

  const source = (moduleId: string, label: string) => ({
    moduleId,
    id: "customers",
    label,
    retention: "While the customer exists",
    export: async () => [],
  });
  addPersonalData(source("shop", "Shop orders"));
  addPersonalData(source("booking", "Bookings"));
  addPersonalData(source("booking", "Your bookings"));
  // The one place a missing answer is also a legal one: a subject access
  // request that silently left a module out.
  expect(personalDataSources().map((s) => s.label)).toEqual([
    "Shop orders",
    "Your bookings",
  ]);

  const columns = (moduleId: string, label: string) => ({
    moduleId,
    id: "value",
    entity: "contact",
    load: async () => ({ columns: [{ key: label, label }], values: {} }),
  });
  addComputedColumns(columns("shop", "Spent"));
  addComputedColumns(columns("booking", "Booked"));
  addComputedColumns(columns("booking", "Bookings"));
  expect(computedColumnsFor("contact").map((p) => p.moduleId)).toEqual([
    "shop",
    "booking",
  ]);
});
