import { schema } from "@sentrello/db";
import { RECORD_EVENT_PAYLOADS } from "@sentrello/db/record-events";
import type { ModuleContext, RetentionPolicy } from "@sentrello/module-sdk";

/**
 * How long the change feed is kept.
 *
 * `record_events` is a row for every change to every business record, each
 * carrying a copy of the record before and after. It is written by the
 * platform on every save, by every module, and until now nothing had ever
 * removed one. A business editing a few hundred records a day writes tens of
 * thousands of rows a month, for ever, on a server with nobody watching it.
 *
 * Here rather than in the platform because the erasure that empties the same
 * two columns is here — the sweep and the erasure have to agree about what a
 * payload is, and the shortest way to keep two things agreeing is to keep them
 * in one place, reading one list.
 *
 * **Two horizons, because there are two questions.** "What did this change
 * from" is asked within days or weeks and wants the copies. "When did this
 * deal move to won" is asked a year later by somebody reconstructing a
 * quarter, and wants only the fact: which record, what changed, when, and who
 * did it — about two hundred bytes, and true for ever.
 *
 * Ninety days for the copies. It covers a full quarter, which is the longest
 * period anybody looks back over a change and still wants to see the old
 * values; past that the "before" is a copy of a record that has since changed
 * several times over and is misleading as often as it is useful.
 *
 * Four hundred days for the row. A year plus a margin, so a question asked on
 * the anniversary of something — an annual review, a year-over-year comparison,
 * an audit covering last calendar year — still finds it, rather than the row
 * having gone the week before it was wanted.
 *
 * **On `at`, not on `handled_at`.** `handled_at` is the dispatcher's mark and
 * stays null for ever on an instance with no automations, so a sweep that
 * waited for it would sweep nothing at all on the instances that need it most.
 * The risk that buys is an undispatched event being removed at four hundred
 * days: the dispatcher polls every minute, so an event it has not looked at in
 * over a year is not pending, it is abandoned.
 */
export const RECORD_EVENT_RETENTION = {
  emptyAfterDays: 90,
  removeAfterDays: 400,
};

export const RECORD_EVENT_POLICY: RetentionPolicy<typeof schema.recordEvents> =
  {
    id: "crm-record-events",
    label: "Change feed",
    table: schema.recordEvents,
    clock: schema.recordEvents.at,
    payloads: [...RECORD_EVENT_PAYLOADS],
    window: () => RECORD_EVENT_RETENTION,
  };

export function registerCrmRetention(ctx: ModuleContext) {
  ctx.registerRetention?.(RECORD_EVENT_POLICY);
}
