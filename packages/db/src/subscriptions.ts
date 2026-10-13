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

import { dayIn, dayOf } from "./day";

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

/**
 * trialing → active → paused → cancelled. Nothing skips to the front.
 *
 * The two dunning states sit between active and cancelled: `past_due` is a
 * renewal invoice gone unpaid while collection is still being attempted, and
 * `unpaid` is collection given up without the subscription being cancelled —
 * service withheld until somebody settles. They are written by the dunning
 * job in the subscriptions module; the canonical list carries them so no
 * screen or guard treats a delinquent subscription as an unknown state.
 */
export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "unpaid",
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
 * Is this still a trial, on the business's day?
 *
 * Four places asked it — the billing sweep, the resume action, and twice in the
 * subscriber's own portal — and all four asked `trialEndsAt > now`. A trial ends
 * on a *day*, stored as midnight UTC, so that answer flipped at one second past
 * midnight in Greenwich: at eight the evening before in New York, where the
 * nightly sweep would then raise the first invoice a day early, and the portal
 * would tell the customer their trial was over while it still had a day in it.
 *
 * It bills *on* the day the trial ends — the rule `firstRun` above sets — so the
 * trial covers the days before it and not that one.
 */
export function inTrial(
  trialEndsAt: Date | null,
  now: Date,
  zone: string | null,
): boolean {
  if (!trialEndsAt) return false;
  return dayOf(trialEndsAt).getTime() > dayIn(now, zone).getTime();
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
  status?: SubscriptionStatus;
  cancelAt: Date;
  cancelledAt: Date;
  active?: boolean;
} {
  /*
   * At the end of the period, only the dates are written. A subscription on
   * trial is still on trial until then, one in arrears is still in arrears,
   * and a paused one stays paused: writing "active" took a trial out of the
   * trial count, a debt out of the dunning queue, and restarted billing on a
   * pause.
   */
  return immediately
    ? { status: "cancelled", cancelAt: now, cancelledAt: now, active: false }
    : { cancelAt: nextRunAt, cancelledAt: now };
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
 * **Clamped from the anchor, not from the last run.** `anchor` is the date the
 * schedule is measured from — its first run, or whatever day it was set to
 * fall on — and only its day of the month is read. Stepping from the previous
 * run alone cannot tell a schedule on the 28th from one on the 31st that was
 * clamped in February, so 31 January went to 28 February and then to the 28th
 * of every month after it; and a yearly run on 29 February stayed on the 28th
 * in every leap year that followed. With the anchor, the month is the last
 * run's plus the interval and the day is the anchor's, cut to the month's
 * length: 31 January, 28 February, 31 March, 30 April. That is start plus n
 * intervals, without having to count n.
 *
 * Known limit: left out, the anchor is `from` itself — the old arithmetic,
 * kept for callers that have nowhere yet to read a first run from. Daily and
 * weekly schedules never clamp, so the anchor does not change them.
 *
 * Here rather than in the jobs package because the shop needs it too — a
 * customer restarting their own paused subscription has to arrive at exactly
 * the date the scheduler would have. A bundle cannot import the jobs package at
 * all: only a small set is linked into the container, and an import that
 * resolves in development and fails inside it takes the whole module down.
 */
export function nextRun(
  from: Date,
  interval: Interval,
  count = 1,
  anchor?: Date | null,
): Date {
  const every = Math.max(1, Math.trunc(count));
  const d = new Date(from);

  if (interval === "daily" || interval === "weekly") {
    d.setUTCDate(d.getUTCDate() + (interval === "weekly" ? 7 : 1) * every);
    return d;
  }

  const months =
    interval === "yearly"
      ? 12 * every
      : interval === "quarterly"
        ? 3 * every
        : every;
  const day = (anchor ?? from).getUTCDate();
  // Day 1 first, so the month cannot overflow while it moves; then the
  // anchor's day, or the month's last when it is shorter. Day 0 of the month
  // after is the last day of this one.
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}
