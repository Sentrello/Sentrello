import { expect, test } from "bun:test";
import { isOverdue, untilDue } from "./tasks";

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

/** A due date `days` from today, stamped at midday the way the form writes it. */
function due(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}T12:00:00.000Z`;
}

/**
 * A moment that is unambiguously earlier today, whenever the suite is run.
 *
 * `due(0)` alone is not enough to pin this down: it lands at midday UTC, which
 * is in the past by the afternoon and in the future all morning — so a test
 * built on it would catch the bug for half of each day and pass for the other
 * half. One second after midnight local is earlier today at every hour except
 * the first second of one.
 */
function earlierToday(): string {
  const d = new Date();
  d.setHours(0, 0, 1, 0);
  return d.toISOString();
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
