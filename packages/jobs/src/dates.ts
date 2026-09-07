export type Interval = "daily" | "weekly" | "monthly" | "quarterly" | "yearly";

/**
 * When a schedule next comes round.
 *
 * `count` is "every N of those" — every two weeks is one schedule, not two,
 * and a business billing fortnightly should not have to keep two profiles in
 * step. Month arithmetic clamps rather than overflowing: a monthly invoice
 * raised on the 31st falls on the 28th in February and does not silently jump
 * into March, which would move the customer's billing day for ever.
 */
export function nextRun(from: Date, interval: Interval, count = 1): Date {
  const every = Math.max(1, Math.trunc(count));
  const d = new Date(from);
  const day = d.getUTCDate();

  switch (interval) {
    case "daily":
      d.setUTCDate(d.getUTCDate() + every);
      return d;
    case "weekly":
      d.setUTCDate(d.getUTCDate() + 7 * every);
      return d;
    case "quarterly":
      d.setUTCMonth(d.getUTCMonth() + 3 * every);
      break;
    case "yearly":
      d.setUTCFullYear(d.getUTCFullYear() + every);
      break;
    default:
      d.setUTCMonth(d.getUTCMonth() + every);
  }
  // Overflowed into the next month (Jan 31 + 1mo lands on Mar 3): step back
  // to the last day of the month that was meant.
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d;
}

export function isOverdue(
  dueDate: Date,
  balanceDueCents: number,
  now = new Date(),
): boolean {
  return balanceDueCents > 0 && dueDate.getTime() < now.getTime();
}
