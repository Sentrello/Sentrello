/**
 * An object sent where text belongs, refused before the driver flattens it.
 *
 * The database does not catch this one. A `name` of `{}` is *accepted* — the
 * driver stringifies it — so the row is stored as the literal text
 * `[object Object]`, every list draws it, and nothing anywhere failed. The only
 * sign is a record in somebody's book that cannot be searched for or corrected
 * by name. An array is the same shape: `["a","b"]` is saved as `a,b`.
 *
 * Only objects and arrays, and only text columns. A number or a boolean where
 * text belongs reads back as "123" or "true", which is usually what somebody
 * meant; `{}` and `[]` never are. A `jsonb` column takes an object by design,
 * so asking the table which is which is the whole of the check — no list of
 * field names to keep, and a column added next month is covered.
 *
 * Written for the CRM's generic CRUD, which has refused this since September.
 * It is here because the hand-written routes did not: on 6 October a probe sent
 * `{"name": {}}` to the groups route and a group called `[object Object]`
 * appeared on four screens.
 */
import { getTableColumns } from "drizzle-orm";
import type { Table } from "drizzle-orm";

export type TextCheck = { ok: true } | { ok: false; field: string };

export function checkedText(
  table: Table,
  value: Record<string, unknown>,
): TextCheck {
  const columns = getTableColumns(table) as Record<
    string,
    { columnType?: string } | undefined
  >;
  for (const [field, raw] of Object.entries(value)) {
    if (raw === null || typeof raw !== "object") continue;
    if (raw instanceof Date) continue;
    const kind = columns[field]?.columnType;
    if (kind === "PgText" || kind === "PgVarchar" || kind === "PgChar") {
      return { ok: false, field };
    }
  }
  return { ok: true };
}

/** What the caller is told, naming the field so it can be corrected. */
export function notText(field: string): string {
  return `${field} has to be text, and what arrived was an object. Sent as it is, it would be stored as the words "[object Object]".`;
}
