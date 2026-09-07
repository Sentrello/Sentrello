import { and, db, eq, lt, ne, schema } from "@sentrello/db";
import { policyFor } from "@sentrello/db/lockout";
import { record } from "@sentrello/db/security-events";

/**
 * Removing history older than the business asked to keep.
 *
 * An instance whose login page faces the internet collects bot attempts
 * indefinitely, and on a small on-premises box an audit table nobody prunes
 * is a disk that fills.
 *
 * The prune records itself as an `events.pruned` row, because history that
 * could vanish without a trace would not be an audit log. That row is exempt
 * from a later prune's own cutoff — it is the smallest row in the table and
 * the only evidence that a removal happened.
 *
 * "Records itself" is as strong as `record` is, which is deliberately not
 * very: it swallows its own insert failure and logs
 * (`packages/db/src/security-events.ts`), so a prune whose marker fails to
 * write still reports success and leaves no trace of what it removed. That is
 * the right trade — an audit write must never be what makes a job fail, and
 * every caller in this module relies on the same contract — but it is a
 * best-effort record, not a guaranteed one, and the difference matters to
 * anybody reading this to find out what happened to a missing row.
 */
export async function pruneEvents(organizationId: string): Promise<number> {
  const policy = await policyFor(organizationId);
  const days = policy.eventRetentionDays;
  // Zero (or less, if ever written directly) is off, matching lockState's
  // treatment of lockoutAfterAttempts: an instance can choose to keep
  // everything forever.
  if (days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const removed = await db
    .delete(schema.securityEvents)
    .where(
      and(
        eq(schema.securityEvents.organizationId, organizationId),
        lt(schema.securityEvents.at, cutoff),
        ne(schema.securityEvents.action, "events.pruned"),
      ),
    )
    .returning({ id: schema.securityEvents.id });
  if (removed.length === 0) return 0;

  await record({
    organizationId,
    actor: null,
    action: "events.pruned",
    detail: { removed: removed.length, olderThanDays: days },
  });
  return removed.length;
}

/**
 * Every organization on this instance, pruned in turn.
 *
 * What the nightly job actually calls. Pulled out of the job handler itself
 * so this loop — the one place that touches more than one organization — has
 * something exercising it directly, rather than only living inside a
 * `ctx.registerJob` handler that the test harness never runs
 * (`registerForTest`'s `registerJob` is a no-op; see
 * `packages/module-sdk/src/index.ts:245`).
 */
export async function pruneAllEvents(): Promise<number> {
  const orgs = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations);
  let pruned = 0;
  for (const org of orgs) {
    try {
      pruned += await pruneEvents(org.id);
    } catch (err) {
      // One business's prune failing must not cost every business ordered
      // after it in that select their nightly run — pg-boss marks the whole
      // job failed and waits for tomorrow, so an unisolated throw here is a
      // table that quietly never gets pruned again. Same reason
      // `runRecurringBills` isolates each schedule
      // (`packages/modules-free/accounting/src/recurring-bills.ts`).
      console.error(`[users] could not prune the audit log of ${org.id}`, err);
    }
  }
  return pruned;
}
