import { organizations } from "./auth-schema";
import { db, eq } from "./index";

/**
 * Where a business is, in time.
 *
 * Anything that acts at a *time of day* has to know: an automation chasing
 * quiet deals every Monday at nine, a report of "yesterday", a shift that ends
 * at midnight. A server rented in another country is the ordinary case for a
 * business paying for hosting, and nine o'clock there is not nine o'clock here.
 *
 * **An IANA name, never an offset.** "America/New_York" rather than "-05:00",
 * because an offset is wrong for half the year and the business that wrote it
 * down means the same nine o'clock in March and in November.
 */

/**
 * Whether this machine can actually resolve a timezone.
 *
 * A name the runtime does not know does not fail loudly — the calculation falls
 * back to the server's own — so a business that typed "EST" would find its
 * reminders going out at the wrong hour with nothing anywhere saying why. This
 * is what lets a screen refuse it while somebody is still looking at the form.
 */
export function knownTimezone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** The business's own, or the server's when it has not said. */
export async function timezoneFor(orgId: string): Promise<string | null> {
  const [org] = await db
    .select({ timezone: organizations.timezone })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const zone = org?.timezone ?? null;
  return zone && knownTimezone(zone) ? zone : null;
}

/**
 * The wall-clock parts of a moment, where the business is.
 *
 * Returned as numbers rather than a Date, deliberately. A Date is a moment, and
 * "what is the hour there" is not a moment — building a Date "in" a timezone is
 * the operation that does not exist and the mistake everybody makes trying.
 * Whoever is deciding whether nine o'clock has come round wants the hour, and
 * that is what this gives them.
 */
export function partsIn(
  when: Date,
  zone: string | null,
): {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
  weekday: number;
} {
  /*
   * **No zone set means UTC, never the server's clock.**
   *
   * This read `getHours()` and friends, and the test beside it argued for that:
   * no timezone means the server's own, which is what a box in the office
   * wants. The reasoning is real and the cost was higher. An organization has
   * no timezone until somebody fills one in, so the fallback is the *default*
   * state of a fresh instance rather than an edge — and in that state the same
   * instance answered "has nine o'clock come round" differently depending on
   * what `TZ` the container was started with. A business's own hours moving
   * because somebody restarted a machine is not a thing anybody can debug.
   *
   * UTC is the one answer that is the same everywhere, which makes it the only
   * safe thing to assume when nobody has said. It is also what the platform's
   * date rule already promised in writing. James, 3 October 2026: fix it to
   * UTC, and have onboarding ask for the timezone so this is never what a real
   * business is running on.
   */
  const where = zone ?? "UTC";

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: where,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(when);

  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const weekdayName = (
    parts.find((part) => part.type === "weekday")?.value ?? ""
  )
    .slice(0, 3)
    .toLowerCase();

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    /*
     * Midnight reads as 24 in some runtimes with hour12 false, which is the
     * same instant and a different number — and a rule set for midnight would
     * never come round.
     */
    hours: get("hour") % 24,
    minutes: get("minute"),
    weekday: Math.max(0, days.indexOf(weekdayName)),
  };
}

/**
 * The moment that is this wall-clock time, where the business is.
 *
 * Built by guessing and correcting, because there is no way to construct a Date
 * from parts in another zone directly. The guess is UTC; the correction is how
 * far off the answer reads when rendered back. One correction settles every
 * ordinary case, and a second settles the hour on either side of a clock change
 * — where the first guess can land in the offset that is about to end.
 */
export function momentAt(
  parts: {
    year: number;
    month: number;
    day: number;
    hours: number;
    minutes: number;
  },
  zone: string | null,
): Date {
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hours,
    parts.minutes,
  );
  // The inverse of `partsIn`, and it has to agree with it about an unset zone
  // or a round trip moves the time. UTC both ways — see the note there.
  if (!zone) return new Date(asUtc);

  let guess = new Date(asUtc);
  for (let i = 0; i < 2; i++) {
    const seen = partsIn(guess, zone);
    const drift =
      asUtc -
      Date.UTC(seen.year, seen.month - 1, seen.day, seen.hours, seen.minutes);
    if (drift === 0) break;
    guess = new Date(guess.getTime() + drift);
  }
  return guess;
}

/**
 * `2026-03-31` → the first instant of that day, in UTC.
 *
 * Not the last instant, despite how it reads: `plan()` in the accounting
 * year-end close adds one day to a previous year end's `dayFrom` to get the
 * start of the next period, and that arithmetic only lands on midnight
 * because this is midnight. The year-end close gets the *last* instant of
 * the closing date from its own local `endOfDay()`, deliberately a different
 * function — this one is start-of-day everywhere it is used.
 */
export function dayFrom(value: unknown): Date | null {
  /*
   * The day *named* at the front, so a full timestamp gives up its date rather
   * than being refused — `2026-10-15T20:00:00-05:00` is the 15th to whoever
   * typed it, and stored as the instant it would be the 16th in UTC, which is
   * the day the aging buckets and every comparison would then read.
   */
  const named =
    typeof value === "string"
      ? /^(\d{4}-\d{2}-\d{2})(?:[T ]|$)/.exec(value.trim())?.[1]
      : undefined;
  if (!named) return null;
  return dateFrom(`${named}T00:00:00.000Z`);
}

/**
 * The exclusive upper bound of a date-only filter: the midnight after the day.
 *
 * "to 15 September" means the whole of the fifteenth, not its first second —
 * and the same five lines were written out in four modules, each reading the
 * value with a bare `new Date`. A nonsense `to` therefore became an Invalid
 * Date and the list answered 500 "something went wrong" to `to=not-a-date`,
 * which is an ordinary typing mistake in a query string. Here it is one
 * function, and it refuses what it cannot read.
 */
export function dayAfter(value: unknown): Date {
  const day = demandDay(value);
  return new Date(day.getTime() + 86_400_000);
}

/**
 * `dayFrom`, insisting — a 400 through `app.onError`, like `demandDate`.
 *
 * Reach for this wherever a *day* is being stored: a due date, a validity, an
 * expiry, the date on a journal entry. `demandDate` is for a moment.
 */
export function demandDay(value: unknown): Date {
  const day = dayFrom(value);
  if (!day) {
    throw new UnreadableDateError(`"${String(value)}" is not a real date`);
  }
  return day;
}

/**
 * A date somebody typed, refusing a day that never existed.
 *
 * `new Date` rolls an impossible day *forward* without complaint: the 30th of
 * February becomes the 2nd of March, `2024-02-29` is a real day and
 * `2026-02-29` is the 1st of March. A shape check of `YYYY-MM-DD` cannot see
 * the difference, and neither can anything downstream — by then it is a
 * perfectly valid date, in the wrong month.
 *
 * That matters here more than it would elsewhere, because a date in this
 * product decides *which period a figure lands in*: an accounting period, a
 * VAT quarter, a US filing period, a retention window, a statement window. A
 * day that rolls silently puts money in a month nobody chose and passes every
 * check after it.
 *
 * The test is a round trip. A day that does not format back to the one it was
 * given was never that day. The month and year need no such check — `new Date`
 * already refuses `2026-13-01` and `2026-00-10` outright.
 */
export function dateFrom(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;

  const named = /^(\d{4}-\d{2}-\d{2})/.exec(text)?.[1];
  if (named) {
    const probe = new Date(`${named}T00:00:00.000Z`);
    if (
      Number.isNaN(probe.getTime()) ||
      probe.toISOString().slice(0, 10) !== named
    ) {
      return null;
    }
  }
  return parsed;
}

/**
 * A date that is not readable is a 400, wherever it was read.
 *
 * Thrown rather than returned so that the places a date is parsed *deep* in a
 * request — a list filter, a report period, a query parameter three functions
 * below the route — can refuse without every one of them growing its own
 * error path. `app.onError` turns this into a 400 carrying the value that was
 * wrong, which is the difference between a form somebody can correct and a
 * filter that quietly went missing.
 */
export class UnreadableDateError extends Error {}

/** `dateFrom`, insisting. */
export function demandDate(value: unknown): Date {
  const date = dateFrom(value);
  if (!date) {
    throw new UnreadableDateError(`"${String(value)}" is not a real date`);
  }
  return date;
}
