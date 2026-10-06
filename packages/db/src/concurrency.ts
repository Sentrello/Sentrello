/**
 * Two people with the same record open.
 *
 * Both sessions read it, both save, and the second write used to land on top of
 * the first in silence: both answered 200, neither was told, and what the first
 * person typed was gone with nothing anywhere saying so. It is rare, and it is
 * the one kind of loss somebody cannot recover by trying again — because they
 * never learn it happened.
 *
 * So a caller may say which version it is editing: `expectedUpdatedAt`, the
 * `updated_at` it read. A write against a row that has moved since is refused
 * rather than applied. HTTP's own `If-Unmodified-Since` is the same idea; this
 * lives in the body because every other field of these writes does.
 *
 * **Only when the caller claims a version.** A script that has never heard of
 * this keeps the behaviour it had, which is what stops it being a breaking
 * change for somebody's integration — and our own screens send it, so the place
 * two people actually collide is covered.
 *
 * To the millisecond, from the column rather than from a hash of the row. The
 * column is stamped by a database trigger on every write, which is what makes
 * that worth relying on — see `a-row-stamps-itself.test.ts`, which holds both
 * halves of it.
 *
 * Here rather than inside invoicing, where it was written, because the CRM needs
 * the same answer and two copies of a rule about losing somebody's work is two
 * places for it to drift.
 */

/**
 * What the caller's claim amounts to.
 *
 * Four answers rather than a boolean, and `unusable` is the one that earns it.
 * This returned "has it moved: yes or no", so a claim it could not read — a
 * number instead of a string, a millisecond timestamp, a date that is not one —
 * came back `false` and the write went through. The request looked protected,
 * answered 200, and had been checked against nothing. That is the same silence
 * this whole mechanism exists to remove, and it was inside the mechanism.
 */
export type VersionClaim = "none" | "current" | "moved" | "unusable";

export function versionClaim(
  row: { updatedAt: Date },
  body: Record<string, unknown>,
): VersionClaim {
  const claimed = body.expectedUpdatedAt;
  // Absent, and `null` with it: a serialiser writing "no version I hold" as
  // null is asking nothing, not asking badly.
  if (claimed === undefined || claimed === null) return "none";
  if (typeof claimed !== "string" || claimed.trim() === "") return "unusable";
  const asked = new Date(claimed).getTime();
  if (Number.isNaN(asked)) return "unusable";
  return asked === row.updatedAt.getTime() ? "current" : "moved";
}

/**
 * What somebody is told when the record has moved.
 *
 * Says what happened, says nothing was saved, and says what to do — the three
 * things a 409 usually leaves out.
 */
export const MOVED =
  "Somebody else changed this while you had it open, so nothing here has been saved. Open it again to see their version.";

/**
 * And what a caller is told when the claim could not be read.
 *
 * Written for whoever is holding the API rather than for whoever is at a screen,
 * because that is who sends this: our own forms send the string they were given.
 */
export const UNUSABLE_CLAIM =
  "expectedUpdatedAt has to be the updatedAt you read, as an ISO date string. Leave it out to save without checking.";
