import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import account from "@sentrello/module-account";
import accounting from "@sentrello/module-accounting";
import archive from "@sentrello/module-archive";
import crm from "@sentrello/module-crm";
import dashboard from "@sentrello/module-dashboard";
import invoicing from "@sentrello/module-invoicing";
import profile from "@sentrello/module-profile";
import {
  createModuleApp,
  exceptedAbove,
  registerForTest,
  sourceFiles,
  stripComments,
} from "@sentrello/module-sdk";
import {
  controlsFiringMutations,
  declaredRoutes,
  guardedRoutes,
  needsFor,
} from "@sentrello/module-sdk/control-permissions";
import settings from "@sentrello/module-settings";
import users from "@sentrello/module-users";

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
/*
 * It reads the web app from disk and imports the modules from here.
 *
 * It lived under `apps/web` and moved on 26 September, when the route table
 * stopped being scanned out of the source and started being asked of a real
 * app: that needs every Free module imported, and the browser bundle has no
 * business depending on nine server modules to satisfy one test. The screens
 * it checks are still read by path, which needs no dependency at all.
 */
const ROOT = join(import.meta.dir, "..", "..", "..");
const WEB = join(ROOT, "apps", "web", "src");

/**
 * The routes this instance actually registers, asked of the app itself.
 *
 * This used to read every server file with a regular expression, and that
 * worked until a module generated its routes. The CRM builds contacts,
 * companies, deals, tasks, tags, notes and activities from one template with
 * a computed permission key, so the scanner resolved **none** of the seven
 * biggest record types in the product — and the test below only speaks when
 * it can resolve a route, so every ungated write on every one of those
 * screens passed in silence. That is how New contact came to be offered to
 * somebody holding `read` and nothing else.
 *
 * `requirePermission` tags the middleware it returns and Hono lists what it
 * has registered, so `declaredRoutes` reads the table the server enforces
 * rather than guessing at the code that built it. The scan stays beside it:
 * a route a module registers only under a licence this test does not hold is
 * still in the source, and two readings that disagree is the shape this
 * project has been caught by before.
 */
const app = [
  account,
  accounting,
  archive,
  crm,
  dashboard,
  invoicing,
  profile,
  settings,
  users,
].reduce((acc, module) => registerForTest(module, acc), createModuleApp());

const scanned = [
  ...sourceFiles(join(ROOT, "packages"), [".ts"]),
  ...sourceFiles(join(ROOT, "apps", "server", "src"), [".ts"]),
]
  .filter((path) => !path.includes(".test."))
  .flatMap((path) => guardedRoutes(readFileSync(path, "utf8")));

const registered = declaredRoutes(app);

const routes = [...registered, ...scanned];

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
 * minority. Today the resolver accounts for 179 of 198; the version this
 * replaced managed 142. A drop means the matching narrowed again, which is a
 * fact worth a morning even when nothing else has changed.
 *
 * It has already earned the second figure. Widening it again to take `onBlur`
 * — a field saved when it is left rather than when something is pressed —
 * moved it from 172 to 179 and turned up ten more ungated writes, among them
 * every box on the password policy.
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
  // 0.90 today, 0.72 the day this was written. The floor sits between them
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

/**
 * Every write that still carries no permission, counted.
 *
 * The test above only speaks when it can resolve the route a control calls,
 * and some paths cannot be resolved by any table: the tag controls and the
 * receipt controls build their path from a holder, so what they call is not
 * known until it runs. Those ask `may` directly instead, which this scanner
 * counts as gated.
 *
 * What is left over is the honest remainder, and counting it is what stops
 * the next one arriving unnoticed.
 *
 * So this counts instead of resolving. Thirteen today, down from
 * twenty-eight, and **every one of the thirteen is right** — checked against
 * what its own route asks for:
 *
 * - Your profile: your email, your password, your sessions, your
 *   preferences. Nobody else permits those.
 * - Your saved views, your dashboard arrangement, and whether the onboarding
 *   panel is showing. All three routes ask for `read`.
 * - The evidence pack, the privacy export and a customer's portal link. Each
 *   is a POST because it makes a file, and each route asks for `read`.
 *
 * So the number is not a backlog any more; it is the shape of what should
 * never carry a permission. It may not grow.
 *
 * It is a ceiling rather than a floor because the direction is known. A new
 * screen that writes without saying what it needs pushes it up and fails
 * here, which is the whole point; gating one pushes it down, and the ceiling
 * comes down with it in the same commit.
 */
test("no new write arrives without a permission on it", () => {
  let bare = 0;
  let gated = 0;
  for (const path of sourceFiles(WEB, [".tsx"])) {
    if (path.includes(".test.")) continue;
    for (const control of controlsFiringMutations(readFileSync(path, "utf8"))) {
      // A read needs nothing, and the resolver calls a request it cannot
      // read a verb for a write — which is the safe way round.
      if (control.method === "GET") continue;
      if (control.gated) gated += 1;
      else bare += 1;
    }
  }
  // Both numbers, so a refactor that stops the scanner seeing anything at
  // all fails here rather than reporting zero ungated writes and passing.
  expect([gated > 160, bare <= 13]).toEqual([true, true]);
});

/**
 * A row menu's items are `MenuItem`, not a button wearing its class.
 *
 * Only the primitive can be refused: `needs` is its prop, and a bare
 * `<button className="menu-item">` has nowhere to put one. Nine of them were
 * live for a read-only role on 26 September — four on a task, four on a deal
 * and one on a quote — and every one was invisible to the scanner above,
 * because a menu built in a loop has one handler for however many items it
 * draws and that handler calls a prop rather than a mutation.
 *
 * The exceptions are the ones that are not about permission at all: the
 * account menu goes to your own profile, to the settings screen and out of
 * the application, and an embed code is a tag to paste. Those are listed by
 * hand rather than excused by a rule, so adding to the list is a decision
 * somebody makes on purpose.
 */
test("a menu item that can be refused is the only kind there is", () => {
  const bare: string[] = [];
  for (const path of sourceFiles(WEB, [".tsx"])) {
    if (path.includes(".test.")) continue;
    const relative = path.slice(ROOT.length + 1);
    /*
     * Comments first. The note in `ui.tsx` explaining why this shape is
     * wrong contains the shape, and a check that reads prose reports the
     * file that documents the rule as the file that breaks it. Twice in one
     * night now — `requestedPaths` had the same fault.
     */
    const raw = readFileSync(path, "utf8").split("\n");
    const lines = stripComments(raw.join("\n")).split("\n");
    lines.forEach((line, i) => {
      // Anchored on the element's own line rather than on the line carrying
      // the class, because that is where a reader looks and where the
      // exception above it has to sit to be read with it.
      if (!/^\s*<button\b/.test(line)) return;
      // A `<span>` wearing the class is a label inside a menu, not a control,
      // and cannot be pressed.
      const tag = lines.slice(i, i + 8).join("\n");
      if (!/className="menu-item/.test(tag)) return;
      /*
       * Excused one line at a time, with the reason on the line above it,
       * rather than a file at a time. A file-level exception excuses
       * everything else in the file — the first draft of this excepted the
       * forms screen for its embed-code item and thereby stopped seeing the
       * two writes beside it, which is the failure the whole test is about.
       */
      if (exceptedAbove(raw, i + 1, "menu-item")) return;
      bare.push(`${relative}:${i + 1}`);
    });
  }
  expect(bare, `\n    ${bare.join("\n    ")}`).toEqual([]);
});
