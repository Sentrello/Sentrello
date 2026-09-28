import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import {
  and,
  db,
  eq,
  inArray,
  isNull,
  lte,
  ne,
  schema,
  sql,
} from "@sentrello/db";
import {
  RATE_SCALE,
  baseCurrency,
  rateOn,
  toBaseCents,
} from "@sentrello/db/currency";
import {
  CORE_ACCOUNTS,
  PeriodClosedError,
  ensureAccount,
  exchangeAccount,
  postJournalEntry,
} from "@sentrello/db/ledger";
import { sumCents } from "@sentrello/db/money";
import { dayFrom } from "@sentrello/db/timezone";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";

/**
 * What the open foreign balances are worth at the end of a period.
 *
 * Settlement gain and loss already exists: an invoice raised at one rate and
 * paid at another posts the difference to Exchange Gains and Losses on the day
 * the money moves. That answers what happened. It does not answer what is
 * *true right now* — and at a period end, an invoice for €10,000 raised in
 * January and still unpaid in March is not worth what the balance sheet says
 * it is. The debt has moved in value and the books do not say so.
 *
 * This is the missing half, the **unrealised** one: a walk over what is still
 * open in a currency other than the one the books are kept in, restated at the
 * rate on the period-end date, with the difference posted as a journal entry.
 *
 * **Both sides, receivables and payables.** A euro invoice a customer has not
 * paid and a dollar bill this business has not paid are the same fact seen
 * from two ends — an open balance in a currency that has moved — and a
 * revaluation that did one of them would produce a balance sheet where the
 * assets are current and the liabilities are three months stale. The sign is
 * what differs, not the principle: a receivable worth more is a gain, a
 * payable worth more is a loss.
 *
 * **And it reverses.** The entry is posted on the period-end date and an equal
 * and opposite one on the first day of the next period, which is what the
 * convention asks for and not merely tidiness. Without the reversal the
 * carrying amount of an invoice would no longer be the rate it was raised at,
 * and the settlement entry that eventually clears it — which credits
 * receivable at the *issued* rate, because that is the only rate that makes
 * the debt leave the balance sheet — would leave a residue behind for ever.
 * Reversing means every period restates from the original cost and nothing
 * compounds.
 */

/** Each open document, and what the rate has done to it. */
export interface RevaluationLine {
  kind: "receivable" | "payable";
  documentId: string;
  number: string | null;
  currency: string;
  /** Still outstanding, in the document's own currency. */
  outstandingCents: number;
  /** What the books hold it at — the rate the document was raised at. */
  carryingCents: number;
  /** What it is worth at the period-end rate. */
  revaluedCents: number;
  /** Positive is a rise in the amount; what that *means* depends on the side. */
  differenceCents: number;
}

export interface Revaluation {
  asOf: Date;
  baseCurrency: string;
  lines: RevaluationLine[];
  /** Net movement on receivables: positive is a gain. */
  receivableCents: number;
  /** Net movement on payables: positive is a loss. */
  payableCents: number;
  /** Currencies with an open balance and no rate recorded on or before the date. */
  missingRates: string[];
}

/**
 * The walk, with no side effects, so the screen and the posting agree.
 *
 * A preview that recomputes differently from the thing it previews is worse
 * than no preview: somebody approves one set of figures and a different set
 * lands in the books.
 */
export async function revalueOpenBalances(
  orgId: string,
  asOf: Date,
): Promise<Revaluation> {
  const base = await baseCurrency(orgId);
  const lines: RevaluationLine[] = [];
  const missing = new Set<string>();
  const rates = new Map<string, number | null>();
  const rateFor = async (code: string): Promise<number | null> => {
    if (!rates.has(code)) rates.set(code, await rateOn(orgId, code, asOf));
    return rates.get(code) ?? null;
  };

  /**
   * What is still owed on each document, in its own currency.
   *
   * Summed rather than stored, for the same reason every other balance in
   * this ledger is: a running total on the document can drift from the rows
   * that were supposed to add up to it, and a revaluation built on a drifted
   * figure is a wrong number posted to the books with a straight face.
   */
  const invoices = await db
    .select({
      id: schema.invoices.id,
      number: schema.invoices.number,
      currency: schema.invoices.currency,
      rateMicro: schema.invoices.rateMicro,
      totalCents: schema.invoices.totalCents,
    })
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.organizationId, orgId),
        isNull(schema.invoices.deletedAt),
        eq(schema.invoices.kind, "invoice"),
        inArray(schema.invoices.status, ["open", "partial"]),
        ne(schema.invoices.currency, base),
        lte(schema.invoices.issueDate, asOf),
      ),
    );

  if (invoices.length > 0) {
    const ids = invoices.map((i) => i.id);
    const paid = new Map<string, number>();
    for (const row of await db
      .select({
        invoiceId: schema.payments.invoiceId,
        cents: sumCents(schema.payments.amountCents),
      })
      .from(schema.payments)
      .where(
        and(
          eq(schema.payments.organizationId, orgId),
          inArray(schema.payments.invoiceId, ids),
          lte(schema.payments.receivedAt, asOf),
        ),
      )
      .groupBy(schema.payments.invoiceId)) {
      paid.set(row.invoiceId, row.cents);
    }

    const credited = new Map<string, number>();
    for (const row of await db
      .select({
        invoiceId: schema.invoices.referenceInvoiceId,
        cents: sumCents(schema.invoices.totalCents),
      })
      .from(schema.invoices)
      .where(
        and(
          eq(schema.invoices.organizationId, orgId),
          eq(schema.invoices.kind, "credit_note"),
          isNull(schema.invoices.deletedAt),
          inArray(schema.invoices.referenceInvoiceId, ids),
          lte(schema.invoices.issueDate, asOf),
        ),
      )
      .groupBy(schema.invoices.referenceInvoiceId)) {
      if (row.invoiceId) credited.set(row.invoiceId, row.cents);
    }

    for (const invoice of invoices) {
      const outstanding =
        invoice.totalCents -
        (paid.get(invoice.id) ?? 0) -
        (credited.get(invoice.id) ?? 0);
      if (outstanding === 0) continue;
      const rate = await rateFor(invoice.currency);
      if (rate === null) {
        missing.add(invoice.currency);
        continue;
      }
      const carrying = toBaseCents(
        outstanding,
        invoice.rateMicro ?? RATE_SCALE,
      );
      const revalued = toBaseCents(outstanding, rate);
      lines.push({
        kind: "receivable",
        documentId: invoice.id,
        number: invoice.number,
        currency: invoice.currency,
        outstandingCents: outstanding,
        carryingCents: carrying,
        revaluedCents: revalued,
        differenceCents: revalued - carrying,
      });
    }
  }

  /**
   * The same walk on the other side.
   *
   * Bills are a paid feature, so on a Free instance this loop simply finds
   * nothing — the table is in the one schema either way, and a revaluation
   * that only knew about half the ledger would be the wrong thing to build
   * twice.
   */
  const bills = await db
    .select({
      id: schema.bills.id,
      number: schema.bills.number,
      currency: schema.bills.currency,
      rateMicro: schema.bills.rateMicro,
      totalCents: schema.bills.totalCents,
    })
    .from(schema.bills)
    .where(
      and(
        eq(schema.bills.organizationId, orgId),
        isNull(schema.bills.deletedAt),
        inArray(schema.bills.status, ["open", "partial"]),
        ne(schema.bills.currency, base),
        lte(schema.bills.billDate, asOf),
      ),
    );

  if (bills.length > 0) {
    const ids = bills.map((b) => b.id);
    const settled = new Map<string, number>();
    for (const row of await db
      .select({
        billId: schema.billPayments.billId,
        cents: sumCents(schema.billPayments.amountCents),
      })
      .from(schema.billPayments)
      .where(
        and(
          eq(schema.billPayments.organizationId, orgId),
          inArray(schema.billPayments.billId, ids),
          lte(schema.billPayments.paidAt, asOf),
        ),
      )
      .groupBy(schema.billPayments.billId)) {
      settled.set(row.billId, row.cents);
    }

    for (const bill of bills) {
      const outstanding = bill.totalCents - (settled.get(bill.id) ?? 0);
      if (outstanding === 0) continue;
      const rate = await rateFor(bill.currency);
      if (rate === null) {
        missing.add(bill.currency);
        continue;
      }
      const carrying = toBaseCents(outstanding, bill.rateMicro ?? RATE_SCALE);
      const revalued = toBaseCents(outstanding, rate);
      lines.push({
        kind: "payable",
        documentId: bill.id,
        number: bill.number,
        currency: bill.currency,
        outstandingCents: outstanding,
        carryingCents: carrying,
        revaluedCents: revalued,
        differenceCents: revalued - carrying,
      });
    }
  }

  const sum = (kind: RevaluationLine["kind"]) =>
    lines
      .filter((l) => l.kind === kind)
      .reduce((total, l) => total + l.differenceCents, 0);

  return {
    asOf,
    baseCurrency: base,
    lines,
    receivableCents: sum("receivable"),
    // A payable worth more in base currency is a loss, so the sign is flipped
    // once, here, rather than in every reader.
    payableCents: sum("payable"),
    missingRates: [...missing].sort(),
  };
}

/** The source both entries carry, so the pair can be found again. */
export const FX_REVALUATION_SOURCE = "fx-revaluation";

/**
 * The postings for one revaluation, as debits and credits.
 *
 * Receivable rises: the asset is worth more, so debit Accounts Receivable and
 * credit Exchange — an unrealised gain. Payable rises: the liability is worth
 * more, so credit Accounts Payable and debit Exchange — an unrealised loss.
 * Both directions of both, which is four cases and one rule: the control
 * account moves by what the balance actually did, and Exchange takes the
 * other side.
 */
async function postingsFor(orgId: string, movement: Revaluation) {
  const exchange = await exchangeAccount(orgId);
  const postings: {
    accountId: string;
    debitCents?: number;
    creditCents?: number;
  }[] = [];

  if (movement.receivableCents !== 0) {
    const ar = await ensureAccount(orgId, CORE_ACCOUNTS.accountsReceivable);
    const amount = Math.abs(movement.receivableCents);
    postings.push(
      movement.receivableCents > 0
        ? { accountId: ar, debitCents: amount }
        : { accountId: ar, creditCents: amount },
    );
    postings.push(
      movement.receivableCents > 0
        ? { accountId: exchange, creditCents: amount }
        : { accountId: exchange, debitCents: amount },
    );
  }

  if (movement.payableCents !== 0) {
    const ap = await ensureAccount(orgId, CORE_ACCOUNTS.accountsPayable);
    const amount = Math.abs(movement.payableCents);
    postings.push(
      movement.payableCents > 0
        ? { accountId: ap, creditCents: amount }
        : { accountId: ap, debitCents: amount },
    );
    postings.push(
      movement.payableCents > 0
        ? { accountId: exchange, debitCents: amount }
        : { accountId: exchange, creditCents: amount },
    );
  }

  return postings;
}

export function registerFxRevaluation(ctx: ModuleContext) {
  /**
   * The date asked about, as the last instant of that day.
   *
   * A period ends at the close of business on the 31st, not at midnight as it
   * began — an invoice raised that morning is inside the period being closed.
   */
  const endOfDay = (raw: string | undefined): Date | null => {
    const day = dayFrom(raw ?? "");
    if (!day || Number.isNaN(day.getTime())) return null;
    const end = new Date(day);
    end.setUTCHours(23, 59, 59, 999);
    return end;
  };

  ctx.app.get(
    "/api/accounting/fx-revaluation",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const asOf = endOfDay(c.req.query("asOf"));
      if (!asOf) return c.json({ error: "unreadable date" }, 400);
      const movement = await revalueOpenBalances(orgId, asOf);
      const [already] = await db
        .select({ id: schema.journalEntries.id })
        .from(schema.journalEntries)
        .where(
          and(
            eq(schema.journalEntries.organizationId, orgId),
            eq(schema.journalEntries.source, FX_REVALUATION_SOURCE),
            eq(schema.journalEntries.postedAt, asOf),
          ),
        )
        .limit(1);
      return c.json({ ...movement, alreadyPosted: Boolean(already) });
    },
  );

  ctx.app.post(
    "/api/accounting/fx-revaluation",
    requireSession(),
    requirePermission({ bookkeeping: ["create"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as {
        asOf?: unknown;
      };
      const asOf = endOfDay(
        typeof body.asOf === "string" ? body.asOf : undefined,
      );
      if (!asOf) return c.json({ error: "unreadable date" }, 400);

      /*
       * Once per period end.
       *
       * Posting it twice would double the restatement, and the second one
       * would reverse into the next period as well — so the books would be
       * wrong in two places for a button pressed twice.
       */
      const [already] = await db
        .select({ id: schema.journalEntries.id })
        .from(schema.journalEntries)
        .where(
          and(
            eq(schema.journalEntries.organizationId, orgId),
            eq(schema.journalEntries.source, FX_REVALUATION_SOURCE),
            eq(schema.journalEntries.postedAt, asOf),
          ),
        )
        .limit(1);
      if (already) {
        return c.json(
          {
            error: "the open balances have already been revalued to that date",
          },
          409,
        );
      }

      const movement = await revalueOpenBalances(orgId, asOf);
      if (movement.missingRates.length > 0) {
        return c.json(
          {
            error: `no exchange rate recorded on or before that date for ${movement.missingRates.join(", ")} — record one first`,
          },
          400,
        );
      }

      const postings = await postingsFor(orgId, movement);
      if (postings.length === 0) {
        return c.json({ ...movement, posted: null, reversal: null });
      }

      const day = asOf.toISOString().slice(0, 10);
      /*
       * The first instant of the next day: the reversal belongs to the period
       * that follows, not to the one being closed. Posted at the start of it
       * so that anything settled on that day is already measured against the
       * original carrying amount.
       */
      const next = new Date(asOf.getTime() + 1);

      try {
        const posted = await postJournalEntry(
          orgId,
          `Unrealised exchange movement on open balances at ${day}`,
          FX_REVALUATION_SOURCE,
          postings,
          asOf,
        );
        const reversal = await postJournalEntry(
          orgId,
          `Reversal of unrealised exchange movement at ${day}`,
          `${FX_REVALUATION_SOURCE}-reversal`,
          // The same lines the other way up. Written from the posting rather
          // than recomputed, so the pair cannot disagree by a cent.
          postings.map((p) => ({
            accountId: p.accountId,
            debitCents: p.creditCents ?? 0,
            creditCents: p.debitCents ?? 0,
          })),
          next,
        );
        return c.json({ ...movement, posted, reversal }, 201);
      } catch (err) {
        if (err instanceof PeriodClosedError) {
          return c.json(
            {
              error: `the books are closed through ${err.message} — reopen them to revalue`,
            },
            409,
          );
        }
        throw err;
      }
    },
  );
}
