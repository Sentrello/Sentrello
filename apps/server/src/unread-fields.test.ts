import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sourceFiles, unreadFields } from "@sentrello/module-sdk";

/**
 * Every field a free module accepts can be set from a screen.
 *
 * The route sweeps beside this one ask whether a route is reached. Both are
 * green on a route whose fields nobody can set, because a route is reached by
 * whichever one field the screen does send — Project Management's customer link
 * was unreachable for the module's whole life behind a `PATCH` that the status
 * dropdown called every day.
 *
 * Asserted exactly, so it is a ratchet in both directions: a new unreachable
 * field fails on the day it is written, and fixing one without deleting its
 * line fails just as loudly.
 */
const modules = join(import.meta.dir, "../../../packages/modules-free");
const screens = sourceFiles(join(import.meta.dir, "../../web/src"), [
  ".tsx",
  ".ts",
]);

/** Field names that are noise: a handler's locals, and words every file holds. */
const IGNORE = ["id", "name", "type", "status", "kind", "label", "value"];

/**
 * Written by something that is not one of our screens, and by what.
 *
 * **Find the caller before adding a line here.** Pro's route-level list carried
 * `POST /api/projects/time/invoiced` excused as "the module that raises the
 * invoice" for months — a plausible sentence about a caller that did not exist,
 * which hid the fact that billable hours could not be invoiced at all.
 */
const WRITTEN_ELSEWHERE: Record<string, string> = {};

/**
 * Accepted by a route, reachable from no screen, not yet fixed.
 *
 * Recorded rather than excused. Nobody can set any of these today.
 */
const KNOWN_GAPS: Record<string, string[]> = {
  accounting: [
    // The second connection path, for a provider whose window this screen
    // cannot open — which the screen says itself, in those words, when asked.
    "src/bank-feeds.ts: publicToken",
    // A bank rule that applies to one account rather than all of them.
    "src/bank-rules.ts: bankAccountId",
    "src/contractors.ts: addressLine2",
    // A location dimension, beside the class dimension that does have a screen.
    "src/dimensions.ts: locationId",
    /*
     * Closing a year without locking it. The route's own comment explains that
     * an unlocked closed year is "a balance sheet that stops balancing the
     * moment anybody posts" — so this may be worth deleting rather than
     * exposing. It is here because nobody can reach it either way.
     */
    "src/year-end.ts: lock",
  ],
};

test("there are modules and screens to check", () => {
  // A glob matching nothing passes every assertion below it.
  expect(readdirSync(modules).length).toBeGreaterThan(3);
  expect(screens.length).toBeGreaterThan(10);
});

for (const name of readdirSync(modules, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)) {
  const src = join(modules, name, "src");
  if (!existsSync(src)) continue;

  test(`every field ${name} accepts can be set from a screen`, () => {
    const routes = sourceFiles(src, [".ts"]).filter(
      (f) => !f.endsWith(".test.ts"),
    );
    expect(
      unreadFields({
        routeFiles: routes,
        screenFiles: screens,
        writtenElsewhere: WRITTEN_ELSEWHERE,
        ignore: IGNORE,
      }),
    ).toEqual(KNOWN_GAPS[name] ?? []);
  });
}
