import { type DbTx, db, sql } from "@sentrello/db";
import {
  type RegisteredContactLink,
  contactLinks,
} from "@sentrello/module-sdk";

/**
 * The modules' tables that name a contact, asked by a merge and a delete.
 *
 * What each module registered with `registerContactLink`; see `ContactLink`
 * for what `block`, `unlink` and `remove` mean. Raw SQL rather than the query
 * builder because the tables are other modules' and arrive as values.
 */

type Conn = DbTx | typeof db;

const where = (link: RegisteredContactLink, orgId: string, id: string) =>
  sql`${link.organization} = ${orgId} and ${link.contact} = ${id}`;

async function count(
  conn: Conn,
  link: RegisteredContactLink,
  orgId: string,
  id: string,
): Promise<number> {
  const [row] = await conn.execute<{ n: number }>(
    sql`select count(*)::int as n from ${link.table} where ${where(link, orgId, id)}`,
  );
  return Number(row?.n ?? 0);
}

const noun = (link: RegisteredContactLink, n: number) =>
  `${n} ${n === 1 ? link.one : (link.many ?? `${link.one}s`)}`;

/** "2 shop orders", one per kind of record that stops this contact going. */
export async function blockingLinks(
  orgId: string,
  id: string,
): Promise<string[]> {
  const parts: string[] = [];
  for (const link of contactLinks()) {
    if (link.onDelete !== "block") continue;
    const n = await count(db, link, orgId, id);
    if (n) parts.push(noun(link, n));
  }
  return parts;
}

/** What both contacts hold one of where only one is allowed. */
export async function mergeConflicts(
  orgId: string,
  keptId: string,
  mergedId: string,
): Promise<string[]> {
  const both: string[] = [];
  for (const link of contactLinks()) {
    if (!link.onePerContact) continue;
    if (
      (await count(db, link, orgId, keptId)) &&
      (await count(db, link, orgId, mergedId))
    ) {
      both.push(link.many ?? `${link.one}s`);
    }
  }
  return both;
}

/** Every module row naming `from` now names `to`; counted by kind. */
export async function moveLinks(
  tx: Conn,
  orgId: string,
  from: string,
  to: string,
): Promise<Record<string, number>> {
  const moved: Record<string, number> = {};
  for (const link of contactLinks()) {
    const rows = await tx.execute(
      sql`update ${link.table} set ${sql.identifier(link.contact.name)} = ${to} where ${where(link, orgId, from)} returning 1`,
    );
    if (rows.length) moved[`${link.moduleId}.${link.id}`] = rows.length;
  }
  return moved;
}

/**
 * After a delete: the links cleared and the rows only about them gone.
 *
 * Nothing `block` is left by then — the delete was refused while any were.
 */
export async function releaseLinks(
  tx: Conn,
  orgId: string,
  ids: string[],
): Promise<void> {
  for (const id of ids) {
    for (const link of contactLinks()) {
      if (link.onDelete === "unlink") {
        await tx.execute(
          sql`update ${link.table} set ${sql.identifier(link.contact.name)} = null where ${where(link, orgId, id)}`,
        );
      } else if (link.onDelete === "remove") {
        await tx.execute(
          sql`delete from ${link.table} where ${where(link, orgId, id)}`,
        );
      }
    }
  }
}
