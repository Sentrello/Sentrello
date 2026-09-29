/**
 * A due date names a day. The product had been reading it as an instant.
 *
 * Stored as midnight UTC — somebody typed 29 October and meant the 29th
 * everywhere — and then compared with `dueDate < now`, which is true at one
 * second past midnight. So an invoice due on the 29th was **late for the whole
 * of the 29th**, on the dashboard, in the overdue tab, on the badge the
 * customer sees on their own copy. The money was not late. The day had barely
 * started.
 *
 * West of Greenwich it is worse, because midnight UTC is the evening before: a
 * business in New York watched an invoice turn red at eight o'clock on the
 * 28th. Their books are kept where they are, not where the server is.
 *
 * And the product already knew better in one place. A task due today is not
 * overdue today — `apps/web/src/lib/tasks.tsx` has said so since it was
 * written. Two things a business is late for, two different rules.
 *
 * So lateness is a comparison of days, and the day a business is having comes
 * from the timezone in its own settings. No zone set means UTC, deliberately
 * rather than the server's clock: where a business keeps its books should not
 * depend on where somebody rented a machine.
 *
 * Pure, and importing nothing. `@sentrello/db` pulls in a connection, and the
 * shop's customer pages and the licensing client both need these without one.
 */

/** The calendar day a moment falls on, where the business is, as that day's midnight UTC. */
export function dayIn(when: Date, zone: string | null): Date {
  // `en-CA` is year-month-day, which is the one ordering that needs no parsing
  // back into the right fields.
  //
  // A name the runtime cannot resolve throws, and a stored timezone can be one:
  // `knownTimezone` guards the settings screen today, and rows written before it
  // did are still rows. UTC then — a report a day out is a complaint, a report
  // that throws is a screen with nothing on it.
  let text: string;
  try {
    text = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(when);
  } catch {
    text = when.toISOString().slice(0, 10);
  }
  const [year, month, day] = text.split("-").map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
}

/**
 * The day a stored date stands for: its **UTC** day, whatever the reader's zone.
 *
 * Not `dayIn(due, zone)`. A due date is written down as midnight UTC on the day
 * that was typed, so reading it in New York gives the day before — which is the
 * off-by-one this whole file exists to stop.
 */
export function dayOf(due: Date): Date {
  return new Date(
    Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate()),
  );
}

const DAY_MS = 86_400_000;

/**
 * Whole days late: 0 on the day it is due, 1 the morning after, negative before.
 *
 * The chase rules are written in these numbers — "three days before" is -3 and
 * "on the day" is 0 — so the zero has to mean the whole of the due day, as it
 * reads on a screen to whoever set the rule.
 */
export function daysLate(due: Date, now: Date, zone: string | null): number {
  return Math.round(
    (dayIn(now, zone).getTime() - dayOf(due).getTime()) / DAY_MS,
  );
}
