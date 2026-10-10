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
const store = new AsyncLocalStorage<{ userId: string; key?: ActorKey }>();

/**
 * The API key a person's work came through, when it did.
 *
 * A key acts as its maker, so without this everything a script did read as
 * something that person did by hand — "Ana changed the deal" at three in the
 * morning, from a meter. The id is the truth; the name is what a reader needs.
 */
export interface ActorKey {
  id: string;
  name: string;
}

/** Runs `fn` with everything it does attributed to this person. */
export function asActor<T>(
  userId: string,
  fn: () => Promise<T>,
  key?: ActorKey,
): Promise<T> {
  return store.run(key ? { userId, key } : { userId }, fn);
}

/** The key the current work came through, or none. */
export function currentKey(): ActorKey | null {
  return store.getStore()?.key ?? null;
}

/**
 * Who did it, as a reader should see it: "Ana, with key 'meter'".
 *
 * Only when the person named is the key's maker. Something recorded about
 * somebody else during a key's request is not the key's doing.
 */
export function withKey(name: string, actorId: string | null): string {
  const key = currentKey();
  if (!key || actorId !== currentActor()) return name;
  return `${name}, with key \u2018${key.name}\u2019`;
}

/** Who the current work belongs to, or nobody. */
export function currentActor(): string | null {
  return store.getStore()?.userId ?? null;
}
