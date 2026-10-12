import { type DbTx, db, sql } from "@sentrello/db";
import {
  type RegisteredContactLink,
  type ReleasedLinks,
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
type Of = "contact" | "company";

const of = (want: Of) =>
  contactLinks().filter((link) => (link.of ?? "contact") === want);

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
  record: Of = "contact",
): Promise<string[]> {
  const parts: string[] = [];
  for (const link of of(record)) {
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
  for (const link of of("contact")) {
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
  for (const link of of("contact")) {
    if (link.dedupeOn?.length) {
      const id = (name: string) => sql.identifier(name);
      const same = sql.join(
        link.dedupeOn.map((c) => sql`k.${id(c.name)} = m.${id(c.name)}`),
        sql` and `,
      );
      const org = id(link.organization.name);
      const who = id(link.contact.name);
      await tx.execute(
        sql`delete from ${link.table} as m where m.${org} = ${orgId} and m.${who} = ${from} and exists (select 1 from ${link.table} as k where k.${org} = ${orgId} and k.${who} = ${to} and ${same})`,
      );
    }
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
 * Returns what it touched, so the delete can put it on its event and a trash
 * can put it back: the ids it unlinked, and whole rows it removed. Every
 * unlink and remove table is keyed on `id`.
 */
export async function releaseLinks(
  tx: Conn,
  orgId: string,
  ids: string[],
  record: Of = "contact",
): Promise<ReleasedLinks> {
  const released: ReleasedLinks = [];
  for (const id of ids) {
    for (const link of of(record)) {
      const key = `${link.moduleId}.${link.id}`;
      if (link.onDelete === "unlink") {
        const rows = await tx.execute<{ id: string }>(
          sql`update ${link.table} set ${sql.identifier(link.contact.name)} = null where ${where(link, orgId, id)} returning id::text as id`,
        );
        if (rows.length) {
          released.push({
            link: key,
            unlinked: rows.map((r) => r.id),
            removed: [],
          });
        }
      } else if (link.onDelete === "remove") {
        const rows = await tx.execute<{ row: Record<string, unknown> }>(
          sql`delete from ${link.table} where ${where(link, orgId, id)} returning to_jsonb(${link.table}.*) as row`,
        );
        if (rows.length) {
          released.push({
            link: key,
            unlinked: [],
            removed: rows.map((r) => r.row),
          });
        }
      }
    }
  }
  return released;
}

/**
 * And back again, for a contact a trash restores.
 *
 * Only a link still cleared is set, so a row somebody has since matched to
 * another contact stays theirs; a removed row comes back unless one with its
 * id already has. A link this instance no longer loads is skipped.
 */
export async function restoreLinks(
  orgId: string,
  contactId: string,
  released: ReleasedLinks,
): Promise<void> {
  const loaded = new Map(
    contactLinks().map((l) => [`${l.moduleId}.${l.id}`, l]),
  );
  await db.transaction(async (tx) => {
    for (const entry of released) {
      const link = loaded.get(entry.link);
      if (!link) continue;
      const who = sql.identifier(link.contact.name);
      const org = sql.identifier(link.organization.name);
      if (entry.unlinked.length) {
        await tx.execute(
          sql`update ${link.table} set ${who} = ${contactId} where ${org} = ${orgId} and ${who} is null and id::text in (${sql.join(
            entry.unlinked.map((u) => sql`${u}`),
            sql`, `,
          )})`,
        );
      }
      if (entry.removed.length) {
        await tx.execute(
          sql`insert into ${link.table} select * from jsonb_populate_recordset(null::${link.table}, ${JSON.stringify(entry.removed)}::jsonb) on conflict do nothing`,
        );
      }
    }
  });
}
