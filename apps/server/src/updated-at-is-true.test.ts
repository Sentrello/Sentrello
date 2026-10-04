import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A column called `updated_at` says when the row last changed, or it says
 * nothing.
 *
 * Drizzle's `defaultNow()` fires on insert and never again, so an update that
 * does not set the column leaves it describing the insert. Two writes in
 * invoicing did exactly that — recording a payment and applying a credit both
 * change an invoice's status and neither stamped it — so an invoice paid last
 * week still said it was last changed the day it was drafted.
 *
 * Nothing notices. The column is right on most paths, which is worse than
 * being wrong on all of them: anything built on it later (an export, a sync, a
 * "what changed since" sweep, the optimistic-concurrency check this repository
 * will eventually want) is correct in testing and quietly stale in exactly the
 * cases that matter — the ones where somebody else touched the record.
 *
 * So every `update` on a table that *has* the column has to set it. The scan is
 * textual and deliberately narrow: it reads the `.set({ … })` that follows an
 * `.update(schema.x)` or `.update(x)` and asks whether `updatedAt` is in it.
 */
const ROOT = join(import.meta.dir, "../../..");

/** Which tables declare the column, read from the schema rather than listed. */
function tablesWithUpdatedAt(): Set<string> {
  const out = new Set<string>();
  for (const file of ["packages/db/src/schema.ts"]) {
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const match of text.matchAll(
      /export const (\w+) = pg(?:Table|Schema)?\.?\w*\(([\s\S]*?)\n\);/g,
    )) {
      const [, name, body] = match;
      if (name && body?.includes('updated_at"')) out.add(name);
    }
  }
  return out;
}

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith("."))
      continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (name.endsWith(".ts") && !name.includes(".test.")) out.push(path);
  }
  return out;
}

const tables = tablesWithUpdatedAt();

test("the schema was read, so this is checking something", () => {
  // A regex that stops matching leaves every file below clean.
  expect(tables.size).toBeGreaterThan(10);
  expect(tables.has("invoices")).toBe(true);
});

test("every update of a row that records when it changed says so", () => {
  const stale: string[] = [];

  for (const path of [
    ...sources(join(ROOT, "packages/modules-free")),
    ...sources(join(ROOT, "apps/server/src")),
    ...sources(join(ROOT, "packages/jobs/src")),
  ]) {
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(
      /\.update\(\s*(?:schema\.)?(\w+)\s*\)([\s\S]{0,600}?)\.where\(/g,
    )) {
      const [, table, between] = match;
      if (!table || !tables.has(table)) continue;
      if (!between?.includes(".set(")) continue;
      if (between.includes("updatedAt")) continue;
      /*
       * A `.set()` built elsewhere — `values`, `patch`, `fields` — is taking a
       * prepared object, and the place it was prepared is where the column is
       * stamped. Those are read by the eye; this scan is for the literal form,
       * which is the one that forgets.
       */
      if (/\.set\(\s*(?:values|patch|fields|set|next)\b/.test(between))
        continue;
      const line = text.slice(0, match.index).split("\n").length;
      stale.push(`${path.slice(ROOT.length + 1)}:${line} — ${table}`);
    }
  }

  expect(
    stale,
    `these update a row whose table records when it changed, and do not set it:\n    ${stale.join("\n    ")}`,
  ).toEqual([]);
});
