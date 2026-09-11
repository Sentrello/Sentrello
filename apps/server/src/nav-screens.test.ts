import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every page in the sidebar has something to draw.
 *
 * A nav entry whose id nothing registered renders an empty panel — no error,
 * no clue, just a blank page under a working-looking link. It is invisible to
 * every test that talks to the API, because the API is fine: the hole is
 * between a module's nav and the screens the web app registers, and those two
 * are written in different packages by different halves of a change.
 *
 * The commercial repositories have had this check since a module shipped with
 * three doors onto nothing. Core did not, which is the gap this closes — it
 * finds nothing today, and that is what a guard is for.
 *
 * Read from source rather than imported: `App.tsx` is a browser bundle and
 * pulls in every screen in the product, which a server test cannot load.
 */
const root = join(import.meta.dir, "../../..");

/**
 * Nav ids a module registers, however the call is written.
 *
 * Matching the `id`/`label` pair rather than the `registerNav(` around it, for
 * the reason the Modules copy of this learned the hard way: an earlier version
 * understood two call shapes, missed a third, and quietly checked six fewer
 * pages than the module had. A guard that narrows its own scope is worse than
 * none, because it reports success.
 */
function navEntries(source: string): { id: string; parent: string | null }[] {
  const found: { id: string; parent: string | null }[] = [];
  for (const m of source.matchAll(
    /id:\s*"([a-z0-9-]+)"\s*,\s*label:\s*"[^"]*"([\s\S]{0,220}?)(?=\bid:\s*"|\}\s*\)\s*;)/g,
  )) {
    const id = m[1] as string;
    const parent = /\bparent:\s*"([a-z0-9-]+)"/.exec(m[2] ?? "");
    found.push({ id, parent: parent?.[1] ?? null });
  }
  return found;
}

/**
 * The ids a nav entry can open — `SCREENS`, and deliberately not
 * `RECORD_SCREENS`.
 *
 * `App.tsx` reaches for the record screen only when a record id is carried,
 * and a sidebar entry carries none. Reading both registries made this test
 * pass while `contacts` was deleted from `SCREENS`, because the detail view
 * still named it — which is a blank page under a working-looking link, the
 * exact thing this exists to catch.
 */
function registeredScreens(): Set<string> {
  const app = readFileSync(join(root, "apps/web/src/App.tsx"), "utf8");
  const from = app.indexOf("const SCREENS");
  if (from === -1) return new Set();
  const block = app.slice(from, from + app.slice(from).indexOf("};"));
  return new Set(
    [...block.matchAll(/["']?([a-z0-9-]+)["']?\s*:/g)].map(
      (m) => m[1] as string,
    ),
  );
}

const modules = readdirSync(join(root, "packages/modules-free")).filter(
  (name) =>
    existsSync(join(root, "packages/modules-free", name, "src/index.ts")),
);

test("there are modules and screens to check", () => {
  // A glob or a renamed registry that matched nothing would pass every
  // assertion below it without looking at one thing.
  expect(modules.length).toBeGreaterThan(3);
  expect(registeredScreens().size).toBeGreaterThan(20);
});

test.each(modules)("%s: every nav entry has a screen", (name) => {
  const source = readFileSync(
    join(root, "packages/modules-free", name, "src/index.ts"),
    "utf8",
  );
  const entries = navEntries(source);
  if (!entries.length) return;

  /**
   * A section is not a page.
   *
   * `crm` holds five entries and draws nothing itself — opening it opens its
   * dashboard. Derived from the children rather than written down as an
   * exception, so the next module to group its pages needs no edit here, and
   * a section that loses its last child stops being excused.
   */
  const sections = new Set(
    entries.map((e) => e.parent).filter((p): p is string => Boolean(p)),
  );
  const screens = registeredScreens();

  expect(
    entries
      .filter((e) => !sections.has(e.id) && !screens.has(e.id))
      .map((e) => e.id),
  ).toEqual([]);
});

/**
 * A section does not ask for a bundle that does not exist.
 *
 * `/api/_meta` already lists the modules whose screens this instance can serve,
 * and nothing read it. So opening a section that draws nothing itself — the
 * CRM's own entry, Shop's, Settings' — asked the server for a script that was
 * never built: a 404 in plain text, which the browser refuses on MIME grounds
 * and writes to the console twice.
 *
 * It failed no test that talks to the API, because the API was right to say no.
 * It failed the end-to-end suite, on every screen, for thirty runs — and a
 * suite that has been red for thirty runs is a suite nobody reads.
 */
test("the web app only asks for screens the instance says it has", () => {
  const app = readFileSync(join(root, "apps/web/src/App.tsx"), "utf8");
  // The instance's own list reaches the component that decides whether to ask.
  expect(app).toContain("withScreens");
  expect(app).toMatch(/shipsScreens=\{withScreens\.includes\(/);

  const screen = readFileSync(
    join(root, "apps/web/src/routes/module-screen.tsx"),
    "utf8",
  );
  // And the component refuses to ask when the answer is already known.
  expect(screen).toMatch(/if \(shipsScreens === false\)/);
});
