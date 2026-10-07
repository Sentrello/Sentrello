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
 * thousand orphaned roles: every suite that calls `seedDefaults` writes a dozen
 * policies and a handful of groups, and nothing took them away again.
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
 * **The schema does most of it now.** This note used to say cascading was the
 * right shape in a fresh schema and the wrong thing to add here. It was added
 * anyway, in two passes: every organization-scoped column got a key on
 * 2026-09-27, and on 2026-09-28 so did the child tables that carry no
 * organization at all — an invoice's lines, a quote's instalments, a tag's
 * pairings. Both migrations swept the existing orphans first, which was the
 * objection. What is left here is a sweep by `organization_id`, kept because
 * module schemas are created by migrations in other repositories and not all
 * of them have been through this pass yet.
 *
 * Order does not matter: no business table references another, and the
 * children come away with their documents.
 */

/**
 * An organization that actually exists, for a test that needs to own rows.
 *
 * Every business table has a foreign key to `organizations` as of
 * 2026-09-27, so a fixture that invents an id — `audit-chain-3f2a` and its
 * kind — can no longer insert anything. That was the point of the
 * constraint: a row belonging to nobody is a row no query can reach and no
 * sweep should find. It does mean a test that wants to own data has to say
 * whose it is.
 *
 * Idempotent, so a file can call it in `beforeAll` without caring whether a
 * previous run left it behind. Deleting the organization afterwards takes
 * the test's rows with it, which is what `dropOrganization` below now
 * mostly relies on.
 */
export async function makeOrganization(
  id: string,
  name = `Test ${id}`,
): Promise<string> {
  await db
    .insert(schema.organizations)
    .values({ id, name, slug: id, createdAt: new Date() })
    .onConflictDoNothing();
  return id;
}

export async function dropOrganization(...orgIds: string[]): Promise<void> {
  /*
   * Whatever of them actually exists.
   *
   * A suite whose `beforeAll` fails part-way calls this with `undefined` for
   * the business it never got to — and an undefined id made the whole teardown
   * throw, so the businesses it *had* created stayed behind. One leftover
   * organisation is eighty failures in three other modules the next time the
   * suite runs, none of them naming why.
   */
  const ids = orgIds.filter((id): id is string => Boolean(id));
  if (ids.length === 0) return;
  const list = sql.join(
    ids.map((id) => sql`${id}`),
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

  /*
   * The tables carrying no `organizationId` — invoice lines, quote lines and
   * instalments, bill and budget lines, journal lines, tag pairings — used to
   * be listed here by hand and deleted first, because they had no foreign key
   * to the document that owns them. Since 2026-09-28 they do, and it cascades,
   * so deleting the parent takes them along. A hand-maintained list of table
   * relationships drifts from the schema; the schema does not drift from
   * itself.
   */
  /*
   * **The organization goes first, and the sweep below is the safety net.**
   *
   * This swept the scoped tables and then deleted the organization, in whatever
   * order the catalogue happened to list them — and a table that another table
   * points at cannot go first. The till is where that showed: `pos.tickets`
   * references `pos.order_types`, so a suite with one ticket in it tore down
   * with "update or delete on table order_types violates foreign key
   * constraint", in an `afterAll`, after everything it was testing had passed.
   *
   * Every business table cascades from `organizations` since 2026-09-28, which
   * means Postgres already knows the order and does not need to be told. The
   * sweep stays because it costs nothing on a database where the cascade did
   * the work, and it is the only thing that would catch a table that is scoped
   * and *not* cascading — which is a schema bug rather than a teardown one, and
   * better found as leftover rows than as a passing test.
   */
  await db.execute(sql`
    delete from ${sql.identifier("organizations")} where id in (${list})
  `);

  for (const [name, nsp] of scoped) {
    await db.execute(sql`
      delete from ${sql.identifier(nsp)}.${sql.identifier(name)}
      where organization_id in (${list})
    `);
  }
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
