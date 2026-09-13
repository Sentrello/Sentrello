import { beforeEach, expect, test } from "bun:test";
import {
  addOnboarding,
  allOnboarding,
  clearOnboarding,
  resolveGuide,
} from "./onboarding";

/**
 * A checklist whose ticks are derived, never stored.
 *
 * That is the whole design and the reason for it is the day-200 case: a module
 * bought months after a business started must show the steps it already
 * satisfies as already done. A stored flag cannot — it was never set, because
 * the module was not there when the work happened.
 */

const guide = (steps: Parameters<typeof addOnboarding>[0]["steps"]) => ({
  id: "shop",
  moduleId: "shop",
  label: "Selling online",
  steps,
});

beforeEach(clearOnboarding);

test("a step asks the data rather than remembering an answer", async () => {
  const asked: string[] = [];
  const resolved = await resolveGuide(
    guide([
      {
        id: "products",
        label: "Add a product",
        done: async (org) => {
          asked.push(org);
          return true;
        },
      },
      {
        id: "payments",
        label: "Connect a card processor",
        done: async () => false,
      },
    ]),
    "org-1",
  );

  expect(asked).toEqual(["org-1"]);
  expect(resolved.steps.map((s) => s.done)).toEqual([true, false]);
  expect(resolved.remaining).toBe(1);
});

/**
 * The case the whole design exists for.
 *
 * A business that has been running for months buys the Shop today. Everything
 * it already has counts, and the list opens showing only what is genuinely
 * left — not three steps it did last year.
 */
test("a module added long after the work shows that work as done", async () => {
  const resolved = await resolveGuide(
    guide([
      { id: "a", label: "Add a customer", done: async () => true },
      { id: "b", label: "Set your address", done: async () => true },
      { id: "c", label: "Connect a card processor", done: async () => false },
    ]),
    "org-1",
  );

  expect(resolved.remaining).toBe(1);
  expect(resolved.steps.find((s) => s.id === "c")?.done).toBe(false);
});

/**
 * A module that cannot count itself is a module with a bug.
 *
 * The right answer is a step that stays on the list — not an onboarding screen
 * that fails to load, taking every other module's steps with it.
 */
test("a step that throws is not done, and does not take the guide with it", async () => {
  const resolved = await resolveGuide(
    guide([
      {
        id: "broken",
        label: "Add a product",
        done: async () => {
          throw new Error("the table is gone");
        },
      },
      { id: "fine", label: "Set a price", done: async () => true },
    ]),
    "org-1",
  );

  expect(resolved.steps.map((s) => s.done)).toEqual([false, true]);
});

/** Advice has no row behind it, so it is never shown as done. */
test("a step with nothing to ask stays on the list", async () => {
  const resolved = await resolveGuide(
    guide([{ id: "read", label: "Read how tax is applied per line" }]),
    "org-1",
  );

  expect(resolved.steps[0]?.done).toBe(false);
  expect(resolved.remaining).toBe(1);
});

/**
 * Registering the same id twice replaces rather than duplicates.
 *
 * The host loads modules more than once in one process during the boot tests,
 * and a checklist showing every step twice is the symptom.
 */
test("a guide registered twice appears once", () => {
  addOnboarding(guide([{ id: "a", label: "One" }]));
  addOnboarding(
    guide([
      { id: "a", label: "One" },
      { id: "b", label: "Two" },
    ]),
  );

  expect(allOnboarding()).toHaveLength(1);
  expect(allOnboarding()[0]?.steps).toHaveLength(2);
});
