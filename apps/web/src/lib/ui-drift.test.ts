import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  findFillAsText,
  findHandRolledUi,
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
