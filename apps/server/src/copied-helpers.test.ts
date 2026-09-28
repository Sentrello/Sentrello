import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sourceFiles } from "@sentrello/module-sdk";
import { findCopiedHelpers } from "@sentrello/module-sdk/copied-helpers";

/**
 * A shared helper written out again by hand.
 *
 * Four of these turned up on 25 September, and every one had drifted from the
 * original in its own direction: a CSV builder in Pro with the wrong line
 * endings and no formula guard, attachment headers in the CRM missing a
 * content security policy, a `Content-Disposition` in a paid module that was
 * *better* than the SDK's and unreachable from here, and the SDK's own, which
 * is the one the other three should have been.
 *
 * None of them was carelessness. A helper is easier to write than to find,
 * especially across four repositories where the shared package is a
 * dependency rather than a folder — and none of the copies was wrong on the
 * day it was written. They were wrong by the time somebody fixed the
 * original, which nobody was told about.
 *
 * So the check is for the shapes rather than the names, and it names the
 * helper to call in its own failure message.
 */
const ROOT = join(import.meta.dir, "..", "..", "..");

const TREES = [
  join(ROOT, "apps", "server", "src"),
  join(ROOT, "apps", "web", "src"),
  join(ROOT, "packages"),
];

test("there is a tree to read", () => {
  // A scan over nothing passes the assertion below it, which is how this
  // whole family of checks goes quietly green.
  const files = TREES.flatMap((tree) => sourceFiles(tree, [".ts", ".tsx"]));
  expect(files.length).toBeGreaterThan(200);
});

test("nothing writes out a helper the SDK already has", () => {
  const copies: string[] = [];
  for (const tree of TREES) {
    for (const path of sourceFiles(tree, [".ts", ".tsx"])) {
      if (path.includes(".test.")) continue;
      // The SDK's own definitions are the originals.
      if (path.endsWith("module-sdk/src/attachments.ts")) continue;
      if (path.endsWith("module-sdk/src/csv.ts")) continue;
      for (const found of findCopiedHelpers(readFileSync(path, "utf8"))) {
        copies.push(
          `${path.slice(ROOT.length + 1)}:${found.line}: ${found.what} built by hand — ${found.say}.`,
        );
      }
    }
  }
  expect(copies, `\n    ${copies.join("\n    ")}`).toEqual([]);
});
