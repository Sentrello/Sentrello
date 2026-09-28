import { expect, test } from "bun:test";
import { isOverdue, nextRun } from "./dates";

const utc = (s: string) => new Date(`${s}T00:00:00.000Z`);

test("monthly advances one month", () => {
  expect(nextRun(utc("2026-03-15"), "monthly").toISOString()).toBe(
    "2026-04-15T00:00:00.000Z",
  );
});

test("monthly clamps to month end: Jan 31 -> Feb 28", () => {
  expect(nextRun(utc("2026-01-31"), "monthly").toISOString()).toBe(
    "2026-02-28T00:00:00.000Z",
  );
});

test("monthly clamps to Feb 29 in a leap year", () => {
  expect(nextRun(utc("2028-01-31"), "monthly").toISOString()).toBe(
    "2028-02-29T00:00:00.000Z",
  );
});

test("monthly clamps Mar 31 -> Apr 30", () => {
  expect(nextRun(utc("2026-03-31"), "monthly").toISOString()).toBe(
    "2026-04-30T00:00:00.000Z",
  );
});

test("yearly advances one year", () => {
  expect(nextRun(utc("2026-06-01"), "yearly").toISOString()).toBe(
    "2027-06-01T00:00:00.000Z",
  );
});

test("yearly clamps Feb 29 -> Feb 28 on a non-leap year", () => {
  expect(nextRun(utc("2028-02-29"), "yearly").toISOString()).toBe(
    "2029-02-28T00:00:00.000Z",
  );
});

test("nextRun does not mutate its argument", () => {
  const from = utc("2026-01-31");
  nextRun(from, "monthly");
  expect(from.toISOString()).toBe("2026-01-31T00:00:00.000Z");
});

test("isOverdue needs both a past due date and a positive balance", () => {
  const now = utc("2026-08-09");
  expect(isOverdue(utc("2026-08-01"), 5000, now)).toBe(true);
  expect(isOverdue(utc("2026-08-01"), 0, now)).toBe(false); // paid
  expect(isOverdue(utc("2026-09-01"), 5000, now)).toBe(false); // not yet due
});

test("every two weeks is one schedule, not two", () => {
  expect(nextRun(utc("2026-03-02"), "weekly", 2).toISOString()).toBe(
    "2026-03-16T00:00:00.000Z",
  );
});

test("quarterly advances three months and still clamps", () => {
  expect(nextRun(utc("2026-01-31"), "quarterly").toISOString()).toBe(
    "2026-04-30T00:00:00.000Z",
  );
});

test("daily advances a day, and every N days when asked", () => {
  expect(nextRun(utc("2026-02-28"), "daily").toISOString()).toBe(
    "2026-03-01T00:00:00.000Z",
  );
  expect(nextRun(utc("2026-03-01"), "daily", 10).toISOString()).toBe(
    "2026-03-11T00:00:00.000Z",
  );
});

test("a count of zero still moves the schedule on", () => {
  // A profile stored with intervalCount 0 would otherwise be re-issued on
  // every run, for ever, against the same customer.
  expect(nextRun(utc("2026-03-15"), "monthly", 0).toISOString()).toBe(
    "2026-04-15T00:00:00.000Z",
  );
});
