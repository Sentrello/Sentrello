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
 * These twelve appeared the day the sweep learned to read routes registered
 * from a **template**. `ctx.app.get(`/api/${path}`, …)` inside a generic CRUD
 * helper, and `/api/${kind}/:id/share` inside a loop over two kinds: forty
 * routes across the CRM, accounting and invoicing that no sweep had ever
 * looked at, and nothing said so.
 *
 * Like the five before them, almost all are a **delete** — screens get built
 * for the happy path and the destructive half is left as a route with no
 * button.
 */
const KNOWN_GAPS: Record<string, string[]> = {
  // Sorted, because that is how they come back. The reasons are grouped in
  // the comment rather than beside each line, so the order can stay.
  //
  // What is left after the screens were written, and why each stays.
  //
  // `DELETE /api/tags/:id` is the generic helper's delete, superseded by
  // `/api/crm/tags/:id` — which is what the settings screen calls, because it
  // answers with how many records the tag came off. Two ways to delete a tag
  // is one more than anybody needs.
  //
  // The two whole-business lists are `crud()` registering `GET /api/<resource>`
  // for everything in its table. For these two the record's own history is the
  // screen: an unordered, unpaged list of every note in the business answers
  // no question anybody has. Making the helper skip them was tried and
  // reverted — the sweep reads source text and cannot see a runtime `if`, so
  // the route would have vanished from the product and stayed in this list,
  // which is worse than an honest gap.
  //
  // Editing and deleting a logged activity is the one real gap left: a call
  // can now be recorded, and a call recorded against the wrong customer has to
  // stay. Worth a screen; not worth inventing one badly at the end of a long
  // day.
  crm: [
    "DELETE /api/activities/:id",
    "DELETE /api/tags/:id",
    "GET /api/activities",
    "GET /api/notes",
    "PATCH /api/activities/:id",
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
