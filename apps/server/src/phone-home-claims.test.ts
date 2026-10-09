import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";

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
  // A directory that is not there contributes nothing. `docs/plan` is
  // git-ignored, so it exists on the machine this was written on and in no
  // clone and no CI checkout — a sweep that throws where it runs and passes
  // where it was written is worse than one that looks in fewer places.
  (existsSync(dir) ? readdirSync(dir) : []).flatMap((entry) => {
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
  /*
   * `legal/` was outside this list, and it was wrong.
   *
   * `legal/security.md` said "Runs once a day, only on a paid instance" eleven
   * days after the cron changed — in a legal document, in a public repository.
   * The file list was README, SECURITY and the published docs, which is "the
   * places we remembered", and the claim had drifted into the one we had not.
   */
  const files = [
    `${ROOT}/README.md`,
    `${ROOT}/SECURITY.md`,
    ...walk(`${ROOT}/docs/site`),
    ...walk(`${ROOT}/legal`),
  ];

  const wrong: string[] = [];
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!callsItDaily(line)) continue;
      // A sentence that is *about* the change is the one place both cadences
      // belong in one line, and "hourly, not daily" is the shortest way to
      // write it.
      if (
        /rather than (nightly|daily)|instead of (nightly|daily)|not (nightly|daily)/i.test(
          line,
        )
      )
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

/**
 * And what it sends, not only how often.
 *
 * The page whose job is "what leaves a Sentrello instance, what never does" said
 * a paid instance sends one licence check an hour "and nothing else". It also
 * sends a usage report, daily, on any instance whose owner said yes at the
 * prompt — version, tier, which modules are loaded, the instance id and a band
 * for how many people use it.
 *
 * The installer asks for that consent in plain words and defaults to no, which is
 * right and is the part that was already careful. The published page said less
 * than the installer did, which for a self-hosted product is the wrong way round:
 * the reader most likely to find that page is somebody evaluating us who has not
 * run the installer.
 *
 * Measured against the payload's own type rather than a remembered list, so a
 * field added to the report has to be added to the page before the build passes.
 * `instanceId` is the one exception and it is named on the page as "the instance
 * id" — in words, because that is how a page is written.
 */
const SAID_ON_THE_PAGE: Record<string, RegExp> = {
  version: /\bversion\b/i,
  tier: /free or pro/i,
  modules: /which modules are loaded/i,
  users: /band for how many people/i,
  instanceId: /instance id/i,
};

test("the page names every field the usage report carries", () => {
  const telemetry = readFileSync(
    `${ROOT}/packages/jobs/src/telemetry.ts`,
    "utf8",
  );
  const shape = /export interface Telemetry \{([\s\S]*?)\n\}/.exec(telemetry);
  expect(
    shape,
    "the Telemetry payload is not declared where this looked",
  ).toBeTruthy();

  const fields = [
    ...(shape?.[1] ?? "").matchAll(/^\s*([A-Za-z][\w]*)\??:/gm),
  ].map(([, name]) => name as string);
  // So a sweep that read no fields cannot pass as a clean one.
  expect(fields.length).toBeGreaterThan(3);

  const page = readFileSync(
    `${ROOT}/docs/site/03-platform/04-security.md`,
    "utf8",
  );
  const unsaid = fields.filter((field) => {
    const says = SAID_ON_THE_PAGE[field];
    // A field nobody has written a phrase for is unsaid by definition: adding one
    // to the report means saying what it is, here and on the page.
    return !says || !says.test(page);
  });
  expect(
    unsaid,
    `the usage report carries ${unsaid.join(", ")} and the security page does not say so`,
  ).toEqual([]);
});

/**
 * And the screen where the owner turns it on says the same.
 *
 * Settings → License and updates listed four of the five fields and then said
 * "Nothing else" — the instance id was sent and not named, on the one screen a
 * person reads before pressing **Start sending**.
 */
test("the Settings screen names every field the usage report carries", () => {
  const screen = readFileSync(
    `${ROOT}/apps/web/src/routes/settings.tsx`,
    "utf8",
  );
  const card =
    /<SectionHeading>Usage reporting<\/SectionHeading>([\s\S]*?)<\/p>/.exec(
      screen,
    );
  expect(
    card,
    "the usage reporting card is not where this looked",
  ).toBeTruthy();
  const words = (card?.[1] ?? "").replace(/\s+/g, " ");
  const unsaid = Object.entries(SAID_ON_THE_PAGE)
    .filter(([, says]) => !says.test(words))
    .map(([field]) => field);
  expect(
    unsaid,
    `the usage report carries ${unsaid.join(", ")} and the Settings screen does not say so`,
  ).toEqual([]);
});
