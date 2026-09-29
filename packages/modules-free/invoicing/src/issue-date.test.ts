import { expect, test } from "bun:test";
import { requestedIssueDate } from "./lifecycle";

/**
 * A business can issue an invoice dated today, at any hour of the day.
 *
 * A typed `YYYY-MM-DD` is read as **midday UTC** — a trick from before
 * `calendarDay` existed, meant to stop a date rolling to the day before when it
 * is rendered west of Greenwich. The future check then compared that midday
 * against `Date.now()`, so for every minute before noon UTC the answer to "issue
 * this, dated today" was *an invoice cannot be issued with a date in the future*.
 *
 * That is the whole morning in our four markets: until 8am in New York, 5am in
 * Los Angeles, 1pm in London and 2pm in Berlin. The one thing a trade business
 * does with an invoice screen is date it today.
 *
 * Days, not instants — the rule the rest of the product now follows.
 */
const at = (iso: string) => {
  const real = Date.now;
  Date.now = () => new Date(iso).getTime();
  return () => {
    Date.now = real;
  };
};

test("today is not the future, whatever the hour", () => {
  for (const hour of ["00:01", "09:00", "11:59", "13:00", "23:59"]) {
    const restore = at(`2026-09-29T${hour}:00Z`);
    try {
      const out = requestedIssueDate("2026-09-29");
      expect(
        out instanceof Error ? out.message : "ok",
        `dating an invoice today at ${hour} UTC`,
      ).toBe("ok");
    } finally {
      restore();
    }
  }
});

test("tomorrow still is the future", () => {
  const restore = at("2026-09-29T23:59:00Z");
  try {
    const out = requestedIssueDate("2026-09-30");
    expect(out instanceof Error).toBe(true);
    expect((out as Error).message).toContain("future");
  } finally {
    restore();
  }
});

test("a date somebody typed badly is still refused", () => {
  expect(requestedIssueDate("2026-02-30") instanceof Error).toBe(true);
  expect(requestedIssueDate(42) instanceof Error).toBe(true);
});

test("nothing given is today", () => {
  const restore = at("2026-09-29T09:00:00Z");
  try {
    const out = requestedIssueDate(undefined);
    expect(out instanceof Error).toBe(false);
    expect((out as Date).toISOString().slice(0, 10)).toBe("2026-09-29");
  } finally {
    restore();
  }
});
