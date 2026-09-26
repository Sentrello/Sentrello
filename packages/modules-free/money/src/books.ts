import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { ledgerTotals, totalsByAccount } from "@sentrello/db/ledger";
import type { ModuleContext } from "@sentrello/module-sdk";

/**
 * What the business earned and spent, for the front page of Money.
 *
 * Money opened on the invoicing dashboard: owed to you, past its date, paid
 * this month, drafts unsent. Every one of those is the sales side, so a
 * module called Money answered half of one question — a business that had
 * spent more than it billed could read its own front page and not know.
 *
 * Read from the journal, like every other figure in the books, so the number
 * here and the number on the Summary screen are the same number. A dashboard
 * that computes its own version of a report is a dashboard somebody stops
 * trusting the first time the two disagree.
 *
 * **Accrual, because the Summary screen is accrual.** The cash basis is a
 * choice a business makes for a return it files, offered on the screen where
 * it files it; making the dashboard silently the other basis would put two
 * different answers to "what did we earn in September" one click apart. The
 * words say so: Income and Expenses, exactly as the Summary names them.
 */
export interface BooksMonth {
  /** `YYYY-MM`, so a browser can format it in the reader's own calendar. */
  month: string;
  incomeCents: number;
  expenseCents: number;
}

const total = (accounts: { balanceCents: number }[]) =>
  accounts.reduce((sum, account) => sum + account.balanceCents, 0);

/**
 * Six months of it, oldest first, with the quiet ones present.
 *
 * `to` is the first instant of the following month rather than the last day
 * of this one: a period that ends "2026-09-30" drops everything posted on the
 * 30th, which is the day a month's work is most likely to be posted on.
 *
 * **UTC, because the platform dashboard's twelve-month series is UTC.** Two
 * screens one click apart, both reading the journal, both naming a month —
 * and a server an hour west of Greenwich would have put an entry posted late
 * on the 31st into different months on each of them. `money-books-agree`
 * holds the two together.
 */
export async function booksByMonth(
  organizationId: string,
  now = new Date(),
): Promise<BooksMonth[]> {
  const windows = Array.from({ length: 6 }, (_, i) => {
    const from = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (5 - i), 1),
    );
    const to = new Date(
      Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1),
    );
    return {
      month: `${from.getUTCFullYear()}-${String(from.getUTCMonth() + 1).padStart(2, "0")}`,
      from,
      to,
    };
  });

  const totals = await Promise.all(
    windows.map((w) =>
      ledgerTotals(organizationId, { from: w.from, to: w.to }),
    ),
  );

  return windows.map((w, i) => {
    const rows = totals[i] ?? [];
    return {
      month: w.month,
      incomeCents: total(totalsByAccount(rows, "income")),
      expenseCents: total(totalsByAccount(rows, "expense")),
    };
  });
}

export function registerBooksSummary(ctx: ModuleContext) {
  /*
   * Its own permission, and not the one the module's head carries.
   *
   * Money is readable by anybody who can read either half — a person who
   * raises invoices and never sees the books is an ordinary arrangement in a
   * small business. So the front page asks for this separately and draws the
   * half it is allowed; the route refuses the rest rather than the screen
   * deciding, which is the rule everywhere here.
   */
  ctx.app.get(
    "/api/money/books",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    async (c) => {
      const months = await booksByMonth(activeOrganizationId(c.get("session")));
      const month = months[months.length - 1];
      return c.json({
        months,
        month: {
          incomeCents: month?.incomeCents ?? 0,
          expenseCents: month?.expenseCents ?? 0,
          netCents: (month?.incomeCents ?? 0) - (month?.expenseCents ?? 0),
        },
      });
    },
  );
}
