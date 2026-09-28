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
  if (!zone) {
    return {
      year: when.getFullYear(),
      month: when.getMonth() + 1,
      day: when.getDate(),
      hours: when.getHours(),
      minutes: when.getMinutes(),
      weekday: when.getDay(),
    };
  }

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
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
  if (!zone) {
    return new Date(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hours,
      parts.minutes,
    );
  }

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
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  return dateFrom(`${value}T00:00:00.000Z`);
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
