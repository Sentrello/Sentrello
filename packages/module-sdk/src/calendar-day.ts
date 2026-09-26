/**
 * A date with no time in it, written the way a person reads it.
 *
 * A due date, an issue date, a statement period: these are days on a calendar,
 * not moments. Postgres hands them over as midnight UTC, and formatting
 * midnight UTC anywhere west of Greenwich prints the day before — so an
 * invoice due on 1 October says 30 September, to the customer, on the
 * document they are being asked to pay.
 *
 * On our own servers nothing showed, because a container's clock is UTC. The
 * product is self-hosted: the box belongs to the business, and a business in
 * Denver that set its server to Denver time got every customer-facing date
 * shifted back by one day with nothing anywhere saying so.
 *
 * The browser has had this right since `formatDate` was written; this is the
 * same rule for everything rendered on the server — the public invoice, the
 * payment page, a shared project, a statement, a mail merge.
 *
 * A real timestamp that lands on exactly midnight UTC is read as a calendar
 * date and formatted in UTC. That is a one-in-86-million coincidence, and the
 * answer it gives is the one it already gave to every reader at or east of
 * UTC anyway.
 */
export function isCalendarDate(value: Date | string): boolean {
  if (typeof value === "string") return /^\d{4}-\d{2}-\d{2}$/.test(value);
  return (
    value.getUTCHours() === 0 &&
    value.getUTCMinutes() === 0 &&
    value.getUTCSeconds() === 0 &&
    value.getUTCMilliseconds() === 0
  );
}

/**
 * `—` for nothing and for a date that will not parse, because an em dash in a
 * table is a blank somebody can read and `Invalid Date` is a bug report.
 *
 * The month is spelled by default. This product sells into four countries
 * where `10/09` means two different days, and the caller who wants it short
 * can still say so.
 */
export function calendarDay(
  value: Date | string | null | undefined,
  locale = "en-US",
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium" },
): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, {
    ...options,
    // The caller's own zone wins: a timestamp shown "where the business is"
    // is a different question, and one this must not answer for it.
    timeZone: options.timeZone ?? (isCalendarDate(value) ? "UTC" : undefined),
  }).format(date);
}
