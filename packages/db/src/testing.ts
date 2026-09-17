import { sql } from "drizzle-orm";
import { db } from "./client";
import { eq } from "./orm";
import * as schema from "./schema";

/**
 * Everything one organization owns, removed in one call.
 *
 * Test suites create an organization, fill it, and delete the organization
 * row — and no business table has a foreign key to it, so the rows it owned
 * simply stay. A single full run used to leave 72 `organization_role` rows and
 * 24 `user_groups` behind, which is how a test database reaches twenty-five
 * thousand orphaned roles: every suite that calls `seedDefaults` writes nine
 * policies and eight groups, and nothing took them away again.
 *
 * That is slow rather than wrong — but it also makes `select count(*) from
 * organizations = 0`, which this project uses as its "the suite cleaned up
 * after itself" check, a weaker claim than it looks: an empty organizations
 * table says nothing about the tables keyed by an id no longer in it. And one
 * of those tables is `invoices`, where an orphan is not litter at all: every
 * sweep in the platform — dunning, reminders, retries — selects what is due
 * *across all* organizations, so a row belonging to a business that no longer
 * exists is a row the next run picks up and counts.
 *
 * **The table list comes from the catalogue, not from here.** It used to be
 * seven names written down once, which was right on the day it was written and
 * wrong by the time nineteen more organization-scoped tables existed. A list
 * that has to be extended every time a module adds a table is a list that is
 * always one module out of date.
 *
 * Deliberately not solved with `on delete cascade`. That would be the right
 * shape in a fresh schema and the wrong thing to add here: the constraint
 * cannot be created while a real deployment still holds orphans, and an audit
 * log that disappears with the organization it describes is a decision to take
 * deliberately rather than one to acquire through a test-hygiene fix.
 *
 * Order matters only for readability — no business table references another —
 * but the children go first so a half-failed call leaves less behind than it
 * found.
 */

/**
 * The tables that carry no `organizationId` of their own.
 *
 * A line is reached through its document, which is the only organization it
 * has. Nothing here has a foreign key either, so deleting the parent first
 * would leave the child unreachable rather than taking it along.
 */
const CHILDREN: [child: string, column: string, parent: string][] = [
  ["invoice_lines", "invoice_id", "invoices"],
  ["quote_lines", "quote_id", "quotes"],
  ["quote_instalments", "quote_id", "quotes"],
  ["bill_lines", "bill_id", "bills"],
  ["budget_lines", "budget_id", "budgets"],
  ["journal_lines", "entry_id", "journal_entries"],
  ["taggables", "tag_id", "tags"],
];

export async function dropOrganization(...orgIds: string[]): Promise<void> {
  if (orgIds.length === 0) return;
  const ids = sql.join(
    orgIds.map((id) => sql`${id}`),
    sql`, `,
  );

  /*
   * Every table in this database that is keyed by an organization, whichever
   * module's migration created it. `pgboss` is excluded because its tables are
   * the job queue's own and are not scoped to anybody.
   */
  const tables = (await db.execute(sql`
    select n.nspname as schema, c.relname as name,
           exists (select 1 from pg_attribute a
                    where a.attrelid = c.oid and a.attname = 'organization_id'
                      and a.attnum > 0 and not a.attisdropped) as scoped
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'r'
      and n.nspname not in ('pg_catalog', 'information_schema', 'pgboss')
  `)) as unknown as { schema: string; name: string; scoped: boolean }[];

  const scoped = new Map(
    tables.filter((t) => t.scoped).map((t) => [t.name, t.schema]),
  );
  const present = new Set(tables.map((t) => t.name));

  for (const [child, column, parent] of CHILDREN) {
    if (!present.has(child) || !scoped.has(parent)) continue;
    await db.execute(sql`
      delete from ${sql.identifier(child)}
      where ${sql.identifier(column)} in (
        select id from ${sql.identifier(parent)}
        where organization_id in (${ids})
      )
    `);
  }

  for (const [name, nsp] of scoped) {
    await db.execute(sql`
      delete from ${sql.identifier(nsp)}.${sql.identifier(name)}
      where organization_id in (${ids})
    `);
  }

  await db.execute(sql`
    delete from ${sql.identifier("organizations")} where id in (${ids})
  `);
}

/** The people a suite signed up, and everything hanging off them. */
export async function dropUsers(...emails: string[]): Promise<void> {
  for (const email of emails) {
    const [user] = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, email.trim().toLowerCase()))
      .limit(1);
    if (!user) continue;
    await db.delete(schema.session).where(eq(schema.session.userId, user.id));
    await db.delete(schema.account).where(eq(schema.account.userId, user.id));
    await db
      .delete(schema.twoFactor)
      .where(eq(schema.twoFactor.userId, user.id));
    await db.delete(schema.user).where(eq(schema.user.id, user.id));
  }
}
