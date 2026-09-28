import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "./client";
import * as schema from "./schema";
import { dropOrganization, makeOrganization } from "./testing";

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

/**
 * A child row goes when its document goes — enforced by the database.
 *
 * Seven tables carry no `organizationId`: they are reached only through the
 * document that owns them. Until 2026-09-28 they had no foreign key to that
 * document either, so removing a business deleted its invoices, quotes,
 * bills, budgets, journal entries and tags and left every line, instalment
 * and tag pairing behind — rows no query in the product can find and no
 * sweep can see, because they name no organization to be swept by. This
 * database held 32,181 of them the day the keys went in.
 *
 * Deliberately a raw `delete from organizations` rather than
 * `dropOrganization`: the helper used to do this by hand, from a list of
 * table relationships kept beside the schema and always one module behind
 * it. Drop the constraints and this test fails; drop the helper's list and it
 * does not.
 */
test("deleting an organization takes the lines of its documents", async () => {
  const orgId = await makeOrganization(
    `child-${crypto.randomUUID().slice(0, 8)}`,
  );
  const other = crypto.randomUUID();

  try {
    const [invoice] = await db
      .insert(schema.invoices)
      .values({
        organizationId: orgId,
        number: "INV-CHILD-1",
        totalCents: 1000,
      })
      .returning();
    const [quote] = await db
      .insert(schema.quotes)
      .values({ organizationId: orgId, number: "QUO-CHILD-1" })
      .returning();
    const [bill] = await db
      .insert(schema.bills)
      .values({ organizationId: orgId, number: "BILL-CHILD-1" })
      .returning();
    const [budget] = await db
      .insert(schema.budgets)
      .values({ organizationId: orgId, name: "2026", year: 2026 })
      .returning();
    const [entry] = await db
      .insert(schema.journalEntries)
      .values({ organizationId: orgId, memo: "Opening" })
      .returning();
    const [tag] = await db
      .insert(schema.tags)
      .values({ organizationId: orgId, name: "Urgent" })
      .returning();
    if (!invoice || !quote || !bill || !budget || !entry || !tag) {
      throw new Error("a parent insert returned no row");
    }

    await db.insert(schema.invoiceLines).values({
      invoiceId: invoice.id,
      description: "A line reached only through its invoice",
      unitPriceCents: 1000,
    });
    await db.insert(schema.quoteLines).values({
      quoteId: quote.id,
      description: "A line reached only through its quote",
      unitPriceCents: 1000,
    });
    await db
      .insert(schema.quoteInstalments)
      .values({ quoteId: quote.id, seq: 1, shareBp: 10_000, label: "Deposit" });
    await db.insert(schema.billLines).values({
      billId: bill.id,
      description: "A line reached only through its bill",
      unitPriceCents: 1000,
    });
    await db
      .insert(schema.budgetLines)
      .values({ budgetId: budget.id, accountId: other, amountCents: 1000 });
    await db.insert(schema.journalLines).values([
      { entryId: entry.id, accountId: other, debitCents: 1000 },
      { entryId: entry.id, accountId: other, creditCents: 1000 },
    ]);
    await db
      .insert(schema.taggables)
      .values({ tagId: tag.id, entityType: "contact", entityId: other });

    // The database on its own, with no help from any list kept in TypeScript.
    await db.execute(sql`delete from organizations where id = ${orgId}`);

    const children: [table: string, column: string, parent: string][] = [
      ["invoice_lines", "invoice_id", invoice.id],
      ["quote_lines", "quote_id", quote.id],
      ["quote_instalments", "quote_id", quote.id],
      ["bill_lines", "bill_id", bill.id],
      ["budget_lines", "budget_id", budget.id],
      ["journal_lines", "entry_id", entry.id],
      ["taggables", "tag_id", tag.id],
    ];
    const left: string[] = [];
    for (const [table, column, parentId] of children) {
      const rows = (await db.execute(sql`
        select count(*)::int as n from ${sql.identifier(table)}
        where ${sql.identifier(column)} = ${parentId}
      `)) as unknown as { n: number }[];
      if ((rows[0]?.n ?? 0) > 0) left.push(`${table}: ${rows[0]?.n}`);
    }
    expect(left).toEqual([]);
  } finally {
    await dropOrganization(orgId);
  }
});
