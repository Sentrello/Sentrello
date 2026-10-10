import { afterEach, expect, setSystemTime, test } from "bun:test";
import { lastSeenRanges } from "./list-ui";
import {
  businessDayOf,
  daysFromToday,
  setFormats,
  startOfBusinessDay,
} from "./ui";

/**
 * "Today", "overdue" and "this week" are the business's days.
 *
 * A stored day (midnight UTC, or a bare date) is its own UTC day; a moment is
 * the day it fell on where the business keeps its books. Neither is the
 * reader's laptop clock, and no zone set means UTC.
 */

afterEach(() => {
  setSystemTime();
  setFormats({ businessTimezone: "" });
});

test("a stored day is itself, a moment is the business's day of it", () => {
  setFormats({ businessTimezone: "America/Denver" });
  expect(businessDayOf("2026-10-09")).toBe("2026-10-09");
  expect(businessDayOf("2026-10-09T00:00:00.000Z")).toBe("2026-10-09");
  // Half past one in the morning UTC on the 10th is the 9th in Denver.
  expect(businessDayOf("2026-10-10T01:30:00.000Z")).toBe("2026-10-09");
});

test("days from today count from the business's today", () => {
  setSystemTime(new Date("2026-10-10T02:00:00Z")); // the 9th in Denver
  setFormats({ businessTimezone: "America/Denver" });
  expect(daysFromToday("2026-10-09")).toBe(0);
  expect(daysFromToday("2026-10-10")).toBe(1);
  expect(daysFromToday("2026-10-09T15:00:00Z")).toBe(0);
});

test("the business's day starts at its own midnight", () => {
  setFormats({ businessTimezone: "America/New_York" });
  expect(startOfBusinessDay("2026-10-09").toISOString()).toBe(
    "2026-10-09T04:00:00.000Z",
  );
  // Either side of a clock change.
  expect(startOfBusinessDay("2026-11-02").toISOString()).toBe(
    "2026-11-02T05:00:00.000Z",
  );
  setFormats({ businessTimezone: "" });
  expect(startOfBusinessDay("2026-10-09").toISOString()).toBe(
    "2026-10-09T00:00:00.000Z",
  );
});

test("the last-seen filters start where the business's day and week start", () => {
  // Sunday evening in Denver, already Monday in UTC.
  setFormats({ businessTimezone: "America/Denver" });
  const ranges = lastSeenRanges(new Date("2026-10-12T02:00:00Z"));
  const after = (label: string) =>
    ranges.find((r) => r.label === label)?.values.lastSeenAfter;
  expect(after("Today")).toBe("2026-10-11T06:00:00.000Z");
  expect(after("This week")).toBe("2026-10-11T06:00:00.000Z");
  expect(
    ranges.find((r) => r.label === "Before this month")?.values.lastSeenBefore,
  ).toBe("2026-10-01T06:00:00.000Z");
  expect(
    ranges.find((r) => r.label === "Before last month")?.values.lastSeenBefore,
  ).toBe("2026-09-01T06:00:00.000Z");
});
