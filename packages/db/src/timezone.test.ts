import { expect, test } from "bun:test";
import { knownTimezone, momentAt, partsIn } from "./timezone";

/**
 * Where a business is, in time.
 *
 * A server rented in another country is the ordinary case for a business paying
 * for hosting, and nine o'clock there is not nine o'clock here. Everything that
 * acts at a time of day depends on this being right: an automation chasing
 * quiet deals every Monday at nine went out on Sunday evening for a business
 * whose server was in Frankfurt, and nothing anywhere explained why.
 */

test("a name the runtime knows is accepted, and a plausible one is not", () => {
  expect(knownTimezone("America/New_York")).toBe(true);
  expect(knownTimezone("Europe/London")).toBe(true);
  expect(knownTimezone("UTC")).toBe(true);

  // The one somebody actually types. It is not an IANA name and every
  // calculation would quietly fall back to the server's own.
  expect(knownTimezone("EST5EDT")).toBe(true); // a real one, oddly
  expect(knownTimezone("Eastern Standard Time")).toBe(false);
  expect(knownTimezone("GMT+5")).toBe(false);
  expect(knownTimezone("")).toBe(false);
});

/**
 * The same moment, read in two places.
 *
 * Nine in the morning in London is four in the morning in New York, and a rule
 * set for nine has not come round there yet.
 */
test("one moment reads as different hours in different places", () => {
  const when = new Date("2026-06-15T09:00:00Z");
  expect(partsIn(when, "Europe/London").hours).toBe(10); // BST
  expect(partsIn(when, "America/New_York").hours).toBe(5); // EDT
  expect(partsIn(when, "UTC").hours).toBe(9);
});

test("the day and the weekday are the local ones, not the server's", () => {
  // Late evening in New York is already tomorrow in London.
  const when = new Date("2026-06-15T23:30:00-04:00");
  const london = partsIn(when, "Europe/London");
  expect(london.day).toBe(16);
  expect(london.weekday).toBe(2); // Tuesday

  const newYork = partsIn(when, "America/New_York");
  expect(newYork.day).toBe(15);
  expect(newYork.weekday).toBe(1); // Monday
});

/**
 * Building a moment from a wall-clock time, which is the operation that does
 * not exist and the mistake everybody makes trying.
 */
test("nine o'clock somewhere is the moment it really is", () => {
  const nine = momentAt(
    { year: 2026, month: 6, day: 15, hours: 9, minutes: 0 },
    "America/New_York",
  );
  // Nine in New York in June is one in the afternoon UTC.
  expect(nine.toISOString()).toBe("2026-06-15T13:00:00.000Z");
  expect(partsIn(nine, "America/New_York").hours).toBe(9);
});

test("and the same in winter, when the offset is different", () => {
  const nine = momentAt(
    { year: 2026, month: 1, day: 15, hours: 9, minutes: 0 },
    "America/New_York",
  );
  // Nine in New York in January is two in the afternoon UTC.
  expect(nine.toISOString()).toBe("2026-01-15T14:00:00.000Z");
});

/**
 * The reason this is not an offset stored once.
 *
 * A business that wrote down "-05:00" in January is an hour out from March, and
 * every reminder it sends for seven months of the year goes at the wrong time.
 */
test("a place keeps its nine o'clock across a clock change", () => {
  for (const month of [1, 4, 7, 10]) {
    const nine = momentAt(
      { year: 2026, month, day: 15, hours: 9, minutes: 0 },
      "Europe/London",
    );
    expect(partsIn(nine, "Europe/London").hours).toBe(9);
  }
});

/** No timezone means the server's own, which is what a box in the office wants. */
test("no timezone is the server's own", () => {
  const when = new Date(2026, 5, 15, 9, 30);
  const parts = partsIn(when, null);
  expect(parts.hours).toBe(9);
  expect(parts.minutes).toBe(30);
  expect(
    momentAt(
      { year: 2026, month: 6, day: 15, hours: 9, minutes: 30 },
      null,
    ).getTime(),
  ).toBe(when.getTime());
});
