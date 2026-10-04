import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sourceFiles } from "@sentrello/module-sdk";
import { findBorrowedIterator } from "@sentrello/module-sdk/borrowed-iterator";

/**
 * An array method borrowed onto an iterator.
 *
 * On 3 October 2026 the embeddable forms script built its request body with
 * `Array.prototype.reduce.call(data.entries(), …)`. An iterator has no `length`,
 * which is the only thing a borrowed array method reads, so it visited nothing
 * and handed back the empty object it started with. Every form without a file
 * on it posted `{}`, the instance answered that a name or an email address was
 * required, and the visitor was told the form could not be sent. A form
 * carrying a file posted the FormData itself and worked — so it read as some
 * forms being broken rather than as one line being wrong, and the contact form
 * on the marketing site was down for a day.
 *
 * Four other borrowings were in the repositories that day and all four are onto
 * array-likes, which have a `length` and work. That is exactly why the broken
 * one did not stand out, and it is why this reads the call that produced the
 * argument rather than looking for the borrowing alone.
 *
 * It is a text scan because the code it lives in is a string: an embeddable
 * script is text we ship to somebody else's website, where TypeScript never
 * sees it.
 */
const ROOT = join(import.meta.dir, "..", "..", "..");

const TREES = [
  join(ROOT, "apps", "server", "src"),
  join(ROOT, "apps", "web", "src"),
  join(ROOT, "packages"),
];

test("there is a tree to read", () => {
  // A scan over nothing passes the assertion below it, which is how this whole
  // family of checks goes quietly green.
  const files = TREES.flatMap((tree) => sourceFiles(tree, [".ts", ".tsx"]));
  expect(files.length).toBeGreaterThan(200);
});

test("no array method is borrowed onto an iterator", () => {
  const borrowings: string[] = [];
  for (const tree of TREES) {
    for (const path of sourceFiles(tree, [".ts", ".tsx"])) {
      // The scanner's own definitions are the originals.
      if (path.endsWith("module-sdk/src/borrowed-iterator.ts")) continue;
      for (const found of findBorrowedIterator(readFileSync(path, "utf8"))) {
        borrowings.push(
          `${path.slice(ROOT.length + 1)}:${found.line}: ${found.say}.`,
        );
      }
    }
  }
  expect(borrowings, `\n    ${borrowings.join("\n    ")}`).toEqual([]);
});
