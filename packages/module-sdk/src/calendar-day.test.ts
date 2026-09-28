import { describe, expect, test } from "bun:test";
import { calendarDay, isCalendarDate } from "./calendar-day";

/**
 * The test has to run in a timezone that is not UTC or it proves nothing —
 * and `TZ` is read when the process starts, so a test cannot set it. The
 * zone is passed in instead, which is the same arithmetic: formatting
 * midnight UTC in Denver is where the day goes backwards.
 */
describe("a day on the calendar is the same day everywhere", () => {
  test("a date-only string does not slip backwards", () => {
    expect(calendarDay("2026-10-01")).toBe("Oct 1, 2026");
    expect(calendarDay("2026-01-01", "en-GB")).toBe("1 Jan 2026");
  });

  test("midnight UTC from the database is read as a calendar date", () => {
    expect(calendarDay(new Date("2026-10-01T00:00:00.000Z"))).toBe(
      "Oct 1, 2026",
    );
  });

  test("a real moment is left to the caller's zone", () => {
    // 23:30 UTC is the 30th in Denver, and that is correct for a moment.
    const moment = new Date("2026-10-01T05:30:00.000Z");
    expect(
      calendarDay(moment, "en-US", {
        dateStyle: "medium",
        timeZone: "America/Denver",
      }),
    ).toBe("Sep 30, 2026");
    expect(
      calendarDay(moment, "en-US", { dateStyle: "medium", timeZone: "UTC" }),
    ).toBe("Oct 1, 2026");
  });

  test("an explicit zone beats the calendar-date rule", () => {
    expect(
      calendarDay("2026-10-01", "en-US", {
        dateStyle: "medium",
        timeZone: "Pacific/Honolulu",
      }),
    ).toBe("Sep 30, 2026");
  });

  test("nothing, and nonsense, read as a blank", () => {
    expect(calendarDay(null)).toBe("—");
    expect(calendarDay(undefined)).toBe("—");
    expect(calendarDay("the first of never")).toBe("—");
  });

  test("what counts as a calendar date", () => {
    expect(isCalendarDate("2026-10-01")).toBe(true);
    expect(isCalendarDate("2026-10-01T09:00:00Z")).toBe(false);
    expect(isCalendarDate(new Date("2026-10-01T00:00:00Z"))).toBe(true);
    expect(isCalendarDate(new Date("2026-10-01T00:00:01Z"))).toBe(false);
  });
});

/**
 * The condition the bug actually needed: a *server* west of UTC.
 *
 * `TZ` is read once when the process starts, so no test inside this run can
 * set it — which is why the suite was green over a date that printed a day
 * early on any self-hosted box set to local time. A child process can.
 */
test("a server set to Denver time prints the same day as one set to UTC", () => {
  const script = `
    const { calendarDay } = await import("${import.meta.dir}/calendar-day.ts");
    console.log(calendarDay("2026-10-01"));
  `;
  const run = (timezone: string) =>
    Bun.spawnSync({
      cmd: ["bun", "-e", script],
      env: { ...process.env, TZ: timezone },
    })
      .stdout.toString()
      .trim();

  expect(run("America/Denver")).toBe("Oct 1, 2026");
  expect(run("Pacific/Honolulu")).toBe("Oct 1, 2026");
  expect(run("UTC")).toBe("Oct 1, 2026");
});
