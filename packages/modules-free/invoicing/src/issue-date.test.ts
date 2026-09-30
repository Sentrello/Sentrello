import { expect, test } from "bun:test";
import { dayIn } from "@sentrello/db/day";
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
/**
 * The day the function should think it is, passed rather than faked.
 *
 * It used to override `Date.now`, which the function did not read — its default
 * argument called `new Date()`, and nothing outside a module can fake that. So
 * these tests were asserting against the real calendar: they passed all day on
 * 29 September and failed at midnight UTC, naming a date that had become
 * yesterday. The parameter exists for exactly this.
 */
const day = (iso: string) => dayIn(new Date(iso), null);

test("today is not the future, whatever the hour", () => {
  for (const hour of ["00:01", "09:00", "11:59", "13:00", "23:59"]) {
    const out = requestedIssueDate("2026-09-29", day(`2026-09-29T${hour}:00Z`));
    expect(
      out instanceof Error ? out.message : "ok",
      `dating an invoice today at ${hour} UTC`,
    ).toBe("ok");
  }
});

test("tomorrow still is the future", () => {
  const out = requestedIssueDate("2026-09-30", day("2026-09-29T23:59:00Z"));
  expect(out instanceof Error).toBe(true);
  expect((out as Error).message).toContain("future");
});

test("a date somebody typed badly is still refused", () => {
  expect(requestedIssueDate("2026-02-30") instanceof Error).toBe(true);
  expect(requestedIssueDate(42) instanceof Error).toBe(true);
});

test("nothing given is today", () => {
  const out = requestedIssueDate(undefined, day("2026-09-29T09:00:00Z"));
  expect(out instanceof Error).toBe(false);
  expect((out as Date).toISOString().slice(0, 10)).toBe("2026-09-29");
});

/**
 * And with nothing passed at all it reads the clock, which is what every caller
 * does. Asserted as a shape rather than a date, so this cannot become the test
 * that fails at midnight again.
 */
test("and with no day given it takes today from the clock", () => {
  const out = requestedIssueDate(undefined);
  expect(out instanceof Error).toBe(false);
  const iso = (out as Date).toISOString();
  expect(iso).toBe(dayIn(new Date(Date.now()), null).toISOString());
  expect(iso.slice(11)).toBe("00:00:00.000Z");
});
