import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, at, db, eq, gte, isNull, schema, sql } from "@sentrello/db";
import type { ModuleContext, SummaryFigure } from "@sentrello/module-sdk";

/**
 * What Invoicing has to say on the dashboard, and on its own first screen.
 *
 * Four numbers, chosen because they are the ones a business owner asks about
 * money without being asked to: what is owed, what is late, what came in this
 * month, and what is sitting in drafts nobody has sent. The last is the one
 * nothing else surfaces — an invoice written and never issued is work already
 * done and money nobody has been asked for.
 *
 * One query. The dashboard draws several of these at once and a panel that
 * costs five round trips is a first screen that takes a second to appear.
 */
export async function invoicingFigures(
  organizationId: string,
): Promise<SummaryFigure[]> {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [row] = await db
    .select({
      // What has been issued and not settled. Drafts and voids owe nothing:
      // nobody has been asked for a draft.
      owedCents: sql<number>`coalesce(sum(
        case when ${schema.invoices.status} in ('open', 'partial', 'overdue')
          then ${schema.invoices.totalCents} else 0 end
      ), 0)::int`,
      lateCents: sql<number>`coalesce(sum(
        case when ${schema.invoices.status} in ('open', 'partial', 'overdue')
          and ${schema.invoices.dueDate} is not null
          and ${schema.invoices.dueDate} < ${at(now)}
          then ${schema.invoices.totalCents} else 0 end
      ), 0)::int`,
      billedCents: sql<number>`coalesce(sum(
        case when ${schema.invoices.status} <> 'draft'
          and ${schema.invoices.status} <> 'void'
          and ${schema.invoices.issueDate} >= ${at(monthStart)}
          then ${schema.invoices.totalCents} else 0 end
      ), 0)::int`,
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
   * Paid is read from the payments, not from the invoice.
   *
   * A total kept in two places is a total that eventually disagrees with
   * itself, and this is the figure somebody reconciles against a bank
   * statement.
   */
  const [received] = await db
    .select({
      cents: sql<number>`coalesce(sum(${schema.payments.amountCents}), 0)::int`,
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
    { label: "Owed to you", value: row?.owedCents ?? 0, kind: "money" },
    {
      label: "Past its date",
      value: row?.lateCents ?? 0,
      kind: "money",
      // The one figure here somebody is meant to do something about.
      tone: (row?.lateCents ?? 0) > 0 ? "bad" : "plain",
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
        billedCents: sql<number>`coalesce(sum(${schema.invoices.totalCents}), 0)::int`,
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
