import { db, schema } from "@sentrello/db";
import { dayIn, daysLate } from "@sentrello/db/day";
import { creditedAgainst } from "@sentrello/db/documents";
import { entryDay, entryDayWithin } from "@sentrello/db/ledger";
import { timezoneFor } from "@sentrello/db/timezone";
import { and, eq, isNull, sql } from "drizzle-orm";

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

  const [ledger, deals, invoices, contacts, payments] = await Promise.all([
    // The ledger, not the invoice table. A reported figure that disagrees with
    // the books is worse than no figure, and the books are the ones defended.
    db
      .select({
        // The entry's day, the rule every report reads it by — see `entryDay`.
        day: sql<string>`${entryDay(zone)}::text`,
        type: schema.accounts.type,
        debitCents: schema.journalLines.debitCents,
        creditCents: schema.journalLines.creditCents,
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
          entryDayWithin({ from }, zone),
        ),
      ),
    db
      .select()
      .from(schema.deals)
      .where(
        and(
          eq(schema.deals.organizationId, organizationId),
          isNull(schema.deals.archivedAt),
        ),
      ),
    db
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.organizationId, organizationId)),
    db
      .select({
        id: schema.contacts.id,
        firstName: schema.contacts.firstName,
        lastName: schema.contacts.lastName,
      })
      .from(schema.contacts)
      .where(eq(schema.contacts.organizationId, organizationId)),
    db
      .select({
        invoiceId: schema.payments.invoiceId,
        amountCents: schema.payments.amountCents,
      })
      .from(schema.payments)
      .where(eq(schema.payments.organizationId, organizationId)),
  ]);

  /**
   * What is still owed on each invoice, not what it was billed at.
   *
   * The aged-debt buckets used to carry face values, so a part payment — or
   * the credited share of a partly credited invoice — sat in "over 90 days"
   * as money nobody was owed. Payments and credits come off before anything
   * is bucketed, the same subtraction the invoice list shows.
   */
  const paidByInvoice = new Map<string, number>();
  for (const p of payments) {
    if (!p.invoiceId) continue;
    paidByInvoice.set(
      p.invoiceId,
      (paidByInvoice.get(p.invoiceId) ?? 0) + p.amountCents,
    );
  }
  const creditedByInvoice = await creditedAgainst(
    organizationId,
    invoices.filter((i) => i.kind === "invoice").map((i) => i.id),
  );
  const owedOn = (inv: { id: string; totalCents: number }) =>
    Math.max(
      0,
      inv.totalCents -
        (paidByInvoice.get(inv.id) ?? 0) -
        (creditedByInvoice.get(inv.id) ?? 0),
    );

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
  for (const line of ledger) {
    const bucket = months.get(line.day.slice(0, 7));
    if (!bucket) continue;
    // Income accounts carry credit balances, expense accounts debit balances.
    if (line.type === "income")
      bucket.incomeCents += line.creditCents - line.debitCents;
    if (line.type === "expense")
      bucket.expenseCents += line.debitCents - line.creditCents;
  }
  for (const bucket of months.values()) {
    bucket.netCents = bucket.incomeCents - bucket.expenseCents;
  }

  const stages = new Map<
    string,
    { stage: string; count: number; cents: number }
  >();
  for (const deal of deals) {
    const stage = deal.stage ?? "unknown";
    const bucket = stages.get(stage) ?? { stage, count: 0, cents: 0 };
    bucket.count += 1;
    bucket.cents += deal.amountCents;
    stages.set(stage, bucket);
  }

  const names = new Map(
    contacts.map((c) => [
      c.id,
      [c.firstName, c.lastName].filter(Boolean).join(" ").trim() || "Unnamed",
    ]),
  );
  const byCustomer = new Map<string, { name: string; cents: number }>();
  for (const inv of invoices) {
    if (inv.deletedAt || inv.status === "void" || inv.status === "draft")
      continue;
    const name = inv.contactId
      ? (names.get(inv.contactId) ?? "Unnamed")
      : "No customer";
    // Keyed by the record, not by what it is called. Two customers with one
    // name were one row before this, showing a figure neither had billed.
    const key = inv.contactId ?? "";
    // A credit note is billing in reverse: a customer billed 10,000 and
    // credited 4,000 brought in 6,000, not 14,000.
    const cents = inv.kind === "credit_note" ? -inv.totalCents : inv.totalCents;
    const sofar = byCustomer.get(key);
    byCustomer.set(key, { name, cents: (sofar?.cents ?? 0) + cents });
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
  for (const inv of invoices) {
    // Only debt ages: not a credit note, not a draft nobody was asked for,
    // and not an invoice already settled — by money or by credit note alike.
    if (
      inv.kind !== "invoice" ||
      inv.deletedAt ||
      inv.status === "paid" ||
      inv.status === "credited" ||
      inv.status === "void" ||
      inv.status === "draft"
    )
      continue;
    const owed = owedOn(inv);
    if (owed <= 0) continue;
    // Whole days, counted as the business counts them: an invoice due today
    // sits in "not yet due", not in the first late bucket.
    const days = inv.dueDate ? daysLate(new Date(inv.dueDate), now, zone) : 0;
    const slot =
      days <= 0 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : days <= 90 ? 3 : 4;
    const bucket = aging[slot];
    if (!bucket) continue;
    bucket.cents += owed;
    bucket.count += 1;
  }

  return {
    months: [...months.values()],
    dealsByStage: [...stages.values()].sort((a, b) => b.cents - a.cents),
    topCustomers: [...byCustomer.entries()]
      .map(([contactId, row]) => ({
        contactId: contactId || null,
        name: row.name,
        cents: row.cents,
      }))
      .sort((a, b) => b.cents - a.cents)
      .slice(0, 5),
    aging,
  };
}
