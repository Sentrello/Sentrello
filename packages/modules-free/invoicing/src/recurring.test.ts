import { expect, test } from "bun:test";
import { parseDate, validateProfile } from "./recurring";

/**
 * A schedule bills a customer unattended, so what it will not accept matters
 * more than what it will. Each of these produced either a profile that never
 * fired or one that fired for ever.
 */

test("a schedule needs an interval it actually knows", () => {
  expect(
    validateProfile({ interval: "fortnightly", nextRunAt: "2026-09-01" }),
  ).toHaveProperty("error");
  expect(
    validateProfile({ interval: "weekly", nextRunAt: "2026-09-01" }).error,
  ).toBeUndefined();
});

test("a schedule needs a date it can start on", () => {
  expect(validateProfile({ interval: "monthly" }).error).toBeTruthy();
  // Not an Invalid Date silently stored as null and never run.
  expect(
    validateProfile({ interval: "monthly", nextRunAt: "the first" }).error,
  ).toBeTruthy();
});

test("a schedule cannot end before it starts", () => {
  const checked = validateProfile({
    interval: "monthly",
    nextRunAt: "2026-09-01",
    endsOn: "2026-08-01",
  });
  expect(checked.error).toBeTruthy();
});

test("every zero months is not a schedule", () => {
  // Stored as 0 it would re-issue on every run against the same customer,
  // because the next run never moves.
  const checked = validateProfile({
    interval: "monthly",
    nextRunAt: "2026-09-01",
    intervalCount: 0,
  });
  expect(checked.intervalCount).toBe(1);
  expect(
    validateProfile({
      interval: "monthly",
      nextRunAt: "2026-09-01",
      intervalCount: 2.7,
    }).intervalCount,
  ).toBe(2);
});

test("a date is either real or nothing", () => {
  expect(parseDate("2026-09-01")?.toISOString()).toBe(
    "2026-09-01T00:00:00.000Z",
  );
  expect(parseDate("")).toBeNull();
  expect(parseDate("nonsense")).toBeNull();
  expect(parseDate(undefined)).toBeNull();
});
