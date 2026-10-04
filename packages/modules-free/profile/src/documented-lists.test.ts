import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sourceFiles } from "@sentrello/module-sdk";

/**
 * The published page names every list that has column choice.
 *
 * "Working a list" tells a customer which tables let them choose their
 * columns, by name. It is a list of nine written by hand, and it has been
 * wrong twice: two lists gained the control and the page stayed as it was, and
 * nobody found out from the product — somebody found out reading the page
 * against the code, a day after the second release that broke it.
 *
 * The fix is not to be more careful. It is that adding a list now fails here
 * until the page says so: `COLUMN_LISTS` names what each key is called in
 * prose, every `useColumns` key in this repository has to be in it, and every
 * name in it has to be in the page's Columns row. The same test lives in Pro
 * and Modules against this same page, because their lists are on it too and a
 * public page cannot read a private repository.
 */
const PAGE = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "docs",
  "site",
  "02-core",
  "lists.md",
);

/** This repository's keys, and the word the page uses for each. */
const COLUMN_LISTS: Record<string, string> = {
  invoices: "invoices",
  quotes: "quotes",
};

const WEB = join(import.meta.dir, "..", "..", "..", "..", "apps", "web", "src");

function keysInUse(): string[] {
  const found = new Set<string>();
  for (const file of sourceFiles(WEB, [".tsx"])) {
    // The hook's own tests declare a `probe` list that no customer can reach.
    if (file.endsWith(".test.tsx")) continue;
    for (const call of readFileSync(file, "utf8").matchAll(
      /useColumns\(\s*["'`]([a-z0-9][a-z0-9:_-]*)["'`]/g,
    )) {
      found.add(call[1] as string);
    }
  }
  return [...found].sort();
}

test("every list with column choice is named on the page that promises it", () => {
  const keys = keysInUse();
  expect(keys).toEqual(Object.keys(COLUMN_LISTS).sort());

  const page = readFileSync(PAGE, "utf8");
  const row = page.split("\n").find((line) => line.startsWith("| **Columns**"));
  expect(row).toBeString();

  for (const name of Object.values(COLUMN_LISTS)) {
    expect(row).toContain(name);
  }
});
