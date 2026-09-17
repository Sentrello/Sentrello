import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as uiDrift from "@sentrello/module-sdk/ui-drift";

/**
 * Every drift scanner the SDK exports, run over Core's own screens.
 *
 * Read off the module rather than listed here, and that is the whole point.
 * The modules repository had nine hand-written copies of this idea and they
 * had quietly drifted into three different tests: seven ran one scanner, two
 * ran only another, and none ran the two newest — including the one written
 * to catch a dropped "showing 12 of 6,000" notice, which was therefore not
 * running anywhere. It found a sixth customer picker the moment it did.
 *
 * Core held the fifth copy of that pattern. Reading `Object.entries` instead
 * means a scanner added to the SDK tomorrow runs here tomorrow, unedited —
 * and one of a different shape throws and names itself rather than being
 * skipped in silence.
 *
 * Core is scanned at all because Core holds itself to what it asks of
 * modules: the pass that produced these found Core hand-rolling a tab strip
 * while the shared one sat in the file it imports from.
 *
 * What they are looking for, since nothing here names them any more:
 * `findHandRolledUi` catches a screen rebuilding a primitive.
 * `findFillAsText` catches a fill token written where text expects one — one
 * of those in `ui.tsx`'s status badge put a failing colour on every screen
 * showing an invoice. `findUnpagedList` catches a screen asking a capped
 * endpoint for everything, which is how five customer pickers offered the
 * first thousand rows and the invoice form failed to find a company and
 * charged no tax. `findDroppedNotice` catches the half that looks correct: a
 * screen that paged properly, was handed a finished sentence saying what had
 * been cut, and rendered the rows without it.
 */
const ROUTES = join(import.meta.dir, "..", "routes");
const LIB = import.meta.dir;

/**
 * Scanners that cannot be pointed at `lib/`, because `lib/` is where the
 * primitive they recommend is *defined*. `findHandRolledUi` recognises a tab
 * strip; `ui.tsx` contains the only one that should exist.
 */
const ROUTES_ONLY = new Set(["findHandRolledUi"]);

function screens(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return screens(path);
    return entry.name.endsWith(".tsx") && !entry.name.includes(".test.")
      ? [path]
      : [];
  });
}

const scanners = Object.entries(uiDrift).filter(([name]) =>
  name.startsWith("find"),
);

test("no Core screen drifts from what the SDK asks of a module", () => {
  // A rename that left nothing matching would pass this file silently.
  expect(scanners.length).toBeGreaterThan(3);

  const found: string[] = [];
  for (const [name, scan] of scanners) {
    if (typeof scan !== "function" || scan.length !== 1) {
      throw new Error(
        `${name} is exported from ui-drift but is not a scanner of one source — either give it that shape or rename it so it is not picked up here`,
      );
    }
    const tree = ROUTES_ONLY.has(name)
      ? screens(ROUTES)
      : [...screens(ROUTES), ...screens(LIB)];
    for (const path of tree) {
      for (const { line, say } of scan(readFileSync(path, "utf8"))) {
        found.push(`${name} — ${path.split("/apps/web/")[1]}:${line}: ${say}`);
      }
    }
  }
  expect(found).toEqual([]);
});
