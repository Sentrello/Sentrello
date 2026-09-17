import { db, schema } from "@sentrello/db";
import { invoiceState } from "@sentrello/db/money";
import { ensurePortalToken } from "@sentrello/db/portal";
import type { ModuleContext, SummaryFigure } from "@sentrello/module-sdk";
import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { creditedAgainst } from "./documents";

/**
 * Invoicing's contribution to the unified customer account page.
 *
 * The figures a customer would want without opening anything: what they owe,
 * what they have actually paid, and — only when it is true — that some of it
 * is overdue. `href` sends them on to the portal they already have rather
 * than rebuilding it here; this is a summary of that page, not a second copy.
 *
 * A draft is the business thinking out loud and a void was taken back —
 * neither is a bill this customer has been sent, so neither counts here, the
 * same filter `/portal/:token` applies. Every total is derived the way the
 * portal derives its own: `totalCents` came out of `documentTotals` when the
 * invoice was raised, credited amounts come from the one shared
 * `creditedAgainst`, and `invoiceState` turns the two into a balance and the
 * word for it — the same call the portal's badge comes from, so the figure
 * here and the badge there cannot tell two stories.
 */

const NOT_SENT = ["draft", "void"];

function invoiceScope(organizationId: string, contactId: string) {
  return and(
    eq(schema.invoices.organizationId, organizationId),
    eq(schema.invoices.contactId, contactId),
    eq(schema.invoices.kind, "invoice"),
    isNull(schema.invoices.deletedAt),
    notInArray(schema.invoices.status, NOT_SENT),
  );
}

/** Whether this customer has ever been sent an invoice at all. */
export async function invoicingHasAccountActivity(
  organizationId: string,
  contactId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.invoices.id })
    .from(schema.invoices)
    .where(invoiceScope(organizationId, contactId))
    .limit(1);
  return Boolean(row);
}

export async function invoicingAccountFigures(
  organizationId: string,
  contactId: string,
): Promise<SummaryFigure[]> {
  const invoices = await db
    .select({
      id: schema.invoices.id,
      totalCents: schema.invoices.totalCents,
      currency: schema.invoices.currency,
      dueDate: schema.invoices.dueDate,
      status: schema.invoices.status,
      // Debt given up for paying early settles the invoice without any money
      // arriving. Left out, this page kept billing a customer for the saving
      // their invoice had already granted them.
      earlyDiscountTakenCents: schema.invoices.earlyDiscountTakenCents,
    })
    .from(schema.invoices)
    .where(invoiceScope(organizationId, contactId));

  const currency = invoices[0]?.currency ?? "USD";
  if (invoices.length === 0) {
    return [{ label: "You owe", value: 0, kind: "money", currency }];
  }

  const ids = invoices.map((i) => i.id);
  const [paidRows, credited] = await Promise.all([
    db
      .select({
        invoiceId: schema.payments.invoiceId,
        amountCents: schema.payments.amountCents,
      })
      .from(schema.payments)
      .where(
        and(
          eq(schema.payments.organizationId, organizationId),
          inArray(schema.payments.invoiceId, ids),
        ),
      ),
    creditedAgainst(organizationId, ids),
  ]);

  const now = new Date();
  let owedCents = 0;
  let paidCents = 0;
  let overdueCents = 0;
  for (const invoice of invoices) {
    const paid = paidRows
      .filter((p) => p.invoiceId === invoice.id)
      .reduce((sum, p) => sum + p.amountCents, 0);
    paidCents += paid;

    const { balanceDue, badge } = invoiceState(
      invoice,
      paid,
      credited.get(invoice.id) ?? 0,
      now,
    );
    owedCents += balanceDue;
    // "Overdue" here and "overdue" on the portal badge are the same word about
    // the same invoice, so they are the same decision: one function, one rule
    // about the instant a bill falls due.
    if (badge === "overdue") overdueCents += balanceDue;
  }

  const figures: SummaryFigure[] = [
    { label: "You owe", value: owedCents, kind: "money", currency },
    {
      label: "Paid",
      value: paidCents,
      kind: "money",
      currency,
      tone: paidCents > 0 ? "good" : "plain",
    },
  ];
  // Left off entirely rather than shown as zero — a figure that never
  // matters except when it is bad has no business sitting at "plain" for
  // every customer who is not late.
  if (overdueCents > 0) {
    figures.push({
      label: "Overdue",
      value: overdueCents,
      kind: "money",
      currency,
      tone: "bad",
    });
  }
  return figures;
}

export function registerInvoicingAccountSection(ctx: ModuleContext): void {
  ctx.registerAccountSection({
    id: "invoicing",
    label: "Invoices",
    icon: "receipt",
    // No `entitlement`: loading the module on Free is the entitlement, same
    // as the dashboard summary above.
    hasAny: invoicingHasAccountActivity,
    load: invoicingAccountFigures,
    href: async (organizationId, contactId) => {
      const [contact] = await db
        .select({
          id: schema.contacts.id,
          portalToken: schema.contacts.portalToken,
        })
        .from(schema.contacts)
        .where(
          and(
            eq(schema.contacts.id, contactId),
            eq(schema.contacts.organizationId, organizationId),
          ),
        )
        .limit(1);
      if (!contact) return null;
      return `/portal/${await ensurePortalToken(contact)}`;
    },
  });
}
