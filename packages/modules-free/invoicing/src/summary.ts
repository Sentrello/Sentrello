import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import {
  and,
  at,
  db,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  or,
  schema,
  sql,
} from "@sentrello/db";
import { creditedAgainst } from "@sentrello/db/documents";
import { sumCents } from "@sentrello/db/money";
import type { ModuleContext, SummaryFigure } from "@sentrello/module-sdk";
import { scoreFor } from "@sentrello/module-sdk";

/**
 * What Invoicing has to say on the dashboard, and on its own first screen.
 *
 * Four numbers, chosen because they are the ones a business owner asks about
 * money without being asked to: what is owed, what is late, what came in this
 * month, and what is sitting in drafts nobody has sent. The last is the one
 * nothing else surfaces — an invoice written and never issued is work already
 * done and money nobody has been asked for.
 *
 * A handful of small queries rather than one: what is owed has to net off
 * payments and credit notes per invoice, the same way the dashboard's own
 * Money widget does, or the two cards on one screen tell two different
 * amounts for the same invoice.
 */
export async function invoicingFigures(
  organizationId: string,
): Promise<SummaryFigure[]> {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [row] = await db
    .select({
      billedCents: sumCents(sql`
        case when ${schema.invoices.status} <> 'draft'
          and ${schema.invoices.status} <> 'void'
          and ${schema.invoices.issueDate} >= ${at(monthStart)}
          then ${schema.invoices.totalCents} else 0 end
      `),
      drafts: sql<number>`count(*) filter (
        where ${schema.invoices.status} = 'draft'
      )::int`,
    })
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.organizationId, organizationId),
        isNull(schema.invoices.deletedAt),
      ),
    );

  /**
   * What has been issued and not settled — not what was issued.
   *
   * Summing `totalCents` for every open invoice used to be the whole
   * calculation, which overstated a partially paid one by exactly what had
   * already come in for it: the dashboard's own Money widget nets payments
   * and credit notes off the total before calling anything "owed", and this
   * panel sat right beside it disagreeing by the part-payment. Same
   * definition here, so the two cards on one screen cannot tell two different
   * amounts for the same invoice.
   */
  const unpaid = await db
    .select({
      id: schema.invoices.id,
      totalCents: schema.invoices.totalCents,
      dueDate: schema.invoices.dueDate,
    })
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.organizationId, organizationId),
        isNull(schema.invoices.deletedAt),
        sql`${schema.invoices.status} in ('open', 'partial', 'overdue')`,
      ),
    );

  const paidByInvoice = new Map<string, number>();
  if (unpaid.length > 0) {
    const paid = await db
      .select({
        invoiceId: schema.payments.invoiceId,
        cents: sumCents(schema.payments.amountCents),
      })
      .from(schema.payments)
      .where(
        and(
          eq(schema.payments.organizationId, organizationId),
          inArray(
            schema.payments.invoiceId,
            unpaid.map((i) => i.id),
          ),
        ),
      )
      .groupBy(schema.payments.invoiceId);
    for (const p of paid) {
      if (p.invoiceId) paidByInvoice.set(p.invoiceId, p.cents);
    }
  }
  const creditedByInvoice = await creditedAgainst(
    organizationId,
    unpaid.map((i) => i.id),
  );
  const balanceOf = (invoice: { id: string; totalCents: number }) =>
    Math.max(
      0,
      invoice.totalCents -
        (paidByInvoice.get(invoice.id) ?? 0) -
        (creditedByInvoice.get(invoice.id) ?? 0),
    );
  const owedCents = unpaid.reduce((sum, i) => sum + balanceOf(i), 0);
  const lateCents = unpaid
    .filter((i) => i.dueDate && new Date(i.dueDate) < now)
    .reduce((sum, i) => sum + balanceOf(i), 0);

  /**
   * Paid is read from the payments, not from the invoice.
   *
   * A total kept in two places is a total that eventually disagrees with
   * itself, and this is the figure somebody reconciles against a bank
   * statement.
   */
  const [received] = await db
    .select({
      cents: sumCents(schema.payments.amountCents),
    })
    .from(schema.payments)
    .innerJoin(
      schema.invoices,
      eq(schema.invoices.id, schema.payments.invoiceId),
    )
    .where(
      and(
        eq(schema.invoices.organizationId, organizationId),
        gte(schema.payments.receivedAt, monthStart),
      ),
    );

  return [
    { label: "Owed to you", value: owedCents, kind: "money" },
    {
      label: "Past its date",
      value: lateCents,
      kind: "money",
      // The one figure here somebody is meant to do something about.
      tone: lateCents > 0 ? "bad" : "plain",
    },
    {
      label: "Paid this month",
      value: received?.cents ?? 0,
      kind: "money",
      tone: (received?.cents ?? 0) > 0 ? "good" : "plain",
    },
    { label: "Drafts unsent", value: row?.drafts ?? 0, kind: "count" },
  ];
}

export function registerInvoicingSummary(ctx: ModuleContext) {
  ctx.registerNav({
    id: "invoicing-dashboard",
    label: "Dashboard",
    // First in the module's own list, because it is what the module opens on.
    order: 18.9,
    group: "Money",
    icon: "gauge",
    requires: { invoicing: ["read"] },
  });

  ctx.app.get(
    "/api/invoicing/dashboard",
    requireSession(),
    requirePermission({ invoicing: ["read"] }),
    async (c) =>
      c.json(await invoicingDashboard(activeOrganizationId(c.get("session")))),
  );

  ctx.registerSummary({
    id: "invoicing",
    label: "Invoicing",
    icon: "receipt",
    opens: "invoicing",
    requires: { invoicing: ["read"] },
    load: invoicingFigures,
  });

  /**
   * What has to happen before an invoice can go out looking like a real one.
   *
   * Every step here is a thing somebody discovers by sending the first invoice
   * and finding it wrong — an address missing from a document a customer will
   * file, a tax number absent from a VAT invoice that therefore is not one.
   * Better on a list than in a reply from an accountant.
   *
   * Each asks the data rather than being ticked off, so a business that filled
   * its details in months ago sees them already done.
   */
  ctx.registerOnboarding({
    id: "invoicing",
    label: "Getting paid",
    icon: "receipt",
    requires: { invoicing: ["read"] },
    steps: [
      {
        id: "business-details",
        label: "Put your address and tax number in Settings",
        detail:
          "They appear on every invoice and quote you send. In the UK and the EU an invoice without them is not a valid one to file.",
        opens: "settings",
        done: async (orgId) => {
          const [org] = await db
            .select({
              address: schema.organizations.address,
              taxId: schema.organizations.taxId,
            })
            .from(schema.organizations)
            .where(eq(schema.organizations.id, orgId))
            .limit(1);
          return Boolean(org?.address?.trim());
        },
      },
      {
        id: "first-contact",
        label: "Add somebody to invoice",
        detail: "A customer, with an email address to send it to.",
        opens: "contacts",
        done: async (orgId) => {
          const [row] = await db
            .select({ id: schema.contacts.id })
            .from(schema.contacts)
            .where(eq(schema.contacts.organizationId, orgId))
            .limit(1);
          return Boolean(row);
        },
      },
      {
        id: "first-invoice",
        label: "Raise your first invoice",
        detail:
          "Issuing it posts to the ledger there and then, so the books are written as you work rather than afterwards.",
        opens: "invoicing",
        done: async (orgId) => {
          const [row] = await db
            .select({ id: schema.invoices.id })
            .from(schema.invoices)
            .where(eq(schema.invoices.organizationId, orgId))
            .limit(1);
          return Boolean(row);
        },
      },
    ],
  });
}

/**
 * Invoicing's own front page.
 *
 * More than the dashboard card: the same four figures, then the things
 * somebody actually does something with — what has been billed month by
 * month, who is late and by how long, and what is sitting in drafts. A module
 * dashboard that is only totals is a screen people look at once.
 */
export async function invoicingDashboard(organizationId: string) {
  const now = new Date();
  const since = new Date(now.getFullYear(), now.getMonth() - 5, 1);

  const [months, late, drafts] = await Promise.all([
    /**
     * Six months of what was billed and what came in.
     *
     * Billed is read from the invoices and received from the payments, on
     * purpose: they answer different questions, and a month where they differ
     * sharply is the month worth asking about.
     */
    db
      .select({
        month: sql<string>`to_char(${schema.invoices.issueDate}, 'YYYY-MM')`,
        billedCents: sumCents(schema.invoices.totalCents),
      })
      .from(schema.invoices)
      .where(
        and(
          eq(schema.invoices.organizationId, organizationId),
          isNull(schema.invoices.deletedAt),
          gte(schema.invoices.issueDate, since),
          sql`${schema.invoices.status} not in ('draft', 'void')`,
        ),
      )
      .groupBy(sql`to_char(${schema.invoices.issueDate}, 'YYYY-MM')`)
      .orderBy(sql`to_char(${schema.invoices.issueDate}, 'YYYY-MM')`),

    db
      .select({
        id: schema.invoices.id,
        number: schema.invoices.number,
        contactId: schema.invoices.contactId,
        totalCents: schema.invoices.totalCents,
        dueDate: schema.invoices.dueDate,
      })
      .from(schema.invoices)
      .where(
        and(
          eq(schema.invoices.organizationId, organizationId),
          isNull(schema.invoices.deletedAt),
          sql`${schema.invoices.status} in ('open', 'partial', 'overdue')`,
          sql`${schema.invoices.dueDate} is not null and ${schema.invoices.dueDate} < ${at(now)}`,
        ),
      )
      .orderBy(schema.invoices.dueDate)
      .limit(10),

    db
      .select({
        id: schema.invoices.id,
        number: schema.invoices.number,
        contactId: schema.invoices.contactId,
        totalCents: schema.invoices.totalCents,
        issueDate: schema.invoices.issueDate,
      })
      .from(schema.invoices)
      .where(
        and(
          eq(schema.invoices.organizationId, organizationId),
          isNull(schema.invoices.deletedAt),
          eq(schema.invoices.status, "draft"),
        ),
      )
      .orderBy(schema.invoices.issueDate)
      .limit(10),
  ]);

  const day = 24 * 60 * 60 * 1000;
  return {
    figures: await invoicingFigures(organizationId),
    months,
    late: late.map((row) => ({
      ...row,
      daysLate: row.dueDate
        ? Math.floor((now.getTime() - row.dueDate.getTime()) / day)
        : 0,
    })),
    drafts,
  };
}

/**
 * What invoicing can find.
 *
 * By number above all — "1042" is what somebody has in front of them on a bit
 * of paper — and by the customer's name, because the other half of the time
 * what they have is "that one for the Hendersons".
 */
export function registerInvoiceSearch(ctx: ModuleContext) {
  ctx.registerSearch({
    requires: { invoicing: ["read"] },
    find: async ({ organizationId, q, limit }) => {
      const term = `%${q.replace(/[\\%_]/g, (ch: string) => `\\${ch}`)}%`;

      const rows = await db
        .select({
          invoice: schema.invoices,
          contact: schema.contacts.name,
        })
        .from(schema.invoices)
        .leftJoin(
          schema.contacts,
          eq(schema.contacts.id, schema.invoices.contactId),
        )
        .where(
          and(
            eq(schema.invoices.organizationId, organizationId),
            or(
              ilike(schema.invoices.number, term),
              ilike(schema.contacts.name, term),
            ),
          ),
        )
        .limit(limit);

      return rows.map((row) => ({
        kind: "Invoice",
        title: row.invoice.number,
        subtitle: row.contact ?? row.invoice.status,
        opens: { moduleId: "invoicing", recordId: row.invoice.id },
        // Scored against the number, which is what somebody typing digits
        // means. A customer's name matching is a weaker signal and lands lower
        // than the contact itself.
        score: scoreFor(q, row.invoice.number),
      }));
    },
  });
}
