import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sourceFiles } from "@sentrello/module-sdk";

/**
 * Every setting on the Authentication screen changes what the product does.
 *
 * Three of the seven did not. "Require two-factor for" saved, appeared on two
 * screens, told the person on their own profile that they would be refused,
 * and no guard anywhere read the column. "Shortest password" was validated on
 * write and never read, so the floor stayed the library's twelve and a
 * business that set sixteen had twelve. "Stay signed in for" saved in days
 * while every instance signed people out after thirty minutes regardless.
 *
 * All three were found by reading the code on 2026-09-28, which is the wrong
 * way to find them — a security control that is displayed and not applied is
 * worse than one that is absent, because the business believes it is covered
 * and stops looking.
 *
 * So: every column on `security_policy` is named somewhere outside the route
 * that writes it and the table that defines it. Crude on purpose. It cannot
 * tell a reader from a mention, and it does not need to: what it catches is a
 * column that exists in exactly two places, which is what all three of these
 * looked like.
 */

const REPO = resolve(import.meta.dir, "../../../..");

/** Where a column being named proves nothing. */
const WRITES_OR_DEFINES = [
  join("packages", "db", "src", "schema.ts"),
  join("packages", "modules-free", "users", "src", "authentication.ts"),
];

/** The screen, which displays them all and applies none. */
const DISPLAYS = join("apps", "web", "src", "routes", "users");

function columnsOf(): string[] {
  const schema = readFileSync(join(REPO, "packages/db/src/schema.ts"), "utf8");
  const start = schema.indexOf("export const securityPolicy = pgTable(");
  expect(start).toBeGreaterThan(0);
  const end = schema.indexOf("\n});", start);
  const body = schema.slice(start, end);

  return [...body.matchAll(/^\s{2}(\w+):\s/gm)]
    .map((m) => m[1] as string)
    .filter((name) => !["organizationId", "updatedAt"].includes(name));
}

const COLUMNS = columnsOf();

test("the policy table has columns to check", () => {
  // A rename that emptied this would pass every case below without looking.
  expect(COLUMNS.length).toBeGreaterThan(4);
});

test.each(COLUMNS)("%s is read somewhere, not only written", (column) => {
  const files = [
    ...sourceFiles(join(REPO, "packages"), [".ts"]),
    ...sourceFiles(join(REPO, "apps"), [".ts", ".tsx"]),
  ].filter(
    (file) =>
      !WRITES_OR_DEFINES.some((where) => file.endsWith(where)) &&
      !file.includes(DISPLAYS) &&
      !file.includes("/dist/"),
  );

  const named = files.filter((file) =>
    readFileSync(file, "utf8").includes(column),
  );

  expect(
    named.length,
    `${column} is saved and displayed and nothing else in the product mentions it, so setting it changes nothing — see the three this test was written for`,
  ).toBeGreaterThan(0);
});
