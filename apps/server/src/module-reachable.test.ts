import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { sourceFiles, unreachableRoutes } from "@sentrello/module-sdk";

/**
 * Every route a person is meant to use has something that calls it.
 *
 * The gates test asks whether a route refuses the wrong person. This asks the
 * question underneath it: whether anybody can get to the route at all. A route
 * is written, tested, gated correctly, and described in the plan as built — and
 * no screen ever calls it. Every test passes, because every test talks to the
 * API, and the API is right. The feature does not exist, because a customer
 * cannot reach it, and the notes say it is done so nobody looks again.
 *
 * Found by hand in four of the commercial modules before it was worth
 * automating, and the first run here found seven more in Free. The matching
 * itself lives in `@sentrello/module-sdk` so that both repositories use one
 * implementation: a second copy is a copy that gets the comparison subtly
 * wrong in one repository only.
 */

const root = join(import.meta.dir, "../../..");
const screens = sourceFiles(join(root, "apps/web/src"), [".ts", ".tsx"]);

const modules = readdirSync(join(root, "packages/modules-free")).filter(
  (name) => {
    try {
      return readdirSync(join(root, "packages/modules-free", name)).includes(
        "src",
      );
    } catch {
      return false;
    }
  },
);

/**
 * Routes something other than a screen reaches.
 *
 * Each entry says what does call it. Excusing a route falsely is how a module
 * comes back clean with a dead feature in it, which is the one way this test
 * can do harm.
 */
const CALLED_BY_SOMETHING_ELSE: Record<string, string> = {
  // Kept working on purpose. Its own comment: the endpoint predates the
  // module and is what a customer's own scripts call, so it stays rather than
  // becoming a second way to write the books. The screens use
  // `/api/transactions`.
  "/api/expenses": "a customer's own scripts, from before the module",
};

/**
 * Built, reachable from nothing, and not yet fixed.
 *
 * Asserted **exactly**, so it is a ratchet rather than an excuse: a newly
 * unreachable route fails this test, and so does fixing one of these without
 * deleting its line. A list that only ever grows is a list nobody reads.
 */
const KNOWN_GAPS: Record<string, string[]> = {};

test.each(modules)("%s: every route has a caller", (name) => {
  const unreachable = unreachableRoutes({
    routeFiles: sourceFiles(join(root, "packages/modules-free", name, "src"), [
      ".ts",
    ]),
    screenFiles: screens,
    calledByOther: CALLED_BY_SOMETHING_ELSE,
  });

  expect(unreachable).toEqual(KNOWN_GAPS[name] ?? []);
});
