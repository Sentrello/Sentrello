import { type SQL, getTableColumns } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { type DbTx, db } from "./client";
import { and, eq, inArray } from "./orm";
import { RequestFieldError } from "./request-values";

/**
 * Whether an id a request names is a record of the caller's business.
 *
 * A write that takes `categoryId`, `taxDefinitionId` or `contactId` out of a
 * body and stores it has asked a tenancy question whether it meant to or not.
 * Leave it unasked and a product can be filed under another business's
 * category, a plan priced with another business's tax, and every screen that
 * joins the two reads the other business's words onto this one's record.
 *
 * **Another business's record is refused exactly as a record nobody has** —
 * the same status and the same sentence — so the refusal cannot be used to
 * learn that the id exists somewhere else on the instance.
 */
type Owned = PgTable & { id: PgColumn; organizationId: PgColumn };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The one sentence, for a foreign id and for an invented one alike. */
export function notOurs(field: string): RequestFieldError {
  return new RequestFieldError(
    field,
    `${field} does not name anything in this business.`,
  );
}

function idsOf(table: Owned, field: string, values: unknown[]): string[] {
  const uuid = getTableColumns(table).id?.columnType === "PgUUID";
  return values.map((v) => {
    // Not an id at all reads the same as an id nobody owns: either way the
    // caller named nothing of theirs, and a uuid column would otherwise throw.
    if (typeof v !== "string" || v === "" || (uuid && !UUID.test(v)))
      throw notOurs(field);
    return v;
  });
}

/**
 * The id, if the caller's business owns it; null for absent, null or "".
 * Anything else is refused with {@link notOurs}.
 */
export async function ownedIdOrNothing(
  table: Owned,
  organizationId: string,
  value: unknown,
  field: string,
  tx: DbTx | typeof db = db,
): Promise<string | null> {
  if (value === undefined || value === null || value === "") return null;
  const [id] = idsOf(table, field, [value]);
  const [row] = await tx
    .select({ id: table.id })
    .from(table as PgTable)
    .where(
      and(eq(table.id, id), eq(table.organizationId, organizationId)) as SQL,
    )
    .limit(1);
  if (!row) throw notOurs(field);
  return id as string;
}

/** Every id in a list, each owned by the caller's business, or a refusal. */
export async function ownedIds(
  table: Owned,
  organizationId: string,
  values: unknown,
  field: string,
  tx: DbTx | typeof db = db,
): Promise<string[]> {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) throw notOurs(field);
  const ids = [...new Set(idsOf(table, field, values))];
  if (ids.length === 0) return [];
  const rows = await tx
    .select({ id: table.id })
    .from(table as PgTable)
    .where(
      and(
        inArray(table.id, ids),
        eq(table.organizationId, organizationId),
      ) as SQL,
    );
  if (rows.length !== ids.length) throw notOurs(field);
  return ids;
}
