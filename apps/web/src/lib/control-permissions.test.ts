import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sourceFiles } from "@sentrello/module-sdk";
import {
  controlsFiringMutations,
  guardedRoutes,
  needsFor,
} from "@sentrello/module-sdk/control-permissions";

/**
 * A control that writes, in front of a route that asks for a permission,
 * with nothing saying so on the control.
 *
 * The sidebar has been permission-aware for a while. Inside a screen nothing
 * was, so a bookkeeper met the owner's Delete and found out from a 403. Three
 * hundred and fourteen controls across the product were given the permission
 * their own route asks for; this is what stops the next one being added
 * without it.
 *
 * **The answer is derived, never judged.** Every one of these is written down
 * at the route already, and a screen copying `requirePermission`'s own line
 * is far likelier to be right than one translating it. What the SDK's
 * resolver adds is getting the two hard parts right — the declaration in
 * scope rather than the first of that name, and the route with the matching
 * method rather than the first with that path. Both were got wrong three
 * times before they were written down.
 *
 * **Reads are not gated.** Disabling a control because somebody lacks `read`
 * on a screen they are already looking at is nonsense, and the nav has
 * already decided whether they see the screen at all.
 */
const WEB = join(import.meta.dir, "..");
const ROOT = join(WEB, "..", "..", "..");

const routes = [
  ...sourceFiles(join(ROOT, "packages"), [".ts"]),
  ...sourceFiles(join(ROOT, "apps", "server", "src"), [".ts"]),
]
  .filter((path) => !path.includes(".test."))
  .flatMap((path) => guardedRoutes(readFileSync(path, "utf8")));

test("there are routes and screens to check", () => {
  // Either matching nothing would pass the assertion below it — which is how
  // a walk comes to be green over a directory it cannot see.
  expect(routes.length).toBeGreaterThan(50);
  expect(sourceFiles(WEB, [".tsx"]).length).toBeGreaterThan(20);
});

/**
 * How much of its own subject this guard can actually see.
 *
 * Not a theoretical worry. On 25 September the resolver matched one line at a
 * time, and a handler is rarely one line — `onClick={() =>` sits above
 * `save.mutate({` wherever the arguments are an object. It reported zero
 * ungated writes in three repositories while blind to a fifth of the
 * controls, and the gaps it was hiding included who a group's policies are
 * and the two-factor rules. Every assertion in this file was green throughout.
 *
 * So the coverage is pinned as well as the result. Every `.mutate(` in a
 * screen is either a control's own handler or a call from somewhere else —
 * an effect, a callback handed to a child — and the second kind is the
 * minority. Today the resolver accounts for 172 of 198; the version this
 * replaced managed 142. A drop means the matching narrowed again, which is a
 * fact worth a morning even when nothing else has changed.
 */
test("the resolver still sees most of the writes in the tree", () => {
  let controls = 0;
  let callSites = 0;
  for (const path of sourceFiles(WEB, [".tsx"])) {
    if (path.includes(".test.")) continue;
    const source = readFileSync(path, "utf8");
    controls += controlsFiringMutations(source).length;
    callSites += (source.match(/\.mutate\(/g) ?? []).length;
  }
  expect(callSites).toBeGreaterThan(100);
  // 0.87 today, 0.72 the day this was written. The floor sits between them
  // with room, so a real refactor does not trip it and a regression does.
  expect([controls, callSites, controls / callSites > 0.8]).toEqual([
    controls,
    callSites,
    true,
  ]);
});

test("every control that writes says which permission it needs", () => {
  const bare: string[] = [];
  for (const path of sourceFiles(WEB, [".tsx"])) {
    if (path.includes(".test.")) continue;
    for (const control of controlsFiringMutations(readFileSync(path, "utf8"))) {
      const needs = needsFor(control, routes);
      if (!needs || control.gated) continue;
      if (/\["read"\]$/.test(needs)) continue;
      bare.push(
        `${path.slice(ROOT.length + 1)}:${control.line}: \`${control.mutation}\` calls ${control.method} ${control.path}, which asks for { ${needs} }. Add needs={{ ${needs} }}.`,
      );
    }
  }
  expect(bare).toEqual([]);
});
