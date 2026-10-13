import { expect, test } from "bun:test";
import {
  UnreadableDateError,
  dateFrom,
  dayFrom,
  demandDate,
  demandMomentTyped,
  knownTimezone,
  momentAt,
  momentTyped,
  partsIn,
} from "./timezone";

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

  // The ones somebody actually types. Neither is an IANA name, and every
  // calculation would quietly fall back to the server's own.
  //
  // Only names the product promises are asserted here. The POSIX-style legacy
  // spellings — "EST5EDT" and its kin — are accepted by some builds of ICU and
  // refused by others, so asserting either answer tests the machine the tests
  // happen to run on. This one did exactly that: it passed on a Mac, failed on
  // Linux, and the difference was nothing to do with Sentrello.
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

/**
 * The two nights a year a wall clock names no moment, or two.
 *
 * Guessing and correcting picked a side by the sign of the offset: half past
 * two on New York's spring-forward morning came back as 01:30, an hour early,
 * and London's skipped half past one as 02:30; in the repeated hour New York
 * took the first pass and London the second. One rule now, in both: a skipped
 * time is the moment the clock jumps past it, a repeated one its first
 * occurrence.
 */
test("a time the clock skips is the moment it jumps past it, in every zone", () => {
  // New York, 8 March 2026: 01:59 EST is followed by 03:00 EDT.
  const newYork = momentAt(
    { year: 2026, month: 3, day: 8, hours: 2, minutes: 30 },
    "America/New_York",
  );
  expect(newYork.toISOString()).toBe("2026-03-08T07:30:00.000Z");
  expect(partsIn(newYork, "America/New_York")).toMatchObject({
    day: 8,
    hours: 3,
    minutes: 30,
  });

  // London, 29 March 2026: 00:59 GMT is followed by 02:00 BST.
  const london = momentAt(
    { year: 2026, month: 3, day: 29, hours: 1, minutes: 30 },
    "Europe/London",
  );
  expect(london.toISOString()).toBe("2026-03-29T01:30:00.000Z");
  expect(partsIn(london, "Europe/London")).toMatchObject({
    day: 29,
    hours: 2,
    minutes: 30,
  });
});

test("a time the clock repeats is its first occurrence, in every zone", () => {
  // New York, 1 November 2026: 01:30 happens in EDT, then again in EST.
  expect(
    momentAt(
      { year: 2026, month: 11, day: 1, hours: 1, minutes: 30 },
      "America/New_York",
    ).toISOString(),
  ).toBe("2026-11-01T05:30:00.000Z");

  // London, 25 October 2026: 01:30 happens in BST, then again in GMT.
  expect(
    momentAt(
      { year: 2026, month: 10, day: 25, hours: 1, minutes: 30 },
      "Europe/London",
    ).toISOString(),
  ).toBe("2026-10-25T00:30:00.000Z");
});

test("the hours either side of a change are the ordinary ones", () => {
  const cases: [string, number, number, number, string][] = [
    ["America/New_York", 3, 8, 1, "2026-03-08T06:00:00.000Z"],
    ["America/New_York", 3, 8, 3, "2026-03-08T07:00:00.000Z"],
    ["America/New_York", 11, 1, 0, "2026-11-01T04:00:00.000Z"],
    ["America/New_York", 11, 1, 2, "2026-11-01T07:00:00.000Z"],
    ["Europe/London", 3, 29, 0, "2026-03-29T00:00:00.000Z"],
    ["Europe/London", 3, 29, 2, "2026-03-29T01:00:00.000Z"],
    ["Europe/London", 10, 25, 0, "2026-10-24T23:00:00.000Z"],
    ["Europe/London", 10, 25, 2, "2026-10-25T02:00:00.000Z"],
  ];
  for (const [zone, month, day, hours, iso] of cases) {
    expect(
      momentAt({ year: 2026, month, day, hours, minutes: 0 }, zone),
    ).toEqual(new Date(iso));
  }
});

/**
 * No timezone means UTC, never the clock the server happens to keep.
 *
 * This asserted the opposite until 3 October, with a reason worth recording:
 * no timezone means the server's own, which is what a box in the office wants.
 * The cost was higher than the convenience. An organization has no timezone
 * until somebody fills one in, so the fallback is the *default* state of a
 * fresh instance — and in that state the same instance answered "has nine
 * o'clock come round" differently depending on what `TZ` its container was
 * started with. A business's hours moving because somebody restarted a machine
 * is not something anybody can debug.
 *
 * **It was invisible here, and that is the other half.** `bun test` runs in
 * UTC whatever zone the machine keeps, so the old assertion passed on a laptop
 * in Denver and would have passed on any laptop anywhere. Only
 * `TZ=America/Denver bun test` could tell the two rules apart. A test for a
 * clock has to say which clock, out loud, or the runner picks one for it.
 *
 * Asserted against an explicit "UTC" rather than against numbers, so this says
 * what the rule is instead of restating arithmetic. And `momentAt` has to agree
 * with `partsIn` about an unset zone or a round trip moves the time, which is
 * the second half below.
 */
test("no timezone is UTC, not the server's own", () => {
  // 00:30 UTC lands on a different *day* in both directions: still yesterday
  // evening in Denver, already lunchtime in Auckland. A server in either would
  // disagree about every field, not just the hour.
  const when = new Date("2026-07-15T00:30:00Z");

  expect(partsIn(when, null)).toEqual(partsIn(when, "UTC"));
  expect(partsIn(when, null).hours).toBe(0);
  expect(partsIn(when, null).day).toBe(15);

  // And back again, which is what keeps a stored day and a read day the same.
  expect(
    momentAt(
      { year: 2026, month: 7, day: 15, hours: 0, minutes: 30 },
      null,
    ).toISOString(),
  ).toBe("2026-07-15T00:30:00.000Z");
  expect(
    momentAt({ year: 2026, month: 7, day: 15, hours: 0, minutes: 30 }, null),
  ).toEqual(
    momentAt({ year: 2026, month: 7, day: 15, hours: 0, minutes: 30 }, "UTC"),
  );
});

test("a date is a date", () => {
  expect(dayFrom("2026-03-31")?.toISOString()).toBe("2026-03-31T00:00:00.000Z");
  expect(dayFrom("31/03/2026")).toBeNull();
  expect(dayFrom("")).toBeNull();
  expect(dayFrom(null)).toBeNull();
});

/**
 * The 30th of February is not a date, and `new Date` says it is.
 *
 * It rolls the impossible day forward rather than refusing it, so a shape
 * check of `YYYY-MM-DD` passes a day that never existed straight through — and
 * everything downstream sees the 2nd of March, in the wrong month, looking
 * entirely valid. The round trip is what catches it.
 */
test("a day that never existed is refused, not rolled into the next month", () => {
  expect(dayFrom("2026-02-30")).toBeNull();
  expect(dayFrom("2026-02-28")?.toISOString()).toBe("2026-02-28T00:00:00.000Z");
  expect(dayFrom("2026-04-31")).toBeNull();
  expect(dayFrom("2026-13-01")).toBeNull();
  expect(dayFrom("2026-00-10")).toBeNull();
  expect(dayFrom("2026-01-00")).toBeNull();
});

test("a leap day exists in a leap year and nowhere else", () => {
  expect(dayFrom("2024-02-29")?.toISOString()).toBe("2024-02-29T00:00:00.000Z");
  expect(dayFrom("2026-02-29")).toBeNull();
  // 1900 was not a leap year; 2000 was. The century rule is the one every
  // hand-rolled check gets wrong, so it is the runtime's and not ours.
  expect(dayFrom("1900-02-29")).toBeNull();
  expect(dayFrom("2000-02-29")?.toISOString()).toBe("2000-02-29T00:00:00.000Z");
});

/** A time on the end does not excuse the day: `new Date` rolls that too. */
test("a date with a time is held to the same day", () => {
  expect(dateFrom("2026-02-30T12:00:00.000Z")).toBeNull();
  expect(dateFrom("2026-02-30 12:00")).toBeNull();
  expect(dateFrom("2026-02-28T12:00:00.000Z")?.toISOString()).toBe(
    "2026-02-28T12:00:00.000Z",
  );
  expect(dateFrom("not a date")).toBeNull();
  expect(dateFrom(null)).toBeNull();
});

test("demandDate refuses out loud, carrying the value that was wrong", () => {
  expect(() => demandDate("2026-02-30")).toThrow(UnreadableDateError);
  expect(() => demandDate("2026-02-30")).toThrow("2026-02-30");
  expect(demandDate("2026-02-28").toISOString()).toBe(
    "2026-02-28T00:00:00.000Z",
  );
});

/**
 * A time somebody typed, read where the business is.
 *
 * `<input type="datetime-local">` sends `2026-10-12T09:00` and says nothing about
 * a zone, and a zone-less date-time is parsed in the *runtime's* zone. In the
 * shipped container that is UTC, so a business in Denver that scheduled a
 * campaign for nine in the morning had nine UTC stored — three in the morning
 * where they are — and the screen showed them three, because the browser renders
 * the instant in its own zone.
 */
test("a typed wall clock belongs to the business, not to the server", () => {
  const typed = "2026-10-12T09:00";
  // Nine in Denver in October is 15:00 UTC.
  expect(momentTyped(typed, "America/Denver")?.toISOString()).toBe(
    "2026-10-12T15:00:00.000Z",
  );
  // And in Berlin, 07:00 UTC.
  expect(momentTyped(typed, "Europe/Berlin")?.toISOString()).toBe(
    "2026-10-12T07:00:00.000Z",
  );
  // No zone set is UTC, like everything else here — never the server's clock.
  expect(momentTyped(typed, null)?.toISOString()).toBe(
    "2026-10-12T09:00:00.000Z",
  );
});

test("a string that names its own zone is taken at its word", () => {
  // What an API caller sends, and what the product stores and hands back.
  expect(
    momentTyped("2026-10-12T09:00:00.000Z", "America/Denver")?.toISOString(),
  ).toBe("2026-10-12T09:00:00.000Z");
  expect(
    momentTyped("2026-10-12T09:00:00-06:00", "Europe/Berlin")?.toISOString(),
  ).toBe("2026-10-12T15:00:00.000Z");
});

test("an impossible date is still refused rather than rolled forward", () => {
  expect(momentTyped("2026-02-30T09:00", "America/Denver")).toBeNull();
  expect(momentTyped("not a date", null)).toBeNull();
  expect(momentTyped(undefined, null)).toBeNull();
  expect(() => demandMomentTyped("2026-02-30T09:00", null)).toThrow();
});
