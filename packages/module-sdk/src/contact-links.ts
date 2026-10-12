import type { RetentionColumn, SqlFragment } from "./retention";

/**
 * A table of this module's that names a CRM contact.
 *
 * Nothing in the platform has a foreign key to `contacts`, so a merge and a
 * delete only ever moved the tables Core had heard of. Merging two contacts
 * left every shop order, booking, till ticket and card on file pointing at the
 * one that was folded in and deleted; deleting a contact with a shop order was
 * allowed, because the check only counted invoices. A module says which of its
 * tables name a contact, and Core's merge and delete ask whatever this
 * instance loaded.
 *
 * `onDelete` is what happens when the contact itself is deleted:
 *
 *   - `block`  — the row stands in its own right (an order, a ticket, a
 *                card). The delete is refused while any exist, and the
 *                refusal names them, as it already does for invoices.
 *   - `unlink` — the row is the module's own record that happened to be
 *                matched to a contact (a subscriber, a document). The link is
 *                cleared and the row stays.
 *   - `remove` — the row is only about the contact (an email filed against
 *                them) and has no meaning without it.
 *
 * A merge always moves the rows to the kept contact. Where a table allows one
 * row per contact (`onePerContact`), a merge of two contacts that both have one
 * is refused instead, naming `one` in the reason, because choosing which of two
 * cards on file to throw away is not a merge's decision to make.
 */
export interface ContactLink {
  /** Unique within the module. */
  id: string;
  /** A drizzle table; structural, like retention's, to keep one dependency. */
  table: SqlFragment;
  /** The column holding the contact's id. */
  contact: RetentionColumn;
  /** The table's `organization_id`. */
  organization: RetentionColumn;
  /** What one row is called, for a refusal: "shop order". */
  one: string;
  /** And several: "shop orders". Defaults to `one` plus "s". */
  many?: string;
  onDelete: "block" | "unlink" | "remove";
  onePerContact?: boolean;
  /**
   * Columns that, with the contact, make a row unique. A merge drops the
   * folded-in record's copy of a row the kept one already holds rather than
   * moving it into the unique index: one email filed against both of them is
   * one email filed against the kept one.
   */
  dedupeOn?: RetentionColumn[];
}

export type RegisteredContactLink = ContactLink & { moduleId: string };

const links: RegisteredContactLink[] = [];

/** Replaced rather than appended, so a module loaded twice counts once. */
export function addContactLink(link: RegisteredContactLink): void {
  const at = links.findIndex(
    (l) => l.moduleId === link.moduleId && l.id === link.id,
  );
  if (at >= 0) links[at] = link;
  else links.push(link);
}

export function contactLinks(): RegisteredContactLink[] {
  return [...links];
}

/** For tests, and for a host that loads its modules more than once. */
export function clearContactLinks(): void {
  links.length = 0;
}
