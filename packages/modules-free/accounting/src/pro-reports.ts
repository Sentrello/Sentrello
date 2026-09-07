import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, inArray, isNull, schema } from "@sentrello/db";
import { invoiceStatus } from "@sentrello/db/money";
import type { RouteContext, SentrelloEnv } from "@sentrello/module-sdk";
import type { ModuleContext } from "@sentrello/module-sdk";
import type { MiddlewareHandler } from "hono";
import {
  type LedgerRow,
  ledgerRows,
  periodFrom,
  totalsByAccount,
} from "./reports";

/**
 * The rest of the report set — the half a licence pays for.
 *
 * Free answers "did we make money" and "what are we worth". These answer the
 * questions that come after: where the cash actually went, what tax is owed,
 * who owes us and how late they are, and whether the books themselves add up.
 *
 * All of them read the journal. None of them recompute anything from invoices
 * or bills, so they cannot disagree with the two statements in Free.
 */

/** Which codes are cash: the accounts money actually sits in. */
const CASH_CODES = new Set(["1000", "1010"]);

/**
 * What came in and went out through the cash and bank accounts.
 *
 * Read from the movements on those accounts rather than derived from profit,
 * because the difference between the two is the whole point of the report: a
 * profitable month with every invoice unpaid has no cash in it.
 */
export function cashFlow(rows: LedgerRow[]) {
  let inCents = 0;
  let outCents = 0;
  for (const row of rows) {
    if (!CASH_CODES.has(row.code) && !row.name.toLowerCase().includes("bank")) {
      continue;
    }
    inCents += row.debitCents;
    outCents += row.creditCents;
  }
  return { inCents, outCents, netCents: inCents - outCents };
}

/**
 * What is owed to the tax authority, and what has been paid over.
 *
 * The tax account carries both: charged on sales as a credit, reclaimed on
 * purchases and paid over as a debit. The balance is what would be due if the
 * period closed today.
 */
export function taxSummary(rows: LedgerRow[]) {
  const tax = rows.filter(
    (row) => row.type === "liability" && row.code === "2200",
  );
  const chargedCents = tax.reduce((sum, row) => sum + row.creditCents, 0);
  const reclaimedCents = tax.reduce((sum, row) => sum + row.debitCents, 0);
  return {
    chargedCents,
    reclaimedCents,
    dueCents: chargedCents - reclaimedCents,
  };
}

/**
 * Every account with its debits and its credits, and whether they agree.
 *
 * The oldest check in bookkeeping and still the useful one: a trial balance
 * that does not balance means something reached the ledger unbalanced, which
 * `postJournalEntry` should have made impossible. Running it is how you find
 * out that it did not.
 */
export function trialBalance(rows: LedgerRow[]) {
  const byAccount = new Map<
    string,
    {
      code: string;
      name: string;
      type: string;
      debitCents: number;
      creditCents: number;
    }
  >();
  for (const row of rows) {
    const found = byAccount.get(row.accountId);
    if (found) {
      found.debitCents += row.debitCents;
      found.creditCents += row.creditCents;
    } else {
      byAccount.set(row.accountId, {
        code: row.code,
        name: row.name,
        type: row.type,
        debitCents: row.debitCents,
        creditCents: row.creditCents,
      });
    }
  }
  const accounts = [...byAccount.values()]
    .sort((a, b) => a.code.localeCompare(b.code))
    // `netCents` is what the Pro reports screen reads, and that bundle is
    // already on every Pro instance's disk.
    .map((account) => ({
      ...account,
      netCents: account.debitCents - account.creditCents,
    }));
  const debitCents = accounts.reduce((sum, a) => sum + a.debitCents, 0);
  const creditCents = accounts.reduce((sum, a) => sum + a.creditCents, 0);
  return {
    accounts,
    rows: accounts,
    debitCents,
    creditCents,
    netCents: debitCents - creditCents,
    balanced: debitCents === creditCents,
  };
}

/** How old a debt is, in the buckets every accountant reads. */
export function ageBucket(
  ageDays: number,
): "current" | "days30" | "days60" | "days90plus" {
  if (ageDays <= 0) return "current";
  if (ageDays <= 30) return "days30";
  if (ageDays <= 60) return "days60";
  return "days90plus";
}

/** A comma-separated file, quoted the way a spreadsheet expects. */
export function toCsv(rows: (string | number | null)[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const value = cell === null ? "" : String(cell);
          return /[",\n]/.test(value)
            ? `"${value.replaceAll('"', '""')}"`
            : value;
        })
        .join(","),
    )
    .join("\n");
}

export function registerProReports(
  ctx: ModuleContext,
  proOnly: MiddlewareHandler<SentrelloEnv>,
) {
  const period = (c: RouteContext) => periodFrom((name) => c.req.query(name));

  ctx.app.get(
    "/api/reports/cash-flow",
    requireSession(),
    requirePermission({ reports: ["read"] }),
    proOnly,
    async (c: RouteContext) =>
      c.json(
        cashFlow(
          await ledgerRows(activeOrganizationId(c.get("session")), period(c)),
        ),
      ),
  );

  ctx.app.get(
    "/api/reports/tax-summary",
    requireSession(),
    requirePermission({ reports: ["read"] }),
    proOnly,
    async (c: RouteContext) =>
      c.json(
        taxSummary(
          await ledgerRows(activeOrganizationId(c.get("session")), period(c)),
        ),
      ),
  );

  ctx.app.get(
    "/api/reports/trial-balance",
    requireSession(),
    requirePermission({ reports: ["read"] }),
    proOnly,
    async (c: RouteContext) =>
      c.json(
        trialBalance(
          await ledgerRows(activeOrganizationId(c.get("session")), period(c)),
        ),
      ),
  );

  /**
   * Income and expenses by category, which is the report a business actually
   * plans from — "what do we spend on software" is not answerable from a total.
   */
  ctx.app.get(
    "/api/reports/by-category",
    requireSession(),
    requirePermission({ reports: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const rows = await ledgerRows(
        activeOrganizationId(c.get("session")),
        period(c),
      );
      return c.json({
        income: totalsByAccount(rows, "income"),
        expenses: totalsByAccount(rows, "expense"),
      });
    },
  );

  /** Who owes this business, and how long they have owed it. */
  ctx.app.get(
    "/api/reports/accounts-receivable",
    requireSession(),
    requirePermission({ reports: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const [invoices, payments, contacts] = await Promise.all([
        db
          .select()
          .from(schema.invoices)
          .where(
            and(
              eq(schema.invoices.organizationId, orgId),
              isNull(schema.invoices.deletedAt),
              inArray(schema.invoices.status, ["open", "partial"]),
            ),
          ),
        db
          .select()
          .from(schema.payments)
          .where(eq(schema.payments.organizationId, orgId)),
        db
          .select({ id: schema.contacts.id, name: schema.contacts.name })
          .from(schema.contacts)
          .where(eq(schema.contacts.organizationId, orgId)),
      ]);

      // "Who owes me" is the question this answers, so it carries the name. An
      // invoice number tells a business nothing on its own.
      const nameFor = (id: string | null) =>
        contacts.find((contact) => contact.id === id)?.name ?? null;

      const now = Date.now();
      const aging = { current: 0, days30: 0, days60: 0, days90plus: 0 };
      const rows = invoices.map((invoice) => {
        const paidCents = payments
          .filter((p) => p.invoiceId === invoice.id)
          .reduce((sum, p) => sum + p.amountCents, 0);
        const { balanceDue } = invoiceStatus(invoice.totalCents, paidCents);
        const ageDays = invoice.dueDate
          ? Math.floor((now - invoice.dueDate.getTime()) / 86_400_000)
          : 0;
        aging[ageBucket(ageDays)] += balanceDue;
        return {
          invoiceId: invoice.id,
          number: invoice.number,
          customerName: nameFor(invoice.contactId),
          currency: invoice.currency,
          dueDate: invoice.dueDate,
          balanceDue,
          ageDays,
        };
      });

      return c.json({
        // Oldest first: the money most at risk is the money to chase today.
        invoices: [...rows].sort((a, b) => b.ageDays - a.ageDays),
        aging,
        totalCents: rows.reduce((sum, row) => sum + row.balanceDue, 0),
      });
    },
  );

  /** What this business owes, and how long it has owed it. */
  ctx.app.get(
    "/api/reports/accounts-payable",
    requireSession(),
    requirePermission({ reports: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const [bills, payments, contacts] = await Promise.all([
        db
          .select()
          .from(schema.bills)
          .where(
            and(
              eq(schema.bills.organizationId, orgId),
              isNull(schema.bills.deletedAt),
              inArray(schema.bills.status, ["open", "partial"]),
            ),
          ),
        db
          .select()
          .from(schema.billPayments)
          .where(eq(schema.billPayments.organizationId, orgId)),
        db
          .select({ id: schema.contacts.id, name: schema.contacts.name })
          .from(schema.contacts)
          .where(eq(schema.contacts.organizationId, orgId)),
      ]);

      const now = Date.now();
      const aging = { current: 0, days30: 0, days60: 0, days90plus: 0 };
      const rows = bills.map((bill) => {
        const paidCents = payments
          .filter((p) => p.billId === bill.id)
          .reduce((sum, p) => sum + p.amountCents, 0);
        const { balanceDue } = invoiceStatus(bill.totalCents, paidCents);
        const ageDays = bill.dueDate
          ? Math.floor((now - bill.dueDate.getTime()) / 86_400_000)
          : 0;
        aging[ageBucket(ageDays)] += balanceDue;
        return {
          billId: bill.id,
          number: bill.number,
          vendorName:
            contacts.find((contact) => contact.id === bill.vendorId)?.name ??
            null,
          currency: bill.currency,
          dueDate: bill.dueDate,
          balanceDue,
          ageDays,
        };
      });

      return c.json({
        bills: [...rows].sort((a, b) => b.ageDays - a.ageDays),
        aging,
        totalCents: rows.reduce((sum, row) => sum + row.balanceDue, 0),
      });
    },
  );

  /**
   * The whole ledger as a file, because at some point an accountant asks for
   * it and the answer cannot be "log in to our thing".
   */
  ctx.app.get(
    "/api/reports/export.csv",
    requireSession(),
    requirePermission({ reports: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const rows = await ledgerRows(
        activeOrganizationId(c.get("session")),
        period(c),
      );
      const csv = toCsv([
        [
          "posted_at",
          "account_code",
          "account_name",
          "type",
          "debit_cents",
          "credit_cents",
        ],
        ...rows
          .sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime())
          .map((row) => [
            row.postedAt.toISOString(),
            row.code,
            row.name,
            row.type,
            row.debitCents,
            row.creditCents,
          ]),
      ]);
      return new Response(csv, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="sentrello-ledger.csv"',
        },
      });
    },
  );
}
