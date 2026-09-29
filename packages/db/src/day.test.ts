import { expect, test } from "bun:test";
import { dayIn, dayOf, daysLate } from "./day";

/**
 * The day a business is having, and the day a due date names.
 *
 * Written because `dueDate < now` had been the rule for lateness everywhere,
 * and it makes an invoice late for the whole of the day it is due — from the
 * evening before, on every host west of Greenwich.
 */
test("a day is the same day wherever it is asked about, but not the same moment", () => {
  // Seven in the morning in London on the 17th is still the 16th in Los Angeles.
  const when = new Date("2026-09-17T06:00:00Z");
  expect(dayIn(when, "Europe/London").toISOString()).toBe(
    "2026-09-17T00:00:00.000Z",
  );
  expect(dayIn(when, "America/Los_Angeles").toISOString()).toBe(
    "2026-09-16T00:00:00.000Z",
  );
  // And already the 17th in Auckland, hours before London woke up.
  expect(dayIn(new Date("2026-09-16T13:00:00Z"), "Pacific/Auckland")).toEqual(
    new Date("2026-09-17T00:00:00Z"),
  );
});

test("no timezone means UTC, and never the machine's own", () => {
  // The assertion that matters here is the one about the *server*: this file is
  // run in UTC by `bun test` and in UTC by CI, so a helper reading the host
  // clock would pass both and be wrong on every American instance. Asking for
  // a zone the host is not in is the only way to see the difference.
  const when = new Date("2026-09-17T23:30:00Z");
  expect(dayIn(when, null)).toEqual(new Date("2026-09-17T00:00:00Z"));
  expect(dayIn(when, "")).toEqual(new Date("2026-09-17T00:00:00Z"));
  expect(dayIn(when, "America/New_York")).toEqual(
    new Date("2026-09-17T00:00:00Z"),
  );
  expect(dayIn(new Date("2026-09-18T03:30:00Z"), "America/New_York")).toEqual(
    new Date("2026-09-17T00:00:00Z"),
  );
});

test("a stored date stands for its own day, not the reader's", () => {
  // The off-by-one this file exists to stop: a due date is written as midnight
  // UTC on the day somebody typed, so reading it *in* New York would make it
  // the day before and every invoice would be late a day early.
  const due = new Date("2026-09-17T00:00:00Z");
  expect(dayOf(due)).toEqual(due);
  expect(dayIn(due, "America/New_York")).toEqual(
    new Date("2026-09-16T00:00:00Z"),
  );
});

test("days late is zero all through the due day", () => {
  const due = new Date("2026-09-17T00:00:00Z");
  expect(daysLate(due, new Date("2026-09-17T00:00:00Z"), null)).toBe(0);
  expect(daysLate(due, new Date("2026-09-17T23:59:59Z"), null)).toBe(0);
  expect(daysLate(due, new Date("2026-09-18T00:00:01Z"), null)).toBe(1);
  expect(daysLate(due, new Date("2026-09-15T12:00:00Z"), null)).toBe(-2);
  expect(daysLate(due, new Date("2026-10-17T12:00:00Z"), null)).toBe(30);
});

/**
 * And it survives the two mornings a year when a day is not 24 hours long.
 *
 * It survives them by construction: both ends are reduced to a *UTC* midnight
 * before anything is subtracted, so the gap is always an exact number of days
 * however the local clocks moved. `Math.round` rather than `floor` is the belt
 * to that braces — anchor either end on a local midnight and a spring morning
 * is 23 hours, which floors to a day fewer and fires every chase rule a day
 * late.
 */
test("a clock change does not add or lose a day", () => {
  const zone = "America/New_York";
  // Forward on 8 March 2026: locally the 7th to the 9th is 47 hours, not 48.
  expect(
    daysLate(
      new Date("2026-03-07T00:00:00Z"),
      new Date("2026-03-09T16:00:00Z"),
      zone,
    ),
  ).toBe(2);
  // Back on 1 November 2026: locally the 31st to the 2nd is 49.
  expect(
    daysLate(
      new Date("2026-10-31T00:00:00Z"),
      new Date("2026-11-02T16:00:00Z"),
      zone,
    ),
  ).toBe(2);
  // And the day itself is the day, on both mornings.
  expect(dayIn(new Date("2026-03-08T12:00:00Z"), zone)).toEqual(
    new Date("2026-03-08T00:00:00Z"),
  );
  expect(dayIn(new Date("2026-11-01T05:30:00Z"), zone)).toEqual(
    new Date("2026-11-01T00:00:00Z"),
  );
});

test("a timezone the runtime cannot resolve does not throw", () => {
  // `knownTimezone` guards the settings screen, but a row written before that
  // guard existed would reach here — and a report that throws is worse than a
  // report kept in UTC.
  expect(() => dayIn(new Date(), "Mars/Olympus_Mons")).not.toThrow();
});
