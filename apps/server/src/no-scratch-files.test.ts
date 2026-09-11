import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Nothing that was written to answer a question stays in the repository.
 *
 * Twice now. `dbg.tmp.ts` was committed in the Pro repository — fifteen lines
 * written to find out what error a unique-constraint violation throws, which
 * ran `create table` at the top level. And a `diag-check.ts` written here to
 * reproduce a lockout survived because the command that would have deleted it
 * timed out first, so the cleanup never ran.
 *
 * That second one is the argument for this being a test rather than a habit:
 * the intention to tidy up was there and the tidying still did not happen.
 *
 * The existing `leftovers` gate is about stray organizations in the test
 * database and was never going to see a file. Typecheck and lint both passed it
 * happily, because it is valid TypeScript that offends no rule. Nothing in the
 * gate asked the question this asks.
 *
 * Names, not contents: a scratch file is recognisable by what its author called
 * it while writing it, and every one of these is a name somebody reaches for
 * when they mean "not for keeps".
 */
const SCRATCH =
  /(^|\/)(dbg|debug|scratch|tmp|temp|test-?script|foo|bar|untitled)[.-]|\.(tmp|bak|orig|scratch)\.|\.(bak|orig|swp)$/i;

test("no scratch or debug files are committed", () => {
  const repo = join(import.meta.dir, "../../..");
  const tracked = spawnSync("git", ["ls-files"], {
    cwd: repo,
    encoding: "utf8",
  });
  expect(tracked.status).toBe(0);

  const files = tracked.stdout.split("\n").filter(Boolean);
  // A listing that comes back empty would pass every assertion below it.
  expect(files.length).toBeGreaterThan(50);

  const scratch = files.filter((f) => SCRATCH.test(f));
  expect(scratch).toEqual([]);
});

/**
 * Nothing at the root except what the product is made of.
 *
 * Written as an allow-list, which is the whole point of it. A deny-list names
 * the things being kept out, and naming them is exactly what must not happen in
 * a public repository — the thing to exclude would be written down in the file
 * doing the excluding. An allow-list says only what belongs, catches whatever
 * turns up next without being edited, and reveals nothing about what it caught.
 *
 * It exists because the protection that was doing this job lives in
 * `.git/info/exclude`, which is **local to one clone and travels nowhere**. A
 * fresh clone on another machine has none of it, and one `git add -A` puts
 * whatever is lying about into a public repository for ever. This repository
 * has been recreated twice over precisely that.
 *
 * Adding something legitimate at the root means adding it here, deliberately,
 * which is the correct amount of friction for a decision that is permanent.
 */
const BELONGS_AT_ROOT = new Set([
  ".env.example",
  ".gitignore",
  "ACCESSIBILITY.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "biome.json",
  "bun.lock",
  "docker-compose.dev.yml",
  "package.json",
  "tsconfig.base.json",
  "tsconfig.json",
]);

/** Directories at the root that are part of the product or how it is built. */
const BELONGS_AS_DIRECTORY = new Set([
  ".githooks",
  ".github",
  ".vscode",
  "apps",
  "docs",
  "drizzle",
  "legal",
  "packages",
  "scripts",
]);

test("nothing is committed at the root except what belongs there", () => {
  const repo = join(import.meta.dir, "../../..");
  const tracked = spawnSync("git", ["ls-files"], {
    cwd: repo,
    encoding: "utf8",
  });
  expect(tracked.status).toBe(0);

  const files = tracked.stdout.split("\n").filter(Boolean);
  // A listing that came back empty would pass every assertion below it.
  expect(files.length).toBeGreaterThan(50);

  const strangers = [
    ...new Set(
      files.filter((f) => {
        const top = f.split("/")[0] ?? "";
        return f.includes("/")
          ? !BELONGS_AS_DIRECTORY.has(top)
          : !BELONGS_AT_ROOT.has(top);
      }),
    ),
  ].map((f) => f.split("/")[0]);

  expect([...new Set(strangers)]).toEqual([]);
});

/**
 * Every package says what it is licensed under.
 *
 * Not one of the seventeen packages across the three repositories did. For a
 * product whose free half is copyleft and whose paid half is closed, "no
 * licence stated" is the worst of both: the commercial code carries no stated
 * restriction, and the copyleft terms are not attached to the packages that
 * carry them.
 *
 * It also matters mechanically. Every tool that assembles a bill of materials —
 * including this repository's own `scripts/sbom.ts` — reads this field, and a
 * customer's procurement review reads that.
 */
test("every package in this repository states its licence", () => {
  const repo = join(import.meta.dir, "../../..");
  const tracked = spawnSync("git", ["ls-files", "*package.json"], {
    cwd: repo,
    encoding: "utf8",
  });
  expect(tracked.status).toBe(0);

  const manifests = tracked.stdout.split("\n").filter(Boolean);
  // A listing that came back empty would pass the assertion below it.
  expect(manifests.length).toBeGreaterThan(5);

  const silent = manifests.filter((path) => {
    const json = JSON.parse(readFileSync(join(repo, path), "utf8"));
    return json.license !== "AGPL-3.0-or-later";
  });
  expect(silent).toEqual([]);
});
