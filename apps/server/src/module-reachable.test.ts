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
 *
 * Every entry below appeared the day this comparison started including the
 * HTTP method. Until then a screen that fetched a path made every other verb
 * on it look reached, which is why the list was empty and wrong: almost all of
 * these are a **delete** or an **edit**, because screens get built for the
 * happy path and the destructive half is left as a route with no button.
 */
const KNOWN_GAPS: Record<string, string[]> = {
  accounting: [
    // No screen deletes an account: the chart can be added to and renamed,
    // and a mistake stays in it for ever.
    "DELETE /api/accounts/:id",
    // The presets are applied blind. Nothing lists them first, so a business
    // picks its tax rates without being shown what it is about to get.
    "GET /api/accounting/taxes/presets",
    // A balance per account, fetched by nothing anywhere in the platform.
    "GET /api/accounts/balances",
    // A transaction can be created and deleted but never corrected, so fixing
    // a typo means deleting the entry and its journal lines and retyping it.
    "PATCH /api/transactions/:id",
  ],
  settings: [
    // A business can connect a payment provider and cannot disconnect one.
    "DELETE /api/payments/accounts/:provider/:mode",
  ],
};

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
