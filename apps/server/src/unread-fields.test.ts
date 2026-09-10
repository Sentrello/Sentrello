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
    /*
     * The widget connection path, and the only gap here that is a decision
     * rather than an oversight.
     *
     * A provider that hosts its own page hands back a redirect and the browser
     * never sees a public token. One that uses a widget gives the token to the
     * browser, and loading a third party's script into the application a
     * business keeps its books in would give that script the run of every page
     * — which `banking/provider.ts` argues against at length, and this is the
     * branch that would receive the result.
     *
     * So it stays unreachable on purpose. What changed on 2026-09-09 is that
     * the screen no longer offers a Connect button that throws afterwards:
     * `hostedConnection` is a declared capability now, and a provider that
     * needs a window says so before anybody clicks. Do not close this gap by
     * loading the widget.
     */
    "src/bank-feeds.ts: publicToken",
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
