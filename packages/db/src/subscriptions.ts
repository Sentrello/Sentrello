/**
 * What a subscription is, in the few rules everything has to agree on.
 *
 * These live here rather than in the invoicing module because two things now
 * decide them: the module that raises the invoices, and the shop, where a
 * customer signs in to change or cancel their own. Two implementations of "what
 * does cancelling mean" would be two answers about somebody's money, and they
 * would not disagree today — they would disagree the week one of them was
 * changed.
 *
 * Pure functions and lists, deliberately. Nothing here touches the database, so
 * there is no second path to a row either.
 */

export const BILLING_INTERVALS = [
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
] as const;

export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export const isBillingInterval = (value: unknown): value is BillingInterval =>
  typeof value === "string" &&
  (BILLING_INTERVALS as readonly string[]).includes(value);

/** trialing → active → paused → cancelled. Nothing skips to the front. */
export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "paused",
  "cancelled",
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/**
 * When the next invoice falls, given a start and a trial.
 *
 * A trial bills on the day it ends, not a period later: somebody who takes a
 * fourteen-day trial on the 1st expects to pay on the 15th, and billing them on
 * the 1st of next month would be two free weeks nobody offered.
 */
export function firstRun(startsOn: Date, trialEndsAt: Date | null): Date {
  return trialEndsAt && trialEndsAt > startsOn ? trialEndsAt : startsOn;
}

/**
 * What a cancellation means, in dates.
 *
 * "At the end of the period" is the default because the customer has paid for
 * it. Immediately is a business deciding to stop billing now — it still does
 * not refund anything, and saying so is the honest thing for a screen to do.
 */
export function cancellation(
  now: Date,
  nextRunAt: Date,
  immediately: boolean,
): {
  status: SubscriptionStatus;
  cancelAt: Date;
  cancelledAt: Date;
  active: boolean;
} {
  return immediately
    ? { status: "cancelled", cancelAt: now, cancelledAt: now, active: false }
    : { status: "active", cancelAt: nextRunAt, cancelledAt: now, active: true };
}

/** Every interval a schedule can run on, including the daily one only recurring invoices use. */
export type Interval = "daily" | "weekly" | "monthly" | "quarterly" | "yearly";

/**
 * When a schedule next comes round.
 *
 * `count` is "every N of those" — every two weeks is one schedule, not two, and
 * a business billing fortnightly should not have to keep two profiles in step.
 *
 * Month arithmetic clamps rather than overflowing: a monthly invoice raised on
 * the 31st falls on the 28th in February and does not silently jump into March,
 * which would move the customer's billing day for ever.
 *
 * Here rather than in the jobs package because the shop needs it too — a
 * customer restarting their own paused subscription has to arrive at exactly
 * the date the scheduler would have. A bundle cannot import the jobs package at
 * all: only a small set is linked into the container, and an import that
 * resolves in development and fails inside it takes the whole module down.
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
  // Overflowed into the next month (Jan 31 + 1mo lands on Mar 3): step back to
  // the last day of the month that was meant.
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d;
}
