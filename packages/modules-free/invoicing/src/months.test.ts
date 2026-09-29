import { expect, test } from "bun:test";
import { sixMonthsFrom } from "./months";

/**
 * The chart's month labels, in a timezone that is not the one this runs in.
 *
 * The fault being pinned could not be seen by a test running in UTC, because
 * in UTC the arithmetic that was here was correct. It went wrong on a host
 * west of UTC — which is every American one, and this project's first market —
 * and it went wrong twice over: the first month named was the month before the
 * window, and the second skipped one, so a month of billing appeared on no bar
 * at all.
 *
 * So the useful assertion runs the function in a second process with `TZ` set.
 * That is why `months.ts` has no imports: a subprocess that has to load
 * `summary.ts` loads the database client with it and never returns.
 */
const APRIL = new Date(Date.UTC(2026, 3, 1));
const FOUND = [{ month: "2026-04", billedCents: 1000 }];
const EXPECTED = [
  "2026-04",
  "2026-05",
  "2026-06",
  "2026-07",
  "2026-08",
  "2026-09",
];

test("six consecutive months, starting at the month asked for", () => {
  expect(sixMonthsFrom(APRIL, FOUND).map((m) => m.month)).toEqual(EXPECTED);
});

test("the month that has billing in it carries it", () => {
  const series = sixMonthsFrom(APRIL, FOUND);
  expect(series.find((m) => m.month === "2026-04")?.billedCents).toBe(1000);
  expect(series.filter((m) => m.billedCents > 0)).toHaveLength(1);
});

test("a business that has never invoiced gets no bars rather than six", () => {
  expect(sixMonthsFrom(APRIL, [])).toEqual([]);
});

/**
 * A year boundary, which the month-index arithmetic has to cross by itself.
 *
 * `Math.floor(month / 12)` and `month % 12` are the whole of it, and the case
 * that would catch them being written the other way round is December.
 */
test("the series crosses a year end", () => {
  const since = new Date(Date.UTC(2026, 10, 1));
  expect(
    sixMonthsFrom(since, [{ month: "2027-01", billedCents: 1 }]).map(
      (m) => m.month,
    ),
  ).toEqual(["2026-11", "2026-12", "2027-01", "2027-02", "2027-03", "2027-04"]);
});

/** The same question, asked of a host in each of the four markets. */
const ZONES = [
  "America/New_York",
  "America/Los_Angeles",
  "America/Halifax",
  "Europe/Dublin",
  "UTC",
];

test("every market's host reads the same six months", () => {
  const code = `
    const { sixMonthsFrom } = await import(${JSON.stringify(`${import.meta.dir}/months.ts`)});
    const series = sixMonthsFrom(new Date(Date.UTC(2026, 3, 1)), [
      { month: "2026-04", billedCents: 1000 },
    ]);
    console.log(series.map((m) => m.month + ":" + m.billedCents).join(" "));
  `;
  const want = EXPECTED.map((m) => `${m}:${m === "2026-04" ? 1000 : 0}`).join(
    " ",
  );

  for (const TZ of ZONES) {
    const run = Bun.spawnSync(["bun", "-e", code], {
      env: { ...process.env, TZ },
    });
    const out = new TextDecoder().decode(run.stdout).trim();
    expect(`${TZ}: ${out}`).toBe(`${TZ}: ${want}`);
  }
}, 30_000);
