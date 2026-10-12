import { db, schema } from "@sentrello/db";
import { dayIn } from "@sentrello/db/day";
import { owingInvoices } from "@sentrello/db/documents";
import { entryDay, entryDayWithin } from "@sentrello/db/ledger";
import { sumCents } from "@sentrello/db/money";
import { timezoneFor } from "@sentrello/db/timezone";
import { and, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";

/**
 * The half of the dashboard a licence pays for.
 *
 * Free answers "what needs doing today". This answers "how is the business
 * doing", which is a different question and a slower one — twelve months of
 * ledger rather than a list of what is late. The arranging of it is not paid
 * and lives in `layout.ts`; what Pro sells is these panels.
 *
 * Charts are computed here and drawn as plain SVG on the client. A charting
 * library would be a dependency in a public repo for what amounts to a
 * polyline and some rectangles.
 */

export interface Insights {
  months: {
    month: string;
    incomeCents: number;
    expenseCents: number;
    netCents: number;
  }[];
  dealsByStage: { stage: string; count: number; cents: number }[];
  /**
   * Who brings the money in, and which record that is.
   *
   * Keyed by the contact rather than by the name, which is both what makes the
   * panel pressable and a quiet fix: two customers called the same thing were
   * one row, adding up to a figure neither of them had billed. `contactId` is
   * null for invoices raised against nobody, which is a real row and not a
   * record anybody can open.
   */
  topCustomers: { contactId: string | null; name: string; cents: number }[];
  aging: { bucket: string; cents: number; count: number }[];
}

/**
 * Months are keyed `2026-08`, so they sort as strings, and an entry lands in
 * the month of its own day where the business is (`entryDay`): a sale after
 * six in the evening on the 31st in Denver is the 31st's, and a bill dated the
 * 1st is the 1st's, though its midnight UTC is the evening before there.
 */
export async function readInsights(organizationId: string): Promise<Insights> {
  const now = new Date();
  const zone = await timezoneFor(organizationId);
  /*
   * This month is the business's month. Taken from UTC, a business in New
   * York read the 1st's midnight as the evening of the month before, and the
   * twelve buckets ran from a year ago to last month.
   */
  const today = dayIn(now, zone);
  const monthStart = (back: number) =>
    new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - back, 1));
  // A day, by its UTC date: the first of the month eleven months back.
  const from = monthStart(11);

  const todayIso = today.toISOString().slice(0, 10);
  const owing = owingInvoices(organizationId);
  // Whole days late, as `daysLate` counts them: the business's today less the
  // due date's own UTC day. No due date reads as not yet due.
  const late = sql`coalesce(${todayIso}::date - (${owing.dueDate})::date, 0)`;
  const slot = sql<number>`(case when ${late} <= 0 then 0 when ${late} <= 30 then 1 when ${late} <= 60 then 2 when ${late} <= 90 then 3 else 4 end)`;
  const billed = sql`case when ${schema.invoices.kind} = 'credit_note' then -${schema.invoices.totalCents} else ${schema.invoices.totalCents} end`;
  const month = sql<string>`to_char(${entryDay(zone)}, 'YYYY-MM')`;

  /*
   * Every figure is added up by the database. This read twelve months of
   * journal lines, every invoice, contact and payment the business had ever
   * written into the process to add up in JavaScript — and handed every
   * invoice id to one query, which past 65,534 of them the driver refuses.
   */
  const [ledger, deals, customers, aged] = await Promise.all([
    // The ledger, not the invoice table. A reported figure that disagrees with
    // the books is worse than no figure, and the books are the ones defended.
    db
      .select({
        // The entry's day, the rule every report reads it by — see `entryDay`.
        month,
        type: schema.accounts.type,
        debitCents: sumCents(schema.journalLines.debitCents),
        creditCents: sumCents(schema.journalLines.creditCents),
      })
      .from(schema.journalLines)
      .innerJoin(
        schema.journalEntries,
        eq(schema.journalLines.entryId, schema.journalEntries.id),
      )
      .innerJoin(
        schema.accounts,
        eq(schema.journalLines.accountId, schema.accounts.id),
      )
      .where(
        and(
          eq(schema.journalEntries.organizationId, organizationId),
          eq(schema.accounts.organizationId, organizationId),
          inArray(schema.accounts.type, ["income", "expense"]),
          entryDayWithin({ from }, zone),
        ),
      )
      // By position: the month carries the zone as a parameter, and a GROUP BY
      // that repeats it binds a second one Postgres will not match to the first.
      .groupBy(sql`1`, schema.accounts.type),
    db
      .select({
        stage: schema.deals.stage,
        count: sql<number>`count(*)::int`,
        cents: sumCents(schema.deals.amountCents),
      })
      .from(schema.deals)
      .where(
        and(
          eq(schema.deals.organizationId, organizationId),
          isNull(schema.deals.archivedAt),
        ),
      )
      .groupBy(schema.deals.stage)
      .orderBy(desc(sumCents(schema.deals.amountCents))),
    // Keyed by the record, not by what it is called. Two customers with one
    // name were one row before this, showing a figure neither had billed.
    // A credit note is billing in reverse: a customer billed 10,000 and
    // credited 4,000 brought in 6,000, not 14,000.
    db
      .select({
        contactId: schema.invoices.contactId,
        firstName: schema.contacts.firstName,
        lastName: schema.contacts.lastName,
        cents: sumCents(billed),
      })
      .from(schema.invoices)
      .leftJoin(
        schema.contacts,
        and(
          eq(schema.contacts.id, schema.invoices.contactId),
          eq(schema.contacts.organizationId, organizationId),
        ),
      )
      .where(
        and(
          eq(schema.invoices.organizationId, organizationId),
          isNull(schema.invoices.deletedAt),
          notInArray(schema.invoices.status, ["void", "draft"]),
        ),
      )
      .groupBy(schema.invoices.contactId, schema.contacts.id)
      .orderBy(desc(sumCents(billed)))
      .limit(5),
    /*
     * What is still owed on each invoice, not what it was billed at — the
     * same `owingInvoices` the Money panel and the invoice list read, so a
     * part payment or the credited share of an invoice never sits in "over
     * 90 days" as money nobody is owed. Only debt ages: not a credit note,
     * not a draft, not an invoice already settled.
     */
    db
      .select({
        slot,
        cents: sumCents(owing.owedCents),
        count: sql<number>`count(*)::int`,
      })
      .from(owing)
      .where(sql`${owing.owedCents} > 0`)
      .groupBy(sql`1`),
  ]);

  // Every month in the window, including the quiet ones. A series that skips
  // empty months draws a line that slopes through a gap it never had.
  const months = new Map<
    string,
    {
      month: string;
      incomeCents: number;
      expenseCents: number;
      netCents: number;
    }
  >();
  for (let i = 11; i >= 0; i -= 1) {
    const d = monthStart(i);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    months.set(key, {
      month: key,
      incomeCents: 0,
      expenseCents: 0,
      netCents: 0,
    });
  }
  for (const row of ledger) {
    const bucket = months.get(row.month);
    if (!bucket) continue;
    // Income accounts carry credit balances, expense accounts debit balances.
    if (row.type === "income")
      bucket.incomeCents += row.creditCents - row.debitCents;
    if (row.type === "expense")
      bucket.expenseCents += row.debitCents - row.creditCents;
  }
  for (const bucket of months.values()) {
    bucket.netCents = bucket.incomeCents - bucket.expenseCents;
  }

  // How late the money is, not just that it is late. Thirty days out is a
  // reminder; ninety is a decision about whether it is coming at all.
  const aging = [
    { bucket: "Not yet due", cents: 0, count: 0 },
    { bucket: "1–30 days", cents: 0, count: 0 },
    { bucket: "31–60 days", cents: 0, count: 0 },
    { bucket: "61–90 days", cents: 0, count: 0 },
    { bucket: "Over 90 days", cents: 0, count: 0 },
  ];
  for (const row of aged) {
    const bucket = aging[Number(row.slot)];
    if (!bucket) continue;
    bucket.cents = row.cents;
    bucket.count = row.count;
  }

  return {
    months: [...months.values()],
    dealsByStage: deals.map((d) => ({
      stage: d.stage ?? "unknown",
      count: d.count,
      cents: d.cents,
    })),
    topCustomers: customers.map((c) => ({
      contactId: c.contactId,
      name: c.contactId
        ? [c.firstName, c.lastName].filter(Boolean).join(" ").trim() ||
          "Unnamed"
        : "No customer",
      cents: c.cents,
    })),
    aging,
  };
}
