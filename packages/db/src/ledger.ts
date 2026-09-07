import { and, eq } from "drizzle-orm";
import { currentActor } from "./actor";
import { RATE_SCALE, toBaseCents } from "./currency";
import { db, schema } from "./index";

type Posting = {
  accountId: string;
  debitCents?: number;
  creditCents?: number;
  /**
   * Which part of the business the line belongs to, if any.
   *
   * Optional everywhere and always: most lines belong to the business as a
   * whole, and every caller written before dimensions existed keeps working
   * untouched. A line without one is not a line with a mistake in it.
   */
  classId?: string | null;
  locationId?: string | null;
};

/** Chart-of-accounts codes the invoicing flow posts against. */
export const CORE_ACCOUNTS = {
  cash: { code: "1000", name: "Cash", type: "asset" },
  accountsReceivable: {
    code: "1100",
    name: "Accounts Receivable",
    type: "asset",
  },
  salesIncome: { code: "4000", name: "Sales Income", type: "income" },
  /**
   * What was given away, kept apart from what was never earned.
   *
   * A contra-revenue account rather than netting discounts off income: a
   * business that discounted £4,000 to earn £40,000 wants to see both numbers,
   * and a P&L showing only £36,000 of income cannot answer whether the codes
   * were worth running.
   */
  salesDiscounts: { code: "4100", name: "Sales Discounts", type: "expense" },
  taxPayable: { code: "2200", name: "Tax Payable", type: "liability" },
  /** Where an expense lands when it has not been given an account of its own. */
  generalExpense: { code: "6000", name: "General Expenses", type: "expense" },
  /**
   * What the payment processor kept, rather than money the business never took.
   *
   * A card sale of 100 puts about 97 in the bank. Debiting Cash for the full
   * 100 makes the books disagree with the bank statement by the fee on every
   * order, and somebody reconciles the difference by hand forever. Posting the
   * fee as its own expense makes Cash the amount that actually landed, and
   * makes the year's processing cost a number the business can see.
   *
   * Its own account rather than Bank Charges (6800): a bank's monthly charge
   * and a per-sale processing fee scale with completely different things, and
   * a business deciding whether to change processor wants only the second.
   */
  paymentFees: {
    code: "6850",
    name: "Payment Processing Fees",
    type: "expense",
  },
  /**
   * Where currency movement lands.
   *
   * Neither income the business earned nor a cost it chose: the rate moved
   * between the day a document was raised and the day it was settled. Its own
   * account, so a business can see how much of its year was currency.
   *
   * Here rather than in Accounting because both halves of the books need it —
   * a bill being paid and an invoice being settled ask the same question, and
   * the sales side had no answer at all until it was moved.
   */
  exchange: {
    code: "7000",
    name: "Exchange Gains and Losses",
    type: "expense",
  },
} as const;

/** The account currency movement lands in. */
export async function exchangeAccount(orgId: string): Promise<string> {
  return ensureAccount(orgId, CORE_ACCOUNTS.exchange);
}

/** Idempotently resolves one of the core accounts for an organization. */
export async function ensureAccount(
  orgId: string,
  account: { code: string; name: string; type: string },
): Promise<string> {
  const [existing] = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.organizationId, orgId),
        eq(schema.accounts.code, account.code),
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const [created] = await db
    .insert(schema.accounts)
    .values({ organizationId: orgId, ...account })
    .returning();
  if (!created) throw new Error(`could not create account ${account.code}`);
  return created.id;
}

/**
 * The books are closed up to here, and this entry belongs before it.
 *
 * Its own type so one handler can answer every route with 409 rather than 500.
 * A refusal a business can read — "the books are closed through 31 March" — is
 * the difference between somebody correcting the date and somebody filing a
 * bug.
 */
export class PeriodClosedError extends Error {
  /**
   * The answer a route should give, carried by the error itself.
   *
   * The host maps this; so does the harness a module is tested against. Both
   * read the number off the error rather than knowing this class, which is why
   * a module can be tested in isolation and still see the status its users
   * will get.
   */
  readonly status = 409;
  readonly closedThrough: Date;
  constructor(closedThrough: Date) {
    super(
      `the books are closed through ${closedThrough.toISOString().slice(0, 10)}, so nothing can be posted on or before that date`,
    );
    this.name = "PeriodClosedError";
    this.closedThrough = closedThrough;
  }
}

/** The last closed day for an organization, or null when nothing is closed. */
export async function closedThrough(orgId: string): Promise<Date | null> {
  const [row] = await db
    .select({ closedThrough: schema.ledgerSettings.closedThrough })
    .from(schema.ledgerSettings)
    .where(eq(schema.ledgerSettings.organizationId, orgId))
    .limit(1);
  return row?.closedThrough ?? null;
}

/**
 * Posts a balanced journal entry or throws. Guarantees Σdebits === Σcredits.
 *
 * `postedAt` is the date the entry belongs to, which is not always today: an
 * expense entered on the 3rd for a receipt dated the 28th of last month belongs
 * in last month, or every report for a period changes depending on when
 * somebody got round to typing it in. It defaults to now because most things
 * are recorded as they happen.
 *
 * Which is exactly why the period lock is enforced here. A business that has
 * filed a return needs those figures to stay filed, and every module that
 * touches money comes through this function — so the rule is checked once,
 * rather than in each caller that would have to remember it. Off by default:
 * an organization with no lock behaves as it always has.
 */
export async function postJournalEntry(
  orgId: string,
  memo: string,
  source: string,
  lines: Posting[],
  postedAt?: Date,
) {
  const d = lines.reduce((s, l) => s + (l.debitCents ?? 0), 0);
  const c = lines.reduce((s, l) => s + (l.creditCents ?? 0), 0);
  if (d !== c) throw new Error(`Unbalanced entry: debits ${d} != credits ${c}`);

  /*
   * Checked before the transaction opens, because a refusal is not a rollback:
   * nothing should be written and then undone to find out the answer.
   *
   * The comparison is against the whole of the closed day. `closedThrough` is
   * the last day that is closed, so an entry timestamped anywhere inside it is
   * inside the closed period — storing the boundary as a date and comparing
   * instants is how a lock lets in everything after breakfast on its last day.
   */
  const closed = await closedThrough(orgId);
  if (closed) {
    const endOfClosedDay = new Date(closed);
    endOfClosedDay.setUTCHours(23, 59, 59, 999);
    if ((postedAt ?? new Date()) <= endOfClosedDay) {
      throw new PeriodClosedError(closed);
    }
  }
  return db.transaction(async (tx) => {
    const [entry] = await tx
      .insert(schema.journalEntries)
      .values({
        organizationId: orgId,
        memo,
        source,
        /**
         * Whoever the request belongs to, if it belongs to anybody.
         *
         * Read here rather than passed in, because this is several calls below
         * every route that posts and threading it through each of them would
         * be quietly wrong at the first one somebody forgot.
         */
        createdBy: currentActor(),
        ...(postedAt ? { postedAt } : {}),
      })
      .returning();
    if (!entry) throw new Error("journal entry insert returned no row");
    await tx.insert(schema.journalLines).values(
      lines.map((l) => ({
        entryId: entry.id,
        accountId: l.accountId,
        debitCents: l.debitCents ?? 0,
        creditCents: l.creditCents ?? 0,
        classId: l.classId ?? null,
        locationId: l.locationId ?? null,
      })),
    );
    return entry;
  });
}

/**
 * The entry raising an invoice makes: Dr Accounts Receivable, Cr Income, plus
 * any tax.
 *
 * Here rather than in the invoicing module because more than one thing raises
 * an invoice — the invoices screen, a quote being converted, and now a deal
 * that bills itself the moment a customer accepts. Every one of them has to
 * post the same entry, or revenue exists on a document and nowhere in the
 * books.
 */
export async function postInvoiceIssued(
  orgId: string,
  invoice: {
    id: string;
    number: string;
    taxCents: number;
    totalCents: number;
    /** What this document's currency was worth when it was raised. */
    rateMicro?: number | null;
  },
  memo?: string,
  /**
   * The date the entry belongs to, which is the invoice's own issue date.
   *
   * Absent means today, which is right for an invoice raised today. It matters
   * for the rest: a business loading its back catalogue can already give an
   * invoice a June issue date, and without this the document said June while
   * the ledger said today — so every report that groups by month collapsed a
   * year of trading into whichever month the loading happened in.
   */
  postedAt?: Date,
): Promise<void> {
  const [ar, income, taxPayable] = await Promise.all([
    ensureAccount(orgId, CORE_ACCOUNTS.accountsReceivable),
    ensureAccount(orgId, CORE_ACCOUNTS.salesIncome),
    ensureAccount(orgId, CORE_ACCOUNTS.taxPayable),
  ]);

  /**
   * Converted, and derived from the total rather than the subtotal.
   *
   * Two bugs lived in the older shape. It credited income with `subtotal`,
   * which does not balance against a total that has had a discount taken off
   * it — a discounted invoice raised this way threw, or would have. And it
   * posted face value whatever currency the document was in, so a euro invoice
   * put euro cents into dollar books.
   *
   * Income is what is left after tax, out of what the customer actually owes.
   * The rounding lands there for the same reason: the debit has to be the
   * converted total, because that is the debt.
   */
  const rate = invoice.rateMicro ?? RATE_SCALE;
  const debit = toBaseCents(invoice.totalCents, rate);
  const tax = toBaseCents(invoice.taxCents, rate);
  const net = debit - tax;

  await postJournalEntry(
    orgId,
    memo ?? `Invoice ${invoice.number}`,
    `invoice:${invoice.id}`,
    [
      { accountId: ar, debitCents: debit },
      { accountId: income, creditCents: net },
      ...(tax > 0 ? [{ accountId: taxPayable, creditCents: tax }] : []),
    ],
    postedAt,
  );
}

/**
 * Undoes a posting by posting its opposite.
 *
 * The ledger is append-only: deleting the entry that recorded a payment would
 * leave a business unable to explain a figure it printed last week, and would
 * quietly change every report that has already been filed. So a correction is
 * itself an entry — every line of the original with its sides swapped, dated
 * when the correction was made rather than when the mistake was.
 *
 * Returns how many entries were reversed. Zero is not an error: something
 * recorded before it ever reached the ledger has nothing to undo.
 */
export async function reverseJournalEntries(
  orgId: string,
  source: string,
  memo: string,
  at?: Date,
): Promise<number> {
  const entries = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(
      and(
        eq(schema.journalEntries.organizationId, orgId),
        eq(schema.journalEntries.source, source),
      ),
    );
  if (entries.length === 0) return 0;

  let reversed = 0;
  for (const entry of entries) {
    const lines = await db
      .select({
        accountId: schema.journalLines.accountId,
        debitCents: schema.journalLines.debitCents,
        creditCents: schema.journalLines.creditCents,
      })
      .from(schema.journalLines)
      .where(eq(schema.journalLines.entryId, entry.id));
    if (lines.length === 0) continue;

    await postJournalEntry(
      orgId,
      memo,
      `reversal:${entry.id}`,
      lines.map((line) => ({
        accountId: line.accountId,
        debitCents: line.creditCents,
        creditCents: line.debitCents,
      })),
      at,
    );
    reversed += 1;
  }
  return reversed;
}

/**
 * Whether a source has already been reversed.
 *
 * Undoing the same thing twice would post the correction twice and leave the
 * books out by the amount — and a second click, a retried request or two people
 * on the same row all produce exactly that.
 */
export async function alreadyReversed(
  orgId: string,
  source: string,
): Promise<boolean> {
  const entries = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(
      and(
        eq(schema.journalEntries.organizationId, orgId),
        eq(schema.journalEntries.source, source),
      ),
    );
  if (entries.length === 0) return false;

  for (const entry of entries) {
    const [found] = await db
      .select({ id: schema.journalEntries.id })
      .from(schema.journalEntries)
      .where(
        and(
          eq(schema.journalEntries.organizationId, orgId),
          eq(schema.journalEntries.source, `reversal:${entry.id}`),
        ),
      )
      .limit(1);
    if (found) return true;
  }
  return false;
}
