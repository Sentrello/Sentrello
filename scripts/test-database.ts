/**
 * Which database the tests use, decided before a single test file loads.
 *
 * `bun test` runs every `[test] preload` script first, in the one process it
 * shares with the whole suite, so this is the earliest place a run can be
 * stopped — and stopping it is the point. The rule it enforces already existed
 * in `scripts/verify.sh`, and `verify.sh` is not what somebody types when they
 * want to run one file.
 *
 * **What went wrong without it.** On 2 October a run of this suite was pointed
 * at the retired shared `sentrello` database by hand. It reported 87 failures
 * across booking, shop and newsletter — every one of them convincing, none of
 * them caused by the change in front of it. Two were schema drift. The other 85
 * had a single cause: 58 abandoned organizations left there by a run that was
 * killed in September. The public pages refuse to serve when an instance holds
 * more than one organization, and the sign-in log resolves an unknown address to
 * the *oldest* one, so a single stranded row takes down suites in modules nobody
 * has touched. The gate was green on the first try afterwards.
 *
 * Three quarters of an hour went into diagnosing failures that did not exist.
 * The guard that would have prevented it was ten feet away in a shell script
 * nothing had run. So the rule moves to where the tests read it.
 *
 * **The address is not written here.** It is in `scripts/test-database`, one
 * line, because `verify.sh` reads the same file and two copies of one name is a
 * name that drifts. This repository already has a note on that shape of bug.
 *
 * **CI is not exempt, and that was a decision.** Every workflow ran against a
 * database literally named `sentrello` — safe there, because the container is
 * created fresh for the run and thrown away after it — so this would have
 * turned all four CIs red the moment it landed. The fix was to rename those
 * databases rather than to spare `process.env.CI`. A guard that spares one
 * thing is a guard with one place nothing looks, and the rule it enforces is
 * worth stating without an asterisk: the name of the database says which
 * repository's tests may write to it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WANTED = join(import.meta.dir, "test-database");

/** Said in full, because a message that only says "no" costs another run. */
function refuse(lines: string[]): never {
  console.error("");
  for (const line of lines) console.error(`  ${line}`);
  console.error("");
  process.exit(1);
}

const ours = existsSync(WANTED)
  ? readFileSync(WANTED, "utf8").trim()
  : undefined;

/*
 * Unset means use ours, which is the whole reason this is a default rather than
 * a requirement: `bun test` with nothing set has to do the right thing, or the
 * right thing is something everybody has to remember.
 */
if (!process.env.DATABASE_URL && ours) {
  process.env.DATABASE_URL = ours;
}

const url = process.env.DATABASE_URL ?? "";

if (!/localhost|127\.0\.0\.1|\[::1\]/.test(url)) {
  refuse([
    "refusing to run tests against a database that is not local:",
    `  ${url || "(nothing set)"}`,
    "",
    "The suites truncate tables. Being wrong about where is not something",
    "reading the output afterwards can undo.",
  ]);
}

/*
 * The browser instance. Claiming it leaves an organization behind, and the
 * bootstrap tests then fail with 409s that have nothing to do with the change
 * somebody is looking at.
 */
if (/\/sentrello_dev(\?|$)/.test(url)) {
  refuse([
    "refusing to run tests against sentrello_dev.",
    "",
    "That is the instance you look at in a browser, and its organization",
    "would be destroyed. Unset DATABASE_URL to use this repository's own.",
  ]);
}

/*
 * The retired shared database. Matched at the end of the path, not as a
 * substring: every repository's own name starts with the same word —
 * `sentrello_t_core`, `_pro`, `_modules`, `_infra` — so a substring test
 * refuses the right database along with the wrong one.
 */
if (/\/sentrello(\?|$)/.test(url)) {
  refuse([
    "refusing to run tests against the shared sentrello database.",
    "",
    "It is retired — every repository has its own now — and it still holds",
    "another run's leavings. A suite pointed at it reports failures in",
    "modules nobody touched: 87 of them on 2 October, 85 traced to one",
    "stranded organization, because the public pages refuse to serve when an",
    "instance holds more than one.",
    "",
    `Unset DATABASE_URL to use ${ours ?? "this repository's own"}, or name the`,
    "database you meant.",
  ]);
}
