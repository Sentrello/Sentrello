import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_WIDGETS } from "./layout";

/**
 * A panel's permission is worth nothing if the feed behind it has none.
 *
 * `/api/dashboard` answered every figure to anybody holding
 * `dashboard: ["read"]` — which the seeded staff, marketing and customers
 * policies all do, and none of which grants bookkeeping. That was fixed by
 * asking the reader before working anything out.
 *
 * Four hours later the same defect turned up one screen down.
 * `/api/dashboard/insights` is the feed the charts are drawn from: twelve
 * months of profit and loss straight off the ledger, the pipeline by stage
 * and value, the aged debt, and the top five customers **by name against what
 * each has spent**. Gated by `dashboard: ["read"]` and nothing else. The
 * panels had been given their permissions and the thing that fills them had
 * not, which is the whole failure in one sentence.
 *
 * So: every route in this module that answers with a figure asks `mayAccess`
 * first, and every widget declares what it needs. Read as text, because what
 * is being checked is that the question is asked at all.
 */

const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");

/** Routes here that answer with data rather than only writing a preference. */
const ANSWERS_WITH_FIGURES = ["/api/dashboard", "/api/dashboard/insights"];

test.each(ANSWERS_WITH_FIGURES)("%s asks who is reading", (path) => {
  const at = source.indexOf(`"${path}",`);
  expect(at, `${path} is not registered here any more`).toBeGreaterThan(0);

  // The handler, to the next registration or the end.
  const next = source.indexOf("ctx.app.", at + 1);
  const handler = source.slice(at, next === -1 ? undefined : next);

  expect(
    handler.includes("mayAccess("),
    `${path} answers with figures and never asks what this reader may see — the permission on the route is the widest in the product`,
  ).toBe(true);
});

/**
 * And every panel says what it needs.
 *
 * `requires: undefined` is how the money, the attention list, the pipeline
 * and the twelve-month charts came to be offered to everybody: not a wrong
 * permission, an absent one. A widget that genuinely is for everybody says so
 * by naming `dashboard: ["read"]`, which is a decision somebody wrote down
 * rather than a field nobody filled in.
 */
test("every core widget declares a permission", () => {
  expect(CORE_WIDGETS.length).toBeGreaterThan(5);
  const silent = CORE_WIDGETS.filter((w) => !w.requires).map((w) => w.id);
  expect(
    silent,
    "these are offered to anybody who can open the dashboard, which includes the seeded customers policy",
  ).toEqual([]);
});
