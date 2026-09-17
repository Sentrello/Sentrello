import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "./client";
import * as schema from "./schema";
import { dropOrganization } from "./testing";

/**
 * The helper every suite tidies up with has to leave nothing behind.
 *
 * Asserted against the catalogue rather than a list written here, because a
 * list written here is the bug: `dropOrganization` used to name seven tables,
 * and the other nineteen that carry an `organizationId` were simply left. One
 * of them was `invoices`, where an orphan is not litter — every sweep in the
 * platform selects what is due across all organizations, so a row belonging to
 * an organization that no longer exists is a row the next run picks up.
 *
 * Derived, so a table a module adds tomorrow is covered tomorrow without
 * anybody remembering to come back here.
 */
async function orgScopedTables(): Promise<{ schema: string; name: string }[]> {
  return (await db.execute(sql`
    select n.nspname as schema, c.relname as name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'r'
      and n.nspname not in ('pg_catalog', 'information_schema', 'pgboss')
      and exists (select 1 from pg_attribute a
                   where a.attrelid = c.oid and a.attname = 'organization_id'
                     and a.attnum > 0 and not a.attisdropped)
  `)) as unknown as { schema: string; name: string }[];
}

test("dropOrganization leaves nothing in any organization-scoped table", async () => {
  const orgId = `drop-${crypto.randomUUID().slice(0, 8)}`;
  await db.insert(schema.organizations).values({
    id: orgId,
    name: "Dropped",
    slug: orgId,
    createdAt: new Date(),
  });

  /*
   * A spread of tables no single suite would touch at once, and every one of
   * them a table the old hand-written list did not mention. The invoice
   * carries a due date, which is the row that made this worth a test.
   */
  const [invoice] = await db
    .insert(schema.invoices)
    .values({
      organizationId: orgId,
      number: "INV-DROP-1",
      status: "open",
      dueDate: new Date(),
      subtotalCents: 1000,
      totalCents: 1000,
    })
    .returning();
  if (!invoice) throw new Error("invoice insert returned no row");
  await db.insert(schema.invoiceLines).values({
    invoiceId: invoice.id,
    description: "A line, reached only through its invoice",
    quantity: 1,
    quantityMilli: 1000,
    unitPriceCents: 1000,
  });
  await db
    .insert(schema.tasks)
    .values({ organizationId: orgId, title: "Chase it", dueAt: new Date() });
  await db.insert(schema.contacts).values({ organizationId: orgId, name: "A" });

  await dropOrganization(orgId);

  const tables = await orgScopedTables();
  expect(tables.length).toBeGreaterThan(7);
  const left: string[] = [];
  for (const table of tables) {
    const rows = (await db.execute(sql`
      select count(*)::int as n
      from ${sql.identifier(table.schema)}.${sql.identifier(table.name)}
      where organization_id = ${orgId}
    `)) as unknown as { n: number }[];
    if ((rows[0]?.n ?? 0) > 0) left.push(`${table.name}: ${rows[0]?.n}`);
  }
  expect(left).toEqual([]);

  // And the children that carry no organization of their own, reached through
  // the parent that did.
  const lines = (await db.execute(sql`
    select count(*)::int as n from invoice_lines where invoice_id = ${invoice.id}
  `)) as unknown as { n: number }[];
  expect(lines[0]?.n).toBe(0);
});
