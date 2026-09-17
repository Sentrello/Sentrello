/**
 * One column of "what has gone on with these people", out of two sources.
 *
 * Core's `/api/crm/history` reads notes, activities, tasks, deals and consent.
 * Pro's `/api/contacts/:id/timeline` reads activities, deals, invoices,
 * payments and — since mailbox sync — emails and meetings. The panel shows one
 * list, so the two have to be merged, and the merge is where this went wrong.
 *
 * **It was a whitelist of two kinds.** Anything from Pro that was not an
 * invoice or a payment was silently dropped, which was harmless on the day it
 * was written and became a hole the moment Pro's timeline learned anything
 * new: mailbox sync's emails and meetings synced correctly, stored correctly,
 * and could not be seen on the record they were synced for. Deal lines went
 * the same way on the same afternoon.
 *
 * So the rule is inverted. **Everything from Pro is shown unless there is a
 * reason to drop it**, there are exactly two such reasons and both are named
 * below, and a kind nobody has heard of renders as an ordinary line rather
 * than disappearing — loudly, in development, so the next one is noticed while
 * somebody can still act on it.
 */

export interface HistoryEntry {
  at: string;
  kind: string;
  title: string;
  detail?: string | null;
  activityId?: string;
  link?: { moduleId: string; recordId: string; title: string } | null;
}

/** What the Pro timeline hands over, whatever kinds it has learned. */
export interface TimelineEntry {
  kind: string;
  at: string;
  /** The row this line is about, which is how a duplicate is recognised. */
  id: string;
  /** Which moment of it, where one record produces more than one line. */
  event?: string;
  summary?: string | null;
  detail?: string | null;
  amountCents?: number;
}

/**
 * Which record a line is about, where it says.
 *
 * Both sources identify the underlying row: Core carries `activityId` on
 * something somebody typed and `link.recordId` on a deal, and every entry from
 * the other side carries `id`. That is what makes the de-duplication below
 * structural rather than a list of kind names — a second module contributing a
 * kind Core also emits is resolved by the same rule, without this file being
 * edited to know about it.
 */
const recordOf = (entry: HistoryEntry): string | undefined =>
  entry.activityId ?? entry.link?.recordId ?? undefined;

/** Shown when a kind arrives that this build has never heard of. */
function plainly(entry: TimelineEntry): string {
  const words = entry.kind.replace(/[-_]/g, " ");
  const name = words.charAt(0).toUpperCase() + words.slice(1);
  return entry.summary ? `${name}: ${entry.summary}` : name;
}

export function describeTimelineEntry(
  entry: TimelineEntry,
  money: (cents: number) => string,
): HistoryEntry {
  const title = (() => {
    switch (entry.kind) {
      case "invoice":
        return `Invoice ${entry.summary ?? ""}`.trim();
      case "payment":
        return `Paid${entry.summary ? ` by ${entry.summary}` : ""}`;
      case "email":
        return entry.summary ? `Email: ${entry.summary}` : "Email";
      case "meeting":
        return entry.summary ? `Meeting: ${entry.summary}` : "Meeting";
      case "deal":
        // One record, two moments. Saying which is the whole value of the
        // richer line over the coarse one it replaces.
        return `${entry.event === "closed" ? "Deal decided" : "Deal opened"}${
          entry.summary ? `: ${entry.summary}` : ""
        }`;
      default:
        /*
         * Not a silent default. A kind we do not recognise still gets a line —
         * a business paying for a feature must be able to see what it produced
         * — but a build running in development says so, because the last time
         * this went unnoticed a whole feature was invisible for a day.
         */
        if (import.meta.env?.DEV) {
          console.error(
            `[timeline] no wording for a "${entry.kind}" entry; showing it plainly. Add one in lib/timeline.ts.`,
          );
        }
        return plainly(entry);
    }
  })();

  return {
    at: entry.at,
    kind: entry.kind,
    title,
    detail:
      entry.detail ??
      (entry.amountCents === undefined ? null : money(entry.amountCents)),
    // An invoice, a payment or an email is a record of what happened rather
    // than something somebody typed here, so none of them is editable.
    activityId: undefined,
  };
}

/**
 * Both sources as one list, newest first.
 *
 * `timeline` being undefined is the Free case — nothing is dropped from the
 * Core history, because there is nothing better to replace it with.
 */
export function mergeTimeline(
  history: HistoryEntry[] | undefined,
  timeline: TimelineEntry[] | undefined,
  money: (cents: number) => string,
): HistoryEntry[] {
  const core = history ?? [];
  const extra = timeline ?? [];

  /**
   * One line per record when both sources describe the same one.
   *
   * Core's history reads notes, activities, tasks and deals; the richer
   * timeline reads activities, deals, invoices, payments, emails and meetings.
   * The overlap is real and drawing both would show a deal twice — which is
   * what naively widening the old whitelist would have done.
   *
   * Which side wins is decided by what the line can *do*, not by what it is
   * called. **Core's wins only when it is editable** — an `activityId` is the
   * handle that lets somebody correct or remove what they typed, and no other
   * source can supply it. For everything else the richer source wins, because
   * it carries the detail: a deal's opened-and-decided pair with its stage and
   * value, where Core has one coarse line.
   */
  const editable = new Set(
    core.filter((entry) => entry.activityId).map((entry) => recordOf(entry)),
  );
  const fromTimeline = extra.filter((entry) => !editable.has(entry.id));
  const superseded = new Set(fromTimeline.map((entry) => entry.id));

  return [
    ...core.filter((entry) => {
      const record = recordOf(entry);
      return !record || !superseded.has(record);
    }),
    ...fromTimeline.map((entry) => describeTimelineEntry(entry, money)),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}
