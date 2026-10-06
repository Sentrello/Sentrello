import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Two conditions on a query are joined by `and`, never by `&&`.
 *
 * Drizzle's `eq(a, b)` is an object, and `&&` on two objects is the second one:
 * JavaScript evaluates the first as truthy and discards it. So
 * `.where(eq(table.organizationId, orgId) && eq(table.id, id))` compiles, runs,
 * and silently drops the organisation — worst on a delete, where the condition
 * that goes is the scope.
 *
 * It has happened here before. The pattern is absent from all four repositories
 * today, which is exactly when a guard is cheap to add and worth having: a sweep
 * written after the next one costs an afternoon of finding it first.
 *
 * **Narrow on purpose.** An earlier version flagged any `&&` inside a `.where(`
 * body and was wrong five times out of five — every one was a ternary guarding a
 * spread, `...(x ? [eq(…)] : [])`, which is both correct and the house style. The
 * signal that means the bug is a closing bracket, `&&`, and another condition
 * opening: nothing else produces it.
 */
const JOINED_BY_AND_AND =
  /\)\s*&&\s*(eq|and|or|isNull|isNotNull|inArray|notInArray|gte|lte|gt|lt|like|ilike|ne|between|exists)\s*\(/;

function sources(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith("."))
      continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

test("no query joins two conditions with &&", () => {
  /*
   * This repository only. Pro and Modules each carry their own copy of this
   * file, because a guard that reaches above its own checkout reads whatever
   * happens to be beside it — which is how a copied guard once reported nine
   * findings in somebody else's tree.
   */
  const root = join(import.meta.dir, "..", "..", "..");
  const files = sources(join(root, "packages")).concat(
    sources(join(root, "apps")),
  );
  // An empty corpus would pass, which is the one way a sweep like this lies.
  expect(files.length).toBeGreaterThan(200);

  const found: string[] = [];
  for (const file of files) {
    if (file === import.meta.path) continue;
    const source = readFileSync(file, "utf8");
    for (const [index, line] of source.split("\n").entries()) {
      if (JOINED_BY_AND_AND.test(line)) {
        found.push(`${file.slice(root.length + 1)}:${index + 1}`);
      }
    }
  }

  expect(found.join("\n"), found.join("\n")).toBe("");
});
