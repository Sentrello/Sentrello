import { expect, test } from "bun:test";
import { parseDate } from "./transactions";

/**
 * A list of one day is not the day.
 *
 * `String(["2026-03-04"])` is "2026-03-04", so a transaction sent with its
 * date wrapped in a list was booked on that day as if nothing were wrong —
 * the same coercion that stored the year 500 on the CRM's timestamps.
 */
test("a list or an object where a transaction's day belongs is refused", () => {
  const today = new Date("2026-10-09T00:00:00.000Z");
  expect(parseDate(["2026-03-04"], today)).toBeNull();
  expect(parseDate({}, today)).toBeNull();
  expect(parseDate([], today)).toBeNull();
  expect(parseDate("2026-03-04", today)?.toISOString()).toBe(
    "2026-03-04T00:00:00.000Z",
  );
  expect(parseDate(undefined, today)).toBe(today);
});
