import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A suite that fills a process-wide registry empties it again.
 *
 * Every `add*` here writes into one module-scope array, and Bun runs the whole
 * repository's tests in one process. So a registration the last case in a file
 * makes outlives the file: the account suite left behind a section whose `load`
 * throws on purpose, and the next suite to render an account page got a module
 * it never registered. That was one red CI run, failing in a file with nothing
 * to do with it, and two suites had already grown a defensive clear on the way
 * *in* rather than anybody fixing the way out.
 *
 * The production loader clears all ten at every load, which is why this has
 * never reached a customer. This is about the test process only.
 *
 * **`afterEach` counts.** It runs after the last case as well, so a file that
 * clears per case is already clean — the first version of this sweep looked
 * only inside `afterAll` and called `computed-columns.test.ts` a leak.
 */
const WRITERS: Record<string, string> = {
  "addAccountSection(": "clearAccountSections",
  addComputedColumn: "clearComputedColumns",
  "addCrawlable(": "clearCrawlable",
  "addOnboarding(": "clearOnboarding",
  "addPersonalData(": "clearPersonalData",
  "addSearchProvider(": "clearSearchProviders",
  "addSummary(": "clearSummaries",
  "addWidget(": "clearWidgets",
};

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith("."))
      continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) testFiles(path, out);
    else if (/\.test\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

/** The body of every `afterAll(...)` and `afterEach(...)` in a file. */
function afterwards(source: string): string {
  let out = "";
  for (const hook of ["afterAll", "afterEach"]) {
    let at = source.indexOf(`${hook}(`);
    while (at !== -1) {
      // To the end of the file is enough: this is asking whether a name appears
      // after the hook opens, not parsing the call.
      out += source.slice(at, source.indexOf("\n});", at) + 4);
      at = source.indexOf(`${hook}(`, at + 1);
    }
  }
  return out;
}

test("a suite that fills a shared registry empties it afterwards", () => {
  const root = join(import.meta.dir, "..", "..", "..");
  const files = testFiles(join(root, "packages")).concat(
    testFiles(join(root, "apps")),
  );
  // An empty corpus would pass, which is the one way a sweep like this lies.
  expect(files.length).toBeGreaterThan(100);

  const leaks: string[] = [];
  for (const file of files) {
    // This file names every writer in a table and must not accuse itself.
    if (file === import.meta.path) continue;
    const source = readFileSync(file, "utf8");
    const after = afterwards(source);
    for (const [writer, clearer] of Object.entries(WRITERS)) {
      if (!source.includes(writer)) continue;
      // A file that clears per case, or hands a clearing function to a hook,
      // is clean either way.
      if (after.includes(clearer) || after.includes("clearAll")) continue;
      leaks.push(
        `${file.slice(root.length + 1)} calls ${writer} and never ${clearer}()`,
      );
    }
  }

  expect(leaks.join("\n"), leaks.join("\n")).toBe("");
});
