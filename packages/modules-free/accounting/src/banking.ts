import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, desc, eq, inArray, isNull, schema } from "@sentrello/db";
import {
  CORE_ACCOUNTS,
  ensureAccount,
  postJournalEntry,
} from "@sentrello/db/ledger";
import { invoiceStatus } from "@sentrello/db/money";
import type {
  ModuleContext,
  RouteContext,
  SentrelloEnv,
} from "@sentrello/module-sdk";
import type { MiddlewareHandler } from "hono";
import { isUuid, ownedAccount } from "./chart";
import { columnIndex, parseAmountToCents, parseCsv } from "./csv";

/**
 * Bank accounts, transfers, and making the statement agree with the books.
 *
 * A bank account here is an asset account with a statement behind it, not a
 * table of its own: in double-entry the account already exists, and a second
 * row describing the same thing is a second row to keep in step.
 *
 * Nothing reconciles itself. Every suggestion is a suggestion, confirmed by a
 * person, because a wrong automatic match is a wrong ledger — and a wrong
 * ledger found six months later costs more than the typing it saved.
 */

/** A statement row paired with what it might be. */
export interface Suggestion {
  bankTransactionId: string;
  amountCents: number;
  date: Date;
  candidates: {
    kind: "invoice" | "bill";
    id: string;
    number: string | null;
    balanceDue: number;
  }[];
}

/**
 * Which open documents a statement row could be settling.
 *
 * Matched on the amount exactly, then ordered by how close the dates are:
 * two customers paying £250 in the same month is ordinary, and the one whose
 * invoice is nearest the payment is the likelier of the two. Never more than
 * three, because a list of eleven equally good guesses is not a suggestion.
 */
export function suggestMatches(
  bankRows: {
    id: string;
    amountCents: number;
    date: Date;
    matchedEntryId: string | null;
  }[],
  open: {
    kind: "invoice" | "bill";
    id: string;
    number: string | null;
    balanceDue: number;
    date: Date;
  }[],
): Suggestion[] {
  return bankRows
    .filter((row) => !row.matchedEntryId && row.amountCents !== 0)
    .map((row) => {
      // Money in settles an invoice; money out settles a bill.
      const wanted = row.amountCents > 0 ? "invoice" : "bill";
      const amount = Math.abs(row.amountCents);
      const candidates = open
        .filter((doc) => doc.kind === wanted && doc.balanceDue === amount)
        .sort(
          (a, b) =>
            Math.abs(a.date.getTime() - row.date.getTime()) -
            Math.abs(b.date.getTime() - row.date.getTime()),
        )
        .slice(0, 3)
        .map(({ kind, id, number, balanceDue }) => ({
          kind,
          id,
          number,
          balanceDue,
        }));
      return {
        bankTransactionId: row.id,
        amountCents: row.amountCents,
        date: row.date,
        candidates,
      };
    })
    .filter((suggestion) => suggestion.candidates.length > 0);
}

export function registerBanking(
  ctx: ModuleContext,
  proOnly: MiddlewareHandler<SentrelloEnv>,
) {
  ctx.app.get(
    "/api/bank-accounts",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const rows = await db
        .select()
        .from(schema.accounts)
        .where(
          and(
            eq(schema.accounts.organizationId, orgId),
            eq(schema.accounts.isBank, true),
            isNull(schema.accounts.archivedAt),
          ),
        )
        .orderBy(schema.accounts.code);
      return c.json({ bankAccounts: rows });
    },
  );

  /**
   * Adding a bank account, or telling an account it is one.
   *
   * Only the last four digits of the number are kept. Enough to recognise the
   * account on a screen, useless to anybody who reads the database.
   */
  ctx.app.post(
    "/api/bank-accounts",
    requireSession(),
    requirePermission({ bookkeeping: ["create"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = await c.req.json();
      const last4 = String(body.accountNumber ?? "")
        .replace(/\D/g, "")
        .slice(-4);

      if (body.accountId) {
        if (!(await ownedAccount(orgId, String(body.accountId)))) {
          return c.json({ error: "not found" }, 404);
        }
        const [row] = await db
          .update(schema.accounts)
          .set({
            isBank: true,
            bankName: body.bankName ?? null,
            ...(last4 ? { bankAccountLast4: last4 } : {}),
          })
          .where(
            and(
              eq(schema.accounts.id, String(body.accountId)),
              eq(schema.accounts.organizationId, orgId),
            ),
          )
          .returning();
        return c.json({ bankAccount: row });
      }

      const code = String(body.code ?? "").trim();
      const name = String(body.name ?? "").trim();
      if (!code || !name) return c.json({ error: "code and name" }, 400);
      const [clash] = await db
        .select({ id: schema.accounts.id })
        .from(schema.accounts)
        .where(
          and(
            eq(schema.accounts.organizationId, orgId),
            eq(schema.accounts.code, code),
          ),
        )
        .limit(1);
      if (clash)
        return c.json({ error: `account ${code} already exists` }, 409);

      const [row] = await db
        .insert(schema.accounts)
        .values({
          organizationId: orgId,
          code,
          name,
          // A bank account is money the business has: an asset, always.
          type: "asset",
          isBank: true,
          bankName: body.bankName ?? null,
          bankAccountLast4: last4 || null,
        })
        .returning();
      return c.json({ bankAccount: row }, 201);
    },
  );

  /**
   * Moving money between two of the business's own accounts.
   *
   * Not income and not an expense — nothing was earned or spent, so a transfer
   * that posted as either would inflate both sides of the profit and loss. It
   * is one balanced entry between two assets, and it is recorded as a
   * transaction of its own kind so the screen can show it for what it is.
   */
  ctx.app.post(
    "/api/transfers",
    requireSession(),
    requirePermission({ bookkeeping: ["create"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = await c.req.json();
      const fromAccountId = String(body.fromAccountId ?? "");
      const toAccountId = String(body.toAccountId ?? "");

      if (!Number.isInteger(body.amountCents) || body.amountCents <= 0) {
        return c.json(
          { error: "amountCents must be a positive whole number of cents" },
          400,
        );
      }
      if (fromAccountId === toAccountId) {
        return c.json({ error: "a transfer needs two accounts" }, 400);
      }
      if (
        !(await ownedAccount(orgId, fromAccountId)) ||
        !(await ownedAccount(orgId, toAccountId))
      ) {
        return c.json({ error: "unknown account" }, 400);
      }

      const occurredAt = body.occurredAt
        ? new Date(body.occurredAt)
        : new Date();
      if (Number.isNaN(occurredAt.getTime())) {
        return c.json({ error: "unreadable date" }, 400);
      }

      const [row] = await db
        .insert(schema.transactions)
        .values({
          organizationId: orgId,
          kind: "transfer",
          accountId: toAccountId,
          paidThroughAccountId: fromAccountId,
          amountCents: body.amountCents,
          occurredAt,
          description: body.description ?? "Transfer",
          reference: body.reference ?? null,
        })
        .returning();
      if (!row) throw new Error("transfer insert returned no row");

      await postJournalEntry(
        orgId,
        row.description ?? "Transfer",
        `transfer:${row.id}`,
        [
          { accountId: toAccountId, debitCents: row.amountCents },
          { accountId: fromAccountId, creditCents: row.amountCents },
        ],
        occurredAt,
      );
      return c.json({ transfer: row }, 201);
    },
  );

  /**
   * A statement, as the bank exported it.
   *
   * Rows whose amount cannot be read are reported back rather than imported as
   * zero: a wrong number in a reconciliation is worse than a rejected file,
   * because the file gets fixed and the number does not.
   */
  ctx.app.post(
    "/api/bank-imports",
    requireSession(),
    requirePermission({ bookkeeping: ["create"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const filename = c.req.query("filename") ?? "import.csv";
      const rows = parseCsv(await c.req.text());
      const header = rows.shift();
      if (!header) return c.json({ error: "empty file" }, 400);

      const dateIdx = columnIndex(header, "date", "transaction date", "posted");
      const descIdx = columnIndex(
        header,
        "description",
        "details",
        "memo",
        "payee",
      );
      const amountIdx = columnIndex(header, "amount", "value");
      if (dateIdx === -1 || amountIdx === -1) {
        return c.json(
          { error: "CSV needs at least a date column and an amount column" },
          400,
        );
      }

      const parsed: {
        date: Date;
        description: string | null;
        amountCents: number;
      }[] = [];
      const rejected: { line: number; reason: string }[] = [];

      rows.forEach((row, i) => {
        if (row.every((cell) => cell.trim() === "")) return; // blank line
        const rawDate = (row[dateIdx] ?? "").trim();
        const date = new Date(rawDate);
        if (!rawDate || Number.isNaN(date.getTime())) {
          rejected.push({
            line: i + 2,
            reason: `unreadable date "${rawDate}"`,
          });
          return;
        }
        const amountCents = parseAmountToCents(row[amountIdx] ?? "");
        if (amountCents === null) {
          rejected.push({
            line: i + 2,
            reason: `unreadable amount "${row[amountIdx] ?? ""}"`,
          });
          return;
        }
        parsed.push({
          date,
          description: descIdx === -1 ? null : (row[descIdx] ?? null),
          amountCents,
        });
      });

      if (parsed.length === 0) {
        return c.json(
          { error: "nothing in that file could be read", rejected },
          400,
        );
      }

      /**
       * Which account this statement is of, where the person said.
       *
       * Optional, because a business with one bank account has nothing to
       * choose between and the file is the statement of the only account it
       * has. It matters as soon as there are two: a line categorised without
       * knowing which account it left is money taken out of the wrong one.
       */
      // A query parameter, because the request body is the file itself.
      const statementAccountId = (c.req.query("bankAccountId") ?? "").trim();
      if (statementAccountId) {
        if (!(await ownedAccount(orgId, statementAccountId))) {
          return c.json({ error: "that is not an account of yours" }, 404);
        }
      }

      const imported = await db.transaction(async (tx) => {
        const [batch] = await tx
          .insert(schema.bankImports)
          .values({ organizationId: orgId, filename })
          .returning();
        if (!batch) throw new Error("bank import insert returned no row");
        await tx.insert(schema.bankTransactions).values(
          parsed.map((row) => ({
            organizationId: orgId,
            importId: batch.id,
            date: row.date,
            description: row.description,
            amountCents: row.amountCents,
            ...(statementAccountId
              ? { bankAccountId: statementAccountId }
              : {}),
          })),
        );
        return batch;
      });

      return c.json(
        { bankImport: imported, importedCount: parsed.length, rejected },
        201,
      );
    },
  );

  ctx.app.get(
    "/api/bank-transactions",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      /**
       * With what the line was posted against, where it was posted at all.
       *
       * The screen offers an Undo on a line a rule or a categorisation posted
       * and not on one reconciled against an invoice — which it cannot know
       * without this, and would otherwise find out by offering a button that
       * answers 409.
       */
      const rows = await db
        .select({
          transaction: schema.bankTransactions,
          entrySource: schema.journalEntries.source,
        })
        .from(schema.bankTransactions)
        .leftJoin(
          schema.journalEntries,
          and(
            eq(
              schema.journalEntries.id,
              schema.bankTransactions.matchedEntryId,
            ),
            eq(schema.journalEntries.organizationId, orgId),
          ),
        )
        .where(eq(schema.bankTransactions.organizationId, orgId))
        .orderBy(desc(schema.bankTransactions.date));

      return c.json({
        bankTransactions: rows.map((row) => ({
          ...row.transaction,
          undoable:
            (row.entrySource ?? "").startsWith("bank-rule:") ||
            (row.entrySource ?? "").startsWith("bank-category:"),
        })),
        unmatchedCount: rows.filter((row) => !row.transaction.matchedEntryId)
          .length,
      });
    },
  );

  ctx.app.get(
    "/api/bank-transactions/suggestions",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const [bankRows, invoices, payments, bills, billPayments] =
        await Promise.all([
          db
            .select()
            .from(schema.bankTransactions)
            .where(eq(schema.bankTransactions.organizationId, orgId)),
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
        ]);

      const open = [
        ...invoices.map((invoice) => ({
          kind: "invoice" as const,
          id: invoice.id,
          number: invoice.number,
          balanceDue: invoiceStatus(
            invoice.totalCents,
            payments
              .filter((p) => p.invoiceId === invoice.id)
              .reduce((sum, p) => sum + p.amountCents, 0),
          ).balanceDue,
          date: invoice.issueDate,
        })),
        ...bills.map((bill) => ({
          kind: "bill" as const,
          id: bill.id,
          number: bill.number,
          balanceDue: invoiceStatus(
            bill.totalCents,
            billPayments
              .filter((p) => p.billId === bill.id)
              .reduce((sum, p) => sum + p.amountCents, 0),
          ).balanceDue,
          date: bill.billDate,
        })),
      ];

      return c.json({ suggestions: suggestMatches(bankRows, open) });
    },
  );

  /**
   * Confirming a match, which is what actually records the money.
   *
   * A statement row on its own is a line from a bank. Confirming it against an
   * invoice records the payment and posts Dr Cash / Cr Accounts Receivable;
   * against a bill it records the payment and clears the payable — so a
   * business that reconciles its bank is a business whose books are up to
   * date, without typing anything twice.
   */
  ctx.app.post(
    "/api/bank-transactions/:id/match",
    requireSession(),
    requirePermission({ bookkeeping: ["update"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("id") ?? "";
      if (!isUuid(id)) return c.json({ error: "not found" }, 404);
      const body = await c.req.json().catch(() => ({}));

      const [bankRow] = await db
        .select()
        .from(schema.bankTransactions)
        .where(
          and(
            eq(schema.bankTransactions.id, id),
            eq(schema.bankTransactions.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!bankRow) return c.json({ error: "not found" }, 404);
      if (bankRow.matchedEntryId) {
        return c.json({ error: "already reconciled" }, 409);
      }

      return body.billId
        ? matchBill(c, orgId, bankRow, String(body.billId))
        : matchInvoice(c, orgId, bankRow, String(body.invoiceId ?? ""));
    },
  );
}

type BankRow = typeof schema.bankTransactions.$inferSelect;

/** Money in, settling an invoice. */
async function matchInvoice(
  c: RouteContext,
  orgId: string,
  bankRow: BankRow,
  invoiceId: string,
) {
  if (bankRow.amountCents <= 0) {
    return c.json({ error: "only money in can settle an invoice" }, 400);
  }
  if (!isUuid(invoiceId)) return c.json({ error: "invoice not found" }, 404);

  const [invoice] = await db
    .select()
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.id, invoiceId),
        eq(schema.invoices.organizationId, orgId),
        isNull(schema.invoices.deletedAt),
      ),
    )
    .limit(1);
  if (!invoice) return c.json({ error: "invoice not found" }, 404);

  const paidAlready = (
    await db
      .select({ amountCents: schema.payments.amountCents })
      .from(schema.payments)
      .where(eq(schema.payments.invoiceId, invoice.id))
  ).reduce((sum, row) => sum + row.amountCents, 0);
  if (paidAlready + bankRow.amountCents > invoice.totalCents) {
    return c.json(
      { error: "that is more than this invoice has left to pay" },
      400,
    );
  }

  const [payment] = await db
    .insert(schema.payments)
    .values({
      organizationId: orgId,
      invoiceId: invoice.id,
      amountCents: bankRow.amountCents,
      method: "bank",
      gatewayRef: `bank-transaction:${bankRow.id}`,
    })
    .returning();
  if (!payment) throw new Error("payment insert returned no row");

  const [cash, receivable] = await Promise.all([
    ensureAccount(orgId, CORE_ACCOUNTS.cash),
    ensureAccount(orgId, CORE_ACCOUNTS.accountsReceivable),
  ]);
  const entry = await postJournalEntry(
    orgId,
    `Payment for ${invoice.number}`,
    `payment:${payment.id}`,
    [
      { accountId: cash, debitCents: bankRow.amountCents },
      { accountId: receivable, creditCents: bankRow.amountCents },
    ],
    bankRow.date,
  );

  const { status } = invoiceStatus(
    invoice.totalCents,
    paidAlready + bankRow.amountCents,
  );
  await Promise.all([
    db
      .update(schema.invoices)
      .set({ status, updatedAt: new Date() })
      .where(eq(schema.invoices.id, invoice.id)),
    db
      .update(schema.bankTransactions)
      .set({ matchedEntryId: entry.id })
      .where(eq(schema.bankTransactions.id, bankRow.id)),
  ]);

  return c.json({ payment, status, journalEntryId: entry.id }, 201);
}

/**
 * Money out, settling a bill.
 *
 * The suggestion screen offers bills as well as invoices, so this exists for
 * the same reason the screen does: a payment to a supplier that shows on the
 * statement and nowhere in the books is the thing reconciliation is for.
 */
async function matchBill(
  c: RouteContext,
  orgId: string,
  bankRow: BankRow,
  billId: string,
) {
  if (bankRow.amountCents >= 0) {
    return c.json({ error: "only money out can settle a bill" }, 400);
  }
  if (!isUuid(billId)) return c.json({ error: "bill not found" }, 404);

  const [bill] = await db
    .select()
    .from(schema.bills)
    .where(
      and(
        eq(schema.bills.id, billId),
        eq(schema.bills.organizationId, orgId),
        isNull(schema.bills.deletedAt),
      ),
    )
    .limit(1);
  if (!bill) return c.json({ error: "bill not found" }, 404);
  if (bill.status === "draft") {
    return c.json({ error: "approve the bill before paying it" }, 409);
  }

  const amountCents = Math.abs(bankRow.amountCents);
  const paidAlready = (
    await db
      .select({ amountCents: schema.billPayments.amountCents })
      .from(schema.billPayments)
      .where(eq(schema.billPayments.billId, bill.id))
  ).reduce((sum, row) => sum + row.amountCents, 0);
  if (paidAlready + amountCents > bill.totalCents) {
    return c.json(
      { error: "that is more than this bill has left to pay" },
      400,
    );
  }

  const [payment] = await db
    .insert(schema.billPayments)
    .values({
      organizationId: orgId,
      billId: bill.id,
      amountCents,
      paidAt: bankRow.date,
      method: "bank",
      reference: `bank-transaction:${bankRow.id}`,
    })
    .returning();
  if (!payment) throw new Error("bill payment insert returned no row");

  const [payable, cash] = await Promise.all([
    ensureAccount(orgId, {
      code: "2000",
      name: "Accounts Payable",
      type: "liability",
    }),
    ensureAccount(orgId, CORE_ACCOUNTS.cash),
  ]);
  const entry = await postJournalEntry(
    orgId,
    `Paid bill ${bill.number ?? bill.id.slice(0, 8)}`,
    `bill-payment:${payment.id}`,
    [
      { accountId: payable, debitCents: amountCents },
      { accountId: cash, creditCents: amountCents },
    ],
    bankRow.date,
  );

  const { status } = invoiceStatus(bill.totalCents, paidAlready + amountCents);
  await Promise.all([
    db
      .update(schema.bills)
      .set({ status, updatedAt: new Date() })
      .where(eq(schema.bills.id, bill.id)),
    db
      .update(schema.bankTransactions)
      .set({ matchedEntryId: entry.id })
      .where(eq(schema.bankTransactions.id, bankRow.id)),
  ]);

  return c.json({ payment, status, journalEntryId: entry.id }, 201);
}
