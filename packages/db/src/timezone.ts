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
