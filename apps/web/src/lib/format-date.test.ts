import { expect, test } from "bun:test";
import { formatDate, setFormats } from "./ui";

/**
 * A date somebody typed must read back as the date they typed.
 *
 * Found by looking at a screen: a certificate entered as expiring on 10
 * September was listed as expiring on the 9th. Calendar dates are stored as
 * midnight UTC, and every customer in our first market reads them from a
 * timezone behind it — so every due date, every expiry and every date of birth
 * was a day early for all of them.
 */

test("a calendar date reads back as itself, whatever the reader's timezone", () => {
  setFormats({ dateFormat: "ISO", timezone: "America/Denver" });
  expect(formatDate("2026-09-10T00:00:00.000Z")).toBe("Sep 10, 2026");
  expect(formatDate("2026-09-10")).toBe("Sep 10, 2026");

  // And east of UTC, where the same value was already right.
  setFormats({ timezone: "Australia/Sydney" });
  expect(formatDate("2026-09-10T00:00:00.000Z")).toBe("Sep 10, 2026");
});

test("a moment in time is still shown in the reader's timezone", () => {
  setFormats({ dateFormat: "ISO", timezone: "America/Denver" });
  // Half past midnight in London on the 10th is still the evening of the 9th
  // in Denver, and a timestamp should say so.
  expect(formatDate("2026-09-10T00:30:00.000Z")).toBe("Sep 9, 2026");
});

test("nothing, and nonsense, come back as a dash", () => {
  expect(formatDate(null)).toBe("—");
  expect(formatDate(undefined)).toBe("—");
  expect(formatDate("the first of never")).toBe("—");
});
