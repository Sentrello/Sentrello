import { db, eq, schema, sql } from "@sentrello/db";
import { ledgerTotals, totalsByAccount } from "@sentrello/db/ledger";
import type { ModuleContext, SummaryFigure } from "@sentrello/module-sdk";

/**
 * The books on the dashboard.
 *
 * Invoicing's panel is what the business is owed; this one is what the books
 * say it earned and spent. They are different questions, and seeing both on
 * one screen is the point.
 *
 * **It used to read the transactions table**, which is the register behind
 * "Money in and out" — one of several things that feed the books and not the
 * books themselves. Income raised as an invoice posts to the journal and
 * never touches that table, so a business that bills for everything it does
 * saw "Taken this month: $0.00" in a month it had been paid. The panel was
 * called The books and was the one screen in the product not reading them.
 *
 * The journal now, in the same words the Summary screen and Money's front
 * page use, so three screens carrying one figure carry one figure. UTC
 * month, for the reason written up beside the other two: a local month puts
 * an entry posted just after midnight on the 1st in a different month
 * depending on where the server is.
 *
 * The third figure is the one that asks for something, and it stays with the
 * register because that is where it happens: money recorded against no
 * account at all. Nobody notices, because every screen still adds up — the
 * figures are simply in the wrong places, and the profit and loss quietly
 * stops being true.
 */
const total = (accounts: { balanceCents: number }[]) =>
  accounts.reduce((sum, account) => sum + account.balanceCents, 0);

export async function accountingFigures(
  organizationId: string,
): Promise<SummaryFigure[]> {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const [rows, [row]] = await Promise.all([
    ledgerTotals(organizationId, { from, to }),
    db
      .select({
        unfiled: sql<number>`count(*) filter (
        where ${schema.transactions.accountId} is null
      )::int`,
      })
      .from(schema.transactions)
      .where(eq(schema.transactions.organizationId, organizationId)),
  ]);

  return [
    {
      label: "Income this month",
      value: total(totalsByAccount(rows, "income")),
      kind: "money",
    },
    {
      label: "Expenses this month",
      value: total(totalsByAccount(rows, "expense")),
      kind: "money",
    },
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
