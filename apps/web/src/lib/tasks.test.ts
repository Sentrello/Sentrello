import { afterEach, expect, setSystemTime, test } from "bun:test";
import { isOverdue, untilDue } from "./tasks";
import { businessToday, setFormats } from "./ui";

afterEach(() => {
  setSystemTime();
  setFormats({ businessTimezone: "" });
});

/**
 * A task due today is not late.
 *
 * Found by making one on the dashboard: a task created with today's date
 * appeared immediately as "overdue", in the warning colour, because a due date
 * is stored at midday and by mid-afternoon that instant has passed. Nobody
 * thinks their two o'clock is overdue at one.
 *
 * Due dates are calendar days and have to be compared as calendar days.
 */

/** A due date `days` from the business's today, stamped at midday UTC the way the form writes it. */
function due(days: number): string {
  return `${businessToday({ days })}T12:00:00.000Z`;
}

/**
 * A moment that is unambiguously earlier today, whenever the suite is run.
 *
 * `due(0)` alone is not enough to pin this down: it lands at midday UTC, which
 * is in the past by the afternoon and in the future all morning — so a test
 * built on it would catch the bug for half of each day and pass for the other
 * half. One second after midnight on today's date is earlier today at every
 * hour except the first second of one.
 */
function earlierToday(): string {
  return `${businessToday()}T00:00:01.000Z`;
}

test("a task due today reads as today, whatever the hour", () => {
  expect(untilDue(due(0))).toBe("today");
  expect(isOverdue(due(0))).toBe(false);

  // The case that was actually broken: a due time already past, on today's
  // date. Comparing instants called this overdue and coloured it as a warning.
  expect(untilDue(earlierToday())).toBe("today");
  expect(isOverdue(earlierToday())).toBe(false);
});

test("tomorrow and the days after it count forward", () => {
  expect(untilDue(due(1))).toBe("tomorrow");
  expect(untilDue(due(4))).toBe("in 4 days");
  expect(isOverdue(due(1))).toBe(false);
});

test("yesterday and earlier count back, and are late", () => {
  expect(untilDue(due(-1))).toBe("yesterday");
  expect(untilDue(due(-8))).toBe("8 days late");
  expect(isOverdue(due(-1))).toBe(true);
});

test("a task with no due date is neither late nor dated", () => {
  // A to-do somebody has not scheduled. Colouring it as overdue would make the
  // panel shout about something nobody promised.
  expect(untilDue(null)).toBe("no date");
  expect(isOverdue(null)).toBe(false);
});

test("today is the business's day, not the reader's or UTC's", () => {
  // Eight in the evening in New York on 9 October is already the 10th in UTC.
  // A task due on the 9th is due today there, and one due on the 10th is
  // tomorrow — whichever laptop is reading it.
  setSystemTime(new Date("2026-10-10T00:00:00Z"));
  setFormats({ businessTimezone: "America/New_York" });
  expect(untilDue("2026-10-09T12:00:00.000Z")).toBe("today");
  expect(isOverdue("2026-10-09T12:00:00.000Z")).toBe(false);
  expect(untilDue("2026-10-10T12:00:00.000Z")).toBe("tomorrow");

  // The same instant for a business with no zone set is UTC's 10th.
  setFormats({ businessTimezone: "" });
  expect(untilDue("2026-10-09T12:00:00.000Z")).toBe("yesterday");
});
