import { expect, test } from "bun:test";
import { type CrmSettings, isDecided } from "./crm-settings";

/**
 * Whether a deal is finished, by the business's own names for finished.
 *
 * Three screens answered this by hand — the board's pipeline total, a
 * contact's open deals and a deal's own header — each writing `stage !==
 * "won" && stage !== "lost"` while already holding the settings that say
 * otherwise. A roofer whose board runs quote → measured → scheduled →
 * **invoiced** saw every finished job counted as still in play, on the screen
 * where it matters most.
 */
const settings = (won: string[], lost: string[]): CrmSettings => ({
  dealStages: [],
  wonStages: won,
  lostStages: lost,
  taskTypes: [],
  contactStatuses: [],
  dealCategories: [],
  companySectors: [],
  customFields: [],
  usingDefaults: false,
});

test("the default names still read as finished", () => {
  const s = settings(["won"], ["lost"]);
  expect(isDecided(s, "won")).toBe(true);
  expect(isDecided(s, "lost")).toBe(true);
  expect(isDecided(s, "proposal")).toBe(false);
});

test("a business's own names are what count", () => {
  const s = settings(["invoiced"], ["no-budget", "gone-quiet"]);
  expect(isDecided(s, "invoiced")).toBe(true);
  expect(isDecided(s, "gone-quiet")).toBe(true);
  // And the words we happen to use are not special to anybody else.
  expect(isDecided(s, "won")).toBe(false);
  expect(isDecided(s, "measured")).toBe(false);
});

test("more than one stage can mean won", () => {
  // The dashboard matched a single stage by name and reported one of two.
  const s = settings(["invoiced", "paid"], ["lost"]);
  expect(isDecided(s, "invoiced")).toBe(true);
  expect(isDecided(s, "paid")).toBe(true);
});

test("a business that has decided nothing is finished has everything open", () => {
  const s = settings([], []);
  expect(isDecided(s, "won")).toBe(false);
  expect(isDecided(s, "anything")).toBe(false);
});
