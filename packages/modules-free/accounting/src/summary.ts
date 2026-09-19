import { and, at, db, eq, schema, sql } from "@sentrello/db";
import type { ModuleContext, SummaryFigure } from "@sentrello/module-sdk";

/**
 * The books on the dashboard.
 *
 * Invoicing's panel is what the business is owed; this one is what actually
 * moved. They are different questions — a month of invoices sent and none
 * paid looks healthy on one panel and empty on this one, which is the
 * difference somebody needs to see on the same screen.
 *
 * The third figure is the one that asks for something: money recorded
 * against no account at all. It is not a mistake anybody notices, because
 * every screen still adds up — the figures are simply in the wrong places,
 * and the profit and loss quietly stops being true.
 */
export async function accountingFigures(
  organizationId: string,
): Promise<SummaryFigure[]> {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [row] = await db
    .select({
      // `at()`, because this is a raw template: Drizzle binds a Date
      // correctly only where it can see the column.
      taken:
        sql<number>`coalesce(sum(${schema.transactions.amountCents}) filter (
        where ${schema.transactions.kind} = 'income'
          and ${schema.transactions.occurredAt} >= ${at(monthStart)}
      ), 0)::bigint`.mapWith(Number),
      spent:
        sql<number>`coalesce(sum(${schema.transactions.amountCents}) filter (
        where ${schema.transactions.kind} = 'expense'
          and ${schema.transactions.occurredAt} >= ${at(monthStart)}
      ), 0)::bigint`.mapWith(Number),
      unfiled: sql<number>`count(*) filter (
        where ${schema.transactions.accountId} is null
      )::int`,
    })
    .from(schema.transactions)
    .where(eq(schema.transactions.organizationId, organizationId));

  return [
    { label: "Taken this month", value: row?.taken ?? 0, kind: "money" },
    { label: "Spent this month", value: row?.spent ?? 0, kind: "money" },
    {
      label: "Without a category",
      value: row?.unfiled ?? 0,
      kind: "count",
      tone: (row?.unfiled ?? 0) > 0 ? "bad" : "plain",
    },
  ];
}

export function registerAccountingSummary(ctx: ModuleContext): void {
  ctx.registerSummary({
    id: "accounting",
    label: "The books",
    icon: "book-open",
    opens: "accounting-summary",
    requires: { bookkeeping: ["read"] },
    load: accountingFigures,
  });
}
