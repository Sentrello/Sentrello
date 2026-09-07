import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, gte, lte, schema } from "@sentrello/db";
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

export interface LedgerRow {
  /** Which entry the line belongs to — the unit a cash-basis read reasons in. */
  entryId: string;
  /** Which part of the business the line was for, if any. */
  classId: string | null;
  locationId: string | null;
  accountId: string;
  code: string;
  name: string;
  type: string;
  debitCents: number;
  creditCents: number;
  postedAt: Date;
}

/**
 * Every posted line for a business, optionally inside a period.
 *
 * A class or a location narrows it to one part of the business. Narrowing here
 * rather than in each report means every report gains it at once — and means a
 * report cannot quietly ignore the filter it was given, which is a page headed
 * "Kitchen job" showing the whole company's figures.
 */
export async function ledgerRows(
  orgId: string,
  period: {
    from?: Date;
    to?: Date;
    classId?: string;
    locationId?: string;
  } = {},
): Promise<LedgerRow[]> {
  return db
    .select({
      entryId: schema.journalEntries.id,
      classId: schema.journalLines.classId,
      locationId: schema.journalLines.locationId,
      accountId: schema.accounts.id,
      code: schema.accounts.code,
      name: schema.accounts.name,
      type: schema.accounts.type,
      debitCents: schema.journalLines.debitCents,
      creditCents: schema.journalLines.creditCents,
      postedAt: schema.journalEntries.postedAt,
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
        eq(schema.journalEntries.organizationId, orgId),
        // Both sides are scoped: a line joined to an account belonging to
        // another business would be somebody else's figure in these totals.
        eq(schema.accounts.organizationId, orgId),
        ...(period.from
          ? [gte(schema.journalEntries.postedAt, period.from)]
          : []),
        ...(period.to ? [lte(schema.journalEntries.postedAt, period.to)] : []),
        ...(period.classId
          ? [eq(schema.journalLines.classId, period.classId)]
          : []),
        ...(period.locationId
          ? [eq(schema.journalLines.locationId, period.locationId)]
          : []),
      ),
    );
}

/** Which side of the ledger an account type grows on. */
const DEBIT_POSITIVE = new Set(["asset", "expense"]);

export interface AccountTotal {
  accountId: string;
  code: string;
  name: string;
  balanceCents: number;
}

/**
 * Per-account totals for one type, in the direction that type is read.
 *
 * An expense account with £100 of debits reads as £100 spent, not as -£100;
 * an income account with £100 of credits reads as £100 earned. Getting this
 * backwards is how a profitable business appears to be losing money.
 */
export function totalsByAccount(
  rows: LedgerRow[],
  type: string,
): AccountTotal[] {
  const totals = new Map<string, AccountTotal>();
  for (const row of rows) {
    if (row.type !== type) continue;
    const amount = DEBIT_POSITIVE.has(type)
      ? row.debitCents - row.creditCents
      : row.creditCents - row.debitCents;
    const found = totals.get(row.accountId);
    if (found) {
      found.balanceCents += amount;
    } else {
      totals.set(row.accountId, {
        accountId: row.accountId,
        code: row.code,
        name: row.name,
        balanceCents: amount,
      });
    }
  }
  return [...totals.values()].sort((a, b) => a.code.localeCompare(b.code));
}

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

export function profitAndLoss(rows: LedgerRow[]) {
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
export function balanceSheet(rows: LedgerRow[]) {
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

/**
 * A date from the query string, or nothing if it is unreadable.
 *
 * A day given without a time is the *whole* day at the end of a period. "To
 * 23 August" written by somebody means everything up to the end of the 23rd,
 * and reading it as midnight is how a report run this afternoon showed none of
 * this morning's takings — which reads as a broken report, not a boundary.
 */
export function periodFrom(query: (name: string) => string | undefined): {
  from?: Date;
  to?: Date;
  classId?: string;
  locationId?: string;
} {
  const parse = (value: string | undefined, endOfDay = false) => {
    if (!value) return undefined;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return undefined;
    // Only a bare date is stretched. A caller who sent a time meant that time.
    if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
      return new Date(date.getTime() + 24 * 60 * 60 * 1000 - 1);
    }
    return date;
  };
  /**
   * The dimension filters travel with the period.
   *
   * Every caller of this already passes what it returns straight to
   * `ledgerRows`, so a report gains "just this job" without being edited — and
   * cannot be edited into ignoring it.
   */
  const classId = query("classId");
  const locationId = query("locationId");
  return {
    from: parse(query("from")),
    to: parse(query("to"), true),
    ...(classId ? { classId } : {}),
    ...(locationId ? { locationId } : {}),
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
          ...profitAndLoss(await ledgerRows(orgId, period)),
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
        ...balanceSheet(await ledgerRows(orgId, { to })),
      });
    },
  );
}
