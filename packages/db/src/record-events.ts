import { currentActor } from "./actor";
import { db } from "./client";
import { recordEvents } from "./schema";

/**
 * Saying that a business record changed, so anything watching can react.
 *
 * One function, called beside the write it describes. Deliberately not a
 * database trigger: a trigger is invisible in review, invisible to the ORM, and
 * a rule buried in one is the thing nobody finds for a year.
 *
 * **Never throws.** A follow-up email that failed to be *scheduled* must not
 * turn a deal that was successfully saved into an error on somebody's screen.
 * The record is the important half; the event is how other things find out
 * about it, and a business whose events are not being written has a broken
 * automation rather than a broken CRM.
 */

export interface RecordChange {
  organizationId: string;
  /** What kind of thing changed: "deal", "contact", "invoice". */
  entity: string;
  entityId: string;
  action: "created" | "updated" | "deleted";
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  /**
   * The workflow run this change came from, when it came from one.
   *
   * Carried so a run cannot react to its own work. "On update, update" is the
   * first automation anybody builds by accident, and the second thing they
   * build is a support ticket.
   */
  causedByRunId?: string | null;
}

/**
 * Which fields actually differ.
 *
 * A condition worth writing is nearly always about the change rather than the
 * state — "when the stage becomes won", not "when the stage is won", which is
 * true every time anything else on the deal is edited afterwards. Without this
 * every trigger on a busy record fires on every save.
 *
 * Compared by their JSON, so a date and a nested object behave like everything
 * else rather than being unequal to themselves.
 */
export function changedFields(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): string[] {
  if (!before || !after) return [];
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const name of names) {
    if (JSON.stringify(before[name]) !== JSON.stringify(after[name])) {
      changed.push(name);
    }
  }
  return changed.sort();
}

let warned = false;

/** Anything listening in this process, told as soon as the row is written. */
type Listener = (event: typeof recordEvents.$inferSelect) => void;
const listeners = new Set<Listener>();

/**
 * Be told the moment something changes, without waiting for the sweep.
 *
 * The durable path is the table and the job that reads it; this only makes the
 * common case feel immediate. Nothing may depend on it: a listener that is not
 * running, or a process that dies between the write and the call, must cost a
 * minute rather than the automation.
 */
export function onRecordChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function recordChanged(change: RecordChange): Promise<void> {
  try {
    const [written] = await db
      .insert(recordEvents)
      .values({
        organizationId: change.organizationId,
        entity: change.entity,
        entityId: change.entityId,
        action: change.action,
        changed: changedFields(change.before, change.after),
        before: change.before ?? null,
        after: change.after ?? null,
        actorId: currentActor(),
        causedByRunId: change.causedByRunId ?? null,
      })
      .returning();

    if (!written) return;
    for (const listener of listeners) {
      try {
        listener(written);
      } catch {
        // A listener that throws is its own problem. The row is written and the
        // sweep will find it, which is the guarantee that actually matters.
      }
    }
  } catch (error) {
    /*
     * Swallowed on purpose — the alternative is a deal that saved correctly
     * reporting a failure to the person who saved it, because a feed nothing in
     * Free even reads could not be written.
     *
     * Said once, though, and that is not a detail. An instance whose feed is
     * not being written has automations that never fire and nothing anywhere
     * saying why: it looks exactly like a rule that does not match. It happened
     * within an hour of this being built — a database that had not had the
     * migration run, a workflow published and correct, a deal won, and complete
     * silence from every part of the system.
     *
     * Once rather than per change, because the failure is the same failure
     * every time and a log nobody can read is a log nobody reads.
     */
    if (!warned) {
      warned = true;
      console.error(
        "[records] the change feed cannot be written, so automations will not fire:",
        (error as Error).message,
      );
    }
  }
}
