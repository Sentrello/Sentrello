/**
 * A column called `updated_at` says when the row last changed, or it says
 * nothing.
 *
 * Drizzle's `defaultNow()` fires on insert and never again, so an update that
 * does not set the column leaves it describing the insert. Two writes in
 * invoicing did exactly that — recording a payment and applying a credit both
 * change an invoice's status and neither stamped it — so an invoice paid last
 * week still said it was last changed the day it was drafted. Nothing notices,
 * because the column is right on most paths, which is worse than being wrong on
 * all of them: the concurrency check reads it, and a row left claiming an older
 * version refuses a save from the only person editing.
 *
 * This replaces a textual sweep (`apps/server/src/updated-at-is-true.test.ts`)
 * that read every `.update(...).set({ … })` and asked whether `updatedAt` was
 * in it. It found the invoicing pair, and it had three heuristic exclusions by
 * the end — a `.set()` built elsewhere is invisible to it, and so is every
 * writer added after the next refactor. The stamp belongs to the database
 * instead, and these two tests are what makes that worth trusting: the trigger
 * moves the column on a write that never mentions it, and every table of ours
 * keeping the column has the trigger. The second asks the catalogue rather than
 * a list written here, so a table added next month is covered by a test written
 * today.
 */
import { afterAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "./client";
import * as schema from "./schema";

const org = `stamp-${crypto.randomUUID()}`;

afterAll(async () => {
  await db.delete(schema.organizations).where(eq(schema.organizations.id, org));
});

test("a write that never mentions the column still moves it", async () => {
  await db
    .insert(schema.organizations)
    .values({ id: org, name: org, slug: org, createdAt: new Date() });
  const [contact] = await db
    .insert(schema.contacts)
    .values({ organizationId: org, name: "Ruth Adeyemi" })
    .returning();
  if (!contact) throw new Error("no contact");

  // Far enough back that a clock with millisecond resolution cannot explain
  // the difference, and set with raw SQL so the trigger is the only thing
  // that could move it.
  await db.execute(
    sql`update contacts set updated_at = now() - interval '1 day' where id = ${contact.id}`,
  );
  const stale = await read(contact.id);

  await db
    .update(schema.contacts)
    .set({ name: "Ruth Okonjo" })
    .where(eq(schema.contacts.id, contact.id));

  expect((await read(contact.id)).getTime()).toBeGreaterThan(stale.getTime());
});

async function read(id: string): Promise<Date> {
  const [row] = await db
    .select({ updatedAt: schema.contacts.updatedAt })
    .from(schema.contacts)
    .where(eq(schema.contacts.id, id));
  if (!row) throw new Error("gone");
  return row.updatedAt;
}

test("every table of ours that keeps the column has the trigger", async () => {
  const rows = (await db.execute(sql`
    select c.table_name as table_name,
           exists (
             select 1 from pg_trigger g
             join pg_class k on k.oid = g.tgrelid
             join pg_proc p on p.oid = g.tgfoid
             where k.relname = c.table_name
               and not g.tgisinternal
               and p.proname = 'stamp_updated_at'
           ) as stamped
    from information_schema.columns c
    where c.table_schema = 'public' and c.column_name = 'updated_at'
      -- Better Auth's own four, which the library maintains and nothing of
      -- ours decides anything from.
      and c.table_name not in ('account', 'session', 'user', 'verification')
    order by 1
  `)) as unknown as { table_name: string; stamped: boolean }[];

  // A corpus this small means the question was not asked — see the test
  // database preload for why a sweep has to refuse rather than agree.
  expect(rows.length).toBeGreaterThan(20);
  expect(rows.filter((r) => !r.stamped).map((r) => r.table_name)).toEqual([]);
});
