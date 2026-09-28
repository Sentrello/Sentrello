import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sourceFiles } from "@sentrello/module-sdk";
import * as uiDrift from "@sentrello/module-sdk/ui-drift";

/**
 * Every drift scanner the SDK exports, run over everything Core draws.
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
 * been cut, and rendered the rows without it. `findUnthemedElevation` catches
 * a surface that chose its own black shadow, which the dark theme cannot show.
 */
const LIB = import.meta.dir;
const WEB = join(LIB, "..");
const ROOT = join(WEB, "..", "..", "..");

/**
 * The three populations, and which scanners each is under.
 *
 * Which is which is the SDK's answer, not this file's: `scannersFor` reads the
 * scope each scanner declares. A repository asking "which of your scanners
 * apply to server-rendered output?" is the arrangement that survives; a
 * repository keeping a list of exceptions to scanners defined elsewhere is
 * the one that goes stale, and did.
 *
 * `react` is the SPA: screens the host renders, every primitive an import
 * away. `styles` is Core's stylesheet, where the elevation and colour rules
 * are stated — scanned because nine module stylesheets went unread for
 * exactly as long as nobody pointed a walk at `.css`, and the defect the
 * elevation rule exists for was in one of them. `page` is what Core's free
 * modules write for somebody else's browser: the invoice portal, the shared
 * quote, the form reply, the claim page — server-side source emitting HTML
 * and CSS as strings, which no drift scan had ever read.
 */
const POPULATIONS: [uiDrift.SourceKind, string[]][] = [
  ["react", sourceFiles(join(WEB, "routes"), [".tsx"])],
  ["styles", sourceFiles(WEB, [".css"])],
  ["page", sourceFiles(join(ROOT, "packages", "modules-free"), [".ts"])],
];

/**
 * `lib/` is where the primitives `findHandRolledUi` recommends are *defined* —
 * `ui.tsx` holds the only tab strip that should exist — so it is scanned by
 * everything else and not by that one. A definition site, not a scope.
 */
const LIB_FILES = sourceFiles(LIB, [".tsx"]);

test("there are screens, stylesheets, pages and scanners to check", () => {
  // Any of these matching nothing would pass every assertion below it.
  for (const [kind, files] of POPULATIONS) {
    expect([kind, files.length > 0]).toEqual([kind, true]);
    expect([kind, uiDrift.scannersFor(uiDrift, kind).length > 0]).toEqual([
      kind,
      true,
    ]);
  }
  expect(LIB_FILES.length).toBeGreaterThan(0);
  // A rename that left nothing matching would pass this file silently.
  expect(
    Object.keys(uiDrift).filter((name) => name.startsWith("find")).length,
  ).toBeGreaterThan(3);
});

test("no Core screen, stylesheet or page drifts from what the SDK asks of a module", () => {
  const found: string[] = [];
  for (const [kind, files] of POPULATIONS) {
    for (const [name, scan] of uiDrift.scannersFor(uiDrift, kind)) {
      const tree =
        kind === "react" && name !== "findHandRolledUi"
          ? [...files, ...LIB_FILES]
          : files;
      for (const path of tree) {
        for (const { line, say } of scan(readFileSync(path, "utf8"))) {
          found.push(
            `${kind} ${name} — ${path.slice(ROOT.length + 1)}:${line}: ${say}`,
          );
        }
      }
    }
  }
  expect(found).toEqual([]);
});

/**
 * The scope is load-bearing here, not decoration.
 *
 * Core's own server-rendered pages are the same shape the modules repository
 * described: `account/src/index.ts` styles `h2` in its own stylesheet and
 * writes `<h2>` bare, which is how a standalone document is written and is
 * impossible in the app, where every element is reached by class. Run
 * `findHandRolledUi` over that population and it says "use SectionHeading" —
 * an import a string of HTML has no way to take.
 *
 * Asserted both ways round so that widening the scanner's scope fails here
 * with the reason attached, rather than quietly adding non-defects to
 * somebody's ledger until the ledger stops being read.
 */
test("a scanner that needs React is not run over server-rendered pages", () => {
  const pages = POPULATIONS.find(([kind]) => kind === "page")?.[1] ?? [];
  const wouldSay = pages.flatMap((path) =>
    uiDrift.findHandRolledUi(readFileSync(path, "utf8")),
  );
  expect(wouldSay.length).toBeGreaterThan(0);
  expect(uiDrift.scopeOf("findHandRolledUi", uiDrift.findHandRolledUi)).toEqual(
    ["react"],
  );
  expect(
    uiDrift.scannersFor(uiDrift, "page").map(([name]) => name),
  ).not.toContain("findHandRolledUi");
});
