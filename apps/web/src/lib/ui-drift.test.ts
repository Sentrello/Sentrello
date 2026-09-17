import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  findDroppedNotice,
  findFillAsText,
  findHandRolledUi,
  findUnpagedList,
} from "@sentrello/module-sdk/ui-drift";

/**
 * Core holds itself to what it asks of modules.
 *
 * The pass that produced this found Core hand-rolling a tab strip while the
 * shared one sat in the same file it imports from — so "modules drifted" was
 * never the accurate description, and a guard over modules alone would have
 * been the wrong shape.
 */
const ROUTES = join(import.meta.dir, "..", "routes");

function screens(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return screens(path);
    return entry.name.endsWith(".tsx") && !entry.name.includes(".test.")
      ? [path]
      : [];
  });
}

test("no Core screen builds what a primitive already covers", () => {
  const found: string[] = [];
  for (const path of screens(ROUTES)) {
    for (const { line, say } of findHandRolledUi(readFileSync(path, "utf8"))) {
      found.push(`${path.split("/apps/web/")[1]}:${line}: ${say}`);
    }
  }
  expect(found).toEqual([]);
});

/**
 * Both trees, because the shared components are where this bug did the most
 * damage: one fill-as-text in `ui.tsx`'s status badge put a failing colour on
 * every screen that showed an invoice. `theme-contrast.test.ts` keeps the
 * token *values* over the line; this keeps screens writing the right tokens.
 */
test("no Core screen writes a fill token as text", () => {
  const found: string[] = [];
  for (const path of [...screens(ROUTES), ...screens(import.meta.dir)]) {
    for (const { line, say } of findFillAsText(readFileSync(path, "utf8"))) {
      found.push(`${path.split("/apps/web/")[1]}:${line}: ${say}`);
    }
  }
  expect(found).toEqual([]);
});

/**
 * The silence this closes.
 *
 * `/api/contacts` and `/api/companies` cap an unpaged answer at a thousand
 * rows and say `truncated: true`. Nothing on any screen read it, so five
 * customer pickers offered the first thousand, the invoice form failed to
 * find a company and charged no tax, and two audit tabs showed part of a
 * history as though it were all of it. Every one of them looked correct on
 * any dataset a developer has, which rules out a runtime warning: this has to
 * be answerable from the source, on every commit, at every row count.
 *
 * Both trees, because the shared components fetch too — `RecordPicker` is
 * where four of those pickers now go.
 */
test("no Core screen reads a capped list without paging it", () => {
  const found: string[] = [];
  for (const path of [...screens(ROUTES), ...screens(import.meta.dir)]) {
    for (const { line, say } of findUnpagedList(readFileSync(path, "utf8"))) {
      found.push(`${path.split("/apps/web/")[1]}:${line}: ${say}`);
    }
  }
  expect(found).toEqual([]);
});

/**
 * And the half of it that looks correct.
 *
 * The test above catches a screen asking for a capped list whole. This catches
 * one that asked for a page properly, was handed a finished sentence saying
 * what had been cut, and rendered twelve names without it — which is what the
 * dashboard's "Who owes you" panel did on the day the receivables report was
 * paged, and which is invisible on any dataset small enough to fit.
 */
test("no Core screen drops the notice a paged report hands it", () => {
  const found: string[] = [];
  for (const path of [...screens(ROUTES), ...screens(import.meta.dir)]) {
    for (const { line, say } of findDroppedNotice(readFileSync(path, "utf8"))) {
      found.push(`${path.split("/apps/web/")[1]}:${line}: ${say}`);
    }
  }
  expect(found).toEqual([]);
});
