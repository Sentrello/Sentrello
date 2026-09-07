import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who is doing this, for the code too far down to be told.
 *
 * The ledger is already an audit trail: nothing is edited, nothing is deleted,
 * and a correction is a reversal beside the thing it corrects. What it could
 * not say was *who* — `postJournalEntry` is several calls below every route,
 * and the entries that matter most for this question are exactly the ones
 * nobody types by hand, where there is no form to add a field to.
 *
 * Threading an actor through every posting call site would mean touching
 * thirty functions that have no other reason to know about sessions, and
 * would be quietly wrong at each one somebody forgot. This is set once, by the
 * middleware that already resolves the session, and read once, where the entry
 * is written.
 *
 * **A missing actor is normal and always will be.** A nightly job posts
 * depreciation and a webhook posts a card payment; neither is a person, and
 * both are correctly recorded as nobody.
 */
const store = new AsyncLocalStorage<{ userId: string }>();

/** Runs `fn` with everything it does attributed to this person. */
export function asActor<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return store.run({ userId }, fn);
}

/** Who the current work belongs to, or nobody. */
export function currentActor(): string | null {
  return store.getStore()?.userId ?? null;
}
