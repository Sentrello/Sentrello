import { and, db, eq, inArray, schema } from "@sentrello/db";
import type { DbTx } from "@sentrello/db";

/**
 * What goes when a contact, a company or a deal goes.
 *
 * No business table has a foreign key to any other, so nothing cascades by
 * itself and a deleted record leaves everything that was *about* it standing.
 * Most of that is invisible litter. One row of it is not: a task carries a due
 * date and an organization, which is exactly the shape every sweep in the
 * platform selects across all organizations — so a task about a deleted
 * customer is a task somebody is still reminded about, for a person the CRM
 * can no longer show them.
 *
 * **The rule, decided here rather than per route.** A note, an activity, a
 * task and a tag link are *about* their subject and have no meaning without
 * it: they go with it. A record that stands in its own right — a contact, a
 * deal, an invoice — never goes silently; the delete is refused instead, which
 * is what `blocksDelete` is for.
 *
 * One function because three callers need the identical sweep and would
 * otherwise each forget a different table: the CRUD delete route, the privacy
 * erasure, and whatever deletes a record next.
 */
export interface TrailRemoved {
  notes: number;
  activities: number;
  tasks: number;
  tagLinks: number;
}

export async function removeCrmTrail(
  organizationId: string,
  subject: "contact" | "company" | "deal",
  ids: string[],
  conn: DbTx | typeof db = db,
): Promise<TrailRemoved> {
  const removed: TrailRemoved = {
    notes: 0,
    activities: 0,
    tasks: 0,
    tagLinks: 0,
  };
  if (ids.length === 0) return removed;

  /*
   * Notes and activities file themselves differently — a note by
   * entity type and id, an activity by a column per kind — and a company has
   * neither. Written out per subject rather than derived, for the reason
   * `CRM_ENTITY` exists: a rule that guesses a column name from a word is a
   * rule that is silently wrong about the fourth one.
   */
  if (subject !== "company") {
    const notes = await conn
      .delete(schema.notes)
      .where(
        and(
          eq(schema.notes.organizationId, organizationId),
          eq(schema.notes.entityType, subject),
          inArray(schema.notes.entityId, ids),
        ),
      )
      .returning({ id: schema.notes.id });
    removed.notes = notes.length;

    const column =
      subject === "contact"
        ? schema.activities.contactId
        : schema.activities.dealId;
    const activities = await conn
      .delete(schema.activities)
      .where(
        and(
          eq(schema.activities.organizationId, organizationId),
          inArray(column, ids),
        ),
      )
      .returning({ id: schema.activities.id });
    removed.activities = activities.length;
  }

  const taskColumn =
    subject === "contact"
      ? schema.tasks.contactId
      : subject === "deal"
        ? schema.tasks.dealId
        : schema.tasks.companyId;
  const tasks = await conn
    .delete(schema.tasks)
    .where(
      and(
        eq(schema.tasks.organizationId, organizationId),
        inArray(taskColumn, ids),
      ),
    )
    .returning({ id: schema.tasks.id });
  removed.tasks = tasks.length;

  // The label, not the tag: a tag is a record of the business's own and
  // survives everything it was ever put on.
  const links = await conn
    .delete(schema.taggables)
    .where(
      and(
        eq(schema.taggables.entityType, subject),
        inArray(schema.taggables.entityId, ids),
      ),
    )
    .returning({ id: schema.taggables.id });
  removed.tagLinks = links.length;

  return removed;
}
