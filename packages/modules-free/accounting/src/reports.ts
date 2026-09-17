import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import {
  type AccountTotal,
  type LedgerAmounts,
  type LedgerRow,
  ledgerRows,
  ledgerTotals,
  periodFrom,
  totalsByAccount,
} from "@sentrello/db/ledger";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";
import { type CashBasisRow, cashBasisRows } from "./cash-basis";

/**
 * The two statements every business is asked for.
 *
 * A profit and loss says what a period earned; a balance sheet says what the
 * business is worth on a day. Both are read from the journal and nowhere else —
 * not from invoices, not from the transactions table — because the journal is
 * the only place every financial event lands. A report built from the document
 * tables answers a slightly different question every time a module is added.
 *
 * The rest of the report set — cash flow, tax, aged debt, by category — is the
 * Pro half. What is here is what a business genuinely cannot do without.
 */

/**
 * The row reader, the per-account totals and the query-string period parser
 * live in `@sentrello/db/ledger` now, beside `postJournalEntry`: they are
 * pure readers over tables `db` owns, and the paid half reads them from
 * there too. Re-exported so every caller here keeps working.
 */
export {
  type AccountTotal,
  type LedgerAmounts,
  type LedgerRow,
  ledgerRows,
  ledgerTotals,
  periodFrom,
  totalsByAccount,
};

const sum = (accounts: AccountTotal[]) =>
  accounts.reduce((total, account) => total + account.balanceCents, 0);

/**
 * A cash-basis read of the same accounts, in the shape the accrual one has.
 *
 * The rows arriving here are already in the direction each type is read, so
 * this only groups them — the arithmetic that made them is in `cash-basis.ts`
 * and is the whole of the difference between the two bases.
 */
export function totalsOfCashRows(
  rows: CashBasisRow[],
  type: string,
): AccountTotal[] {
  const totals = new Map<string, AccountTotal>();
  for (const row of rows) {
    if (row.type !== type) continue;
    const found = totals.get(row.accountId);
    if (found) {
      found.balanceCents += row.amountCents;
    } else {
      totals.set(row.accountId, {
        accountId: row.accountId,
        code: row.code,
        name: row.name,
        balanceCents: row.amountCents,
      });
    }
  }
  return [...totals.values()].sort((a, b) => a.code.localeCompare(b.code));
}

export function profitAndLoss(rows: LedgerAmounts[]) {
  const income = totalsByAccount(rows, "income");
  const expenses = totalsByAccount(rows, "expense");
  const incomeCents = sum(income);
  const expenseCents = sum(expenses);
  return {
    income,
    expenses,
    incomeCents,
    expenseCents,
    netCents: incomeCents - expenseCents,
  };
}

/**
 * What the business owns, owes and is worth on a day.
 *
 * The earnings line is the part people expect to be a stored number and is
 * not. It is the profit of everything still open — every period since the last
 * year end, or all of them on a business that has never closed one — worked out
 * rather than stored, so it cannot drift from the journal.
 *
 * Closing a year empties those accounts into equity, which is why this keeps
 * working afterwards rather than double-counting: what was swept is in
 * `equity` and what is left is this year's.
 *
 * `balanced` is not decoration. Assets minus liabilities minus equity minus
 * earnings is zero for any set of balanced entries, so anything else means
 * something reached the ledger that should not have, and the statement should
 * say so rather than be quietly wrong.
 */
export function balanceSheet(rows: LedgerAmounts[]) {
  const assets = totalsByAccount(rows, "asset");
  const liabilities = totalsByAccount(rows, "liability");
  const equity = totalsByAccount(rows, "equity");
  const assetsCents = sum(assets);
  const liabilitiesCents = sum(liabilities);
  const equityCents = sum(equity);
  const earningsCents =
    sum(totalsByAccount(rows, "income")) -
    sum(totalsByAccount(rows, "expense"));

  const outByCents =
    assetsCents - liabilitiesCents - equityCents - earningsCents;

  return {
    assets,
    liabilities,
    equity,
    assetsCents,
    liabilitiesCents,
    equityCents,
    earningsCents,
    balanced: outByCents === 0,
    /**
     * The same two figures under the names the Pro reports screen reads.
     *
     * That screen shipped before this module existed and is a built bundle on
     * every Pro instance's disk, so renaming a field it reads would blank a
     * customer's balance sheet on the day they updated.
     */
    retainedEarningsCents: earningsCents,
    balancedCents: outByCents,
  };
}

export function registerReports(ctx: ModuleContext) {
  /**
   * Profit and loss for a period, or for everything if none is given.
   *
   * The totals keep the names they have always had — the dashboard and the
   * demo both read `incomeCents` — and the per-account breakdown is added
   * beside them rather than replacing them.
   */
  ctx.app.get(
    "/api/reports/profit-and-loss",
    requireSession(),
    requirePermission({ reports: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const period = periodFrom((name) => c.req.query(name));

      /**
       * Accrual unless somebody asks for cash, which is the safe default.
       *
       * Accrual is the honest answer to "how is the business doing", it is
       * what every existing caller — the dashboard, the demo, the Pro reports
       * screen — already reads, and it is what a business must produce if it
       * is above the threshold to file on the cash basis at all.
       */
      if (c.req.query("basis") !== "cash") {
        return c.json({
          basis: "accrual",
          ...profitAndLoss(await ledgerTotals(orgId, period)),
        });
      }

      /**
       * The whole history, not the period.
       *
       * Money received in June for work invoiced in March is June's income on
       * this basis, and June's entries alone cannot say so. The period is
       * applied to what is recognised rather than to what is read.
       */
      const rows = cashBasisRows(await ledgerRows(orgId), period);
      const income = totalsOfCashRows(rows, "income");
      const expenses = totalsOfCashRows(rows, "expense");
      const incomeCents = sum(income);
      const expenseCents = sum(expenses);
      return c.json({
        basis: "cash",
        income,
        expenses,
        incomeCents,
        expenseCents,
        netCents: incomeCents - expenseCents,
      });
    },
  );

  ctx.app.get(
    "/api/reports/balance-sheet",
    requireSession(),
    requirePermission({ reports: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      /**
       * A balance sheet is as at a date, not for a period: it is a photograph
       * of everything that has ever been posted up to that moment.
       */
      const to = periodFrom((name) =>
        name === "to" ? c.req.query("asOf") : undefined,
      ).to;
      return c.json({
        asOf: to ?? new Date(),
        ...balanceSheet(await ledgerTotals(orgId, { to })),
      });
    },
  );
}
