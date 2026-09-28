import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";

/**
 * What this repository tells the public that an instance sends.
 *
 * README.md is the first page anybody sees on a public AGPL repository,
 * SECURITY.md is where somebody evaluating the project looks next, and
 * docs/site/ syncs to docs.sentrello.com. All three said a paid instance sends
 * "one daily licence check".
 *
 * It does not. The refresh is scheduled with `jitteredMinuteCron()` — hourly,
 * at a minute chosen once per process — and it POSTs on every run, with no
 * freshness guard that skips a call while the token is still good. So the
 * public claim understated contact with Sentrello by twenty-four times, in
 * the one claim a self-hosted product's readers care most about.
 *
 * The behaviour is right and the sentence was stale: a verified token lasts 72
 * hours, and the hourly call is what makes a cancelled licence stop promptly
 * instead of up to three days later.
 *
 * Two assertions, because either half can go wrong on its own — the prose can
 * drift back, or the schedule can change under prose nobody rereads.
 */

const ROOT = `${import.meta.dir}/../../..`;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = `${dir}/${entry}`;
    return statSync(path).isDirectory()
      ? walk(path)
      : path.endsWith(".md")
        ? [path]
        : [];
  });

/**
 * All three words in one line: the cadence, the licence, and the *check*.
 * "A nightly dump of the licence database" is Sentrello backing up its own
 * control plane, which is nightly and is nobody's instance phoning home.
 */
const callsItDaily = (line: string): boolean =>
  /\b(daily|nightly|once a day)\b/i.test(line) &&
  /\b(licence|license)\b/i.test(line) &&
  /\bcheck(s|ing)?\b/i.test(line);

test("nothing public calls the licence check daily", () => {
  const files = [
    `${ROOT}/README.md`,
    `${ROOT}/SECURITY.md`,
    ...walk(`${ROOT}/docs/site`),
  ];

  const wrong: string[] = [];
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!callsItDaily(line)) continue;
      if (/rather than nightly|instead of (nightly|daily)/i.test(line))
        continue;
      wrong.push(`${file.slice(ROOT.length + 1)}: ${line.trim().slice(0, 80)}`);
    }
  }

  expect(
    wrong,
    `these say the licence check runs daily; it runs hourly — see SCHEDULES in packages/jobs/src/index.ts:\n${wrong.join("\n")}`,
  ).toEqual([]);
});

test("and the schedule those pages describe is still the schedule", () => {
  const jobs = readFileSync(`${ROOT}/packages/jobs/src/index.ts`, "utf8");
  expect(
    /licenseRefresh\]:\s*jitteredMinuteCron\(\)/.test(jobs),
    "the licence refresh is no longer on the hourly jittered cron. README.md, SECURITY.md and docs/site say hourly — read the new schedule and correct them in the same commit.",
  ).toBe(true);
});
