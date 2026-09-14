import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { findHandRolledUi } from "@sentrello/module-sdk/ui-drift";

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
