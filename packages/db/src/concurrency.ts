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
 * To the millisecond, from the column rather than from a hash of the row: the
 * column is stamped by every write that touches it, which is a rule a test in
 * this package holds every path to.
 *
 * Here rather than inside invoicing, where it was written, because the CRM needs
 * the same answer and two copies of a rule about losing somebody's work is two
 * places for it to drift.
 */
export function movedSince(
  row: { updatedAt: Date },
  body: Record<string, unknown>,
): boolean {
  const claimed = body.expectedUpdatedAt;
  if (typeof claimed !== "string" || claimed === "") return false;
  const asked = new Date(claimed).getTime();
  if (Number.isNaN(asked)) return false;
  return asked !== row.updatedAt.getTime();
}

/**
 * What somebody is told when it has.
 *
 * Says what happened, says nothing was saved, and says what to do — the three
 * things a 409 usually leaves out.
 */
export const MOVED =
  "Somebody else changed this while you had it open, so nothing here has been saved. Open it again to see their version.";
