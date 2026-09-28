import { eq, schema } from "@sentrello/db";
import { policyFor } from "@sentrello/db/lockout";
import { record } from "@sentrello/db/security-events";
import type { ModuleContext, RetentionPolicy } from "@sentrello/module-sdk";

/**
 * How long the audit log is kept.
 *
 * An instance whose sign-in page faces the internet collects bot attempts
 * indefinitely, and on a small on-premises box an audit table nobody prunes is
 * a disk that fills.
 *
 * The window is the business's own — `eventRetentionDays` on its security
 * policy, a year by default. Zero is off, matching `lockState`'s treatment of
 * `lockoutAfterAttempts`: an instance under a legal hold is entitled to keep
 * everything for ever.
 *
 * **Nothing is emptied, only removed.** The detail *is* the record here: an
 * audit row saying somebody's role was changed, with the before and after
 * taken out of it, is not a lighter audit row — it is a row that cannot answer
 * the question it exists for. So this log has one horizon rather than two.
 *
 * **In batches now, which is the point of the change.** This used to be one
 * `delete` over everything past the cutoff. On a two-year-old instance that is
 * a row lock on hundreds of thousands of rows held for the length of the
 * transaction — every sign-in on the box waiting behind the job that was
 * supposed to be housekeeping. The platform's sweep does five hundred at a
 * time against a wall-clock budget, so a backlog comes down over a night or
 * two and nobody notices either way.
 *
 * The prune records itself as an `events.pruned` row, because history that
 * could vanish without a trace would not be an audit log. That row is exempt
 * from a later prune's cutoff — it is the smallest row in the table and the
 * only evidence that a removal happened.
 *
 * "Records itself" is as strong as `record` is, which is deliberately not very:
 * it swallows its own insert failure and logs
 * (`packages/db/src/security-events.ts`), so a prune whose marker fails to
 * write still reports success and leaves no trace of what it removed. That is
 * the right trade — an audit write must never be what makes a job fail — but
 * it is a best-effort record, not a guaranteed one, and the difference matters
 * to anybody reading this to find out what happened to a missing row.
 */
export const EVENT_RETENTION: RetentionPolicy<typeof schema.securityEvents> = {
  id: "users-security-events",
  label: "Sign-in and account history",
  table: schema.securityEvents,
  // Never null: an audit row is written about something that has already
  // happened, so every row is eligible once it is old enough.
  clock: schema.securityEvents.at,
  // The one row this log cannot lose. Everything else past the window goes;
  // the marker saying a removal happened stays, because an audit log whose
  // history can vanish without a trace is not an audit log.
  keep: eq(schema.securityEvents.action, "events.pruned"),
  window: async (organizationId) => ({
    removeAfterDays: (await policyFor(organizationId)).eventRetentionDays,
  }),
  /*
   * The marker, written with the batch it describes rather than after the
   * whole sweep, because a batch is the largest amount of work that can be
   * lost to a power cut. One per five hundred rows removed — which on a
   * steady instance is one a night, exactly as it was when this was a single
   * unbatched delete, and a handful extra on the one night an instance
   * catches up on a backlog.
   */
  cascade: async (ids, organizationId, phase) => {
    if (phase !== "remove") return 0;
    await record({
      organizationId,
      actor: null,
      action: "events.pruned",
      detail: { removed: ids.length },
    });
    return 0;
  },
};

export function registerEventRetention(ctx: ModuleContext) {
  ctx.registerRetention?.(EVENT_RETENTION);
}
