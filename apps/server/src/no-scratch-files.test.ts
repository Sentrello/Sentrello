import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
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
