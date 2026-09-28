import { db, schema } from "@sentrello/db";
import { creditedAgainst } from "@sentrello/db/documents";
import { and, eq, gte, isNull } from "drizzle-orm";

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
  topCustomers: { name: string; cents: number }[];
  aging: { bucket: string; cents: number; count: number }[];
}

/** `2026-08`, so months sort as strings and group without a date library. */
function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function readInsights(organizationId: string): Promise<Insights> {
  const now = new Date();
  const from = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1),
  );

  const [ledger, deals, invoices, contacts, payments] = await Promise.all([
    // The ledger, not the invoice table. A reported figure that disagrees with
    // the books is worse than no figure, and the books are the ones defended.
    db
      .select({
        postedAt: schema.journalEntries.postedAt,
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
          gte(schema.journalEntries.postedAt, from),
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
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1),
    );
    const key = monthKey(d);
    months.set(key, {
      month: key,
      incomeCents: 0,
      expenseCents: 0,
      netCents: 0,
    });
  }
  for (const line of ledger) {
    const bucket = months.get(monthKey(new Date(line.postedAt)));
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
  const byCustomer = new Map<string, number>();
  for (const inv of invoices) {
    if (inv.deletedAt || inv.status === "void" || inv.status === "draft")
      continue;
    const name = inv.contactId
      ? (names.get(inv.contactId) ?? "Unnamed")
      : "No customer";
    // A credit note is billing in reverse: a customer billed 10,000 and
    // credited 4,000 brought in 6,000, not 14,000.
    const cents = inv.kind === "credit_note" ? -inv.totalCents : inv.totalCents;
    byCustomer.set(name, (byCustomer.get(name) ?? 0) + cents);
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
    const days = inv.dueDate
      ? Math.floor(
          (now.getTime() - new Date(inv.dueDate).getTime()) / 86_400_000,
        )
      : 0;
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
      .map(([name, cents]) => ({ name, cents }))
      .sort((a, b) => b.cents - a.cents)
      .slice(0, 5),
    aging,
  };
}
