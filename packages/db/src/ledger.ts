import type { CustomField } from "@sentrello/module-sdk/custom-fields";
import { coerceCustomValues } from "@sentrello/module-sdk/custom-fields";
import type { SQL } from "drizzle-orm";
import {
  and,
  asc,
  eq,
  exists,
  gte,
  inArray,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { alias } from "drizzle-orm/pg-core";
import { currentActor } from "./actor";
import type { DbTx } from "./client";
import { RATE_SCALE, toBaseCents } from "./currency";
import { db, schema } from "./index";
import { sumCents } from "./money";
import { recordSalePlace } from "./sale-place";
import { demandDate } from "./timezone";

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
  /**
   * The current account, which is where a small business's money actually is.
   *
   * Beside `cash` rather than instead of it: petty cash and the bank are two
   * balances a business counts separately, and a cash-flow statement wants
   * both. It was in the starter chart from the beginning and named nowhere
   * else, so every module that needed to know what counts as cash wrote
   * "1010" down from memory — see `CASH_ACCOUNT_CODES`.
   */
  bank: { code: "1010", name: "Bank Account", type: "asset" },
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
  /**
   * Stock the business owns and has not sold yet.
   *
   * An asset, because it is: goods on a shelf are worth what was paid for
   * them until somebody buys them. Without it a delivery is invisible to the
   * books — the shop's stock count goes up and the balance sheet does not —
   * and the cost of everything sold falls out of the accounts entirely.
   *
   * That is not theoretical. The demo traded for four months, rang up 1,802
   * sales and $98,750 of income, and reported $272 of expenses: a 99.7%
   * margin on a shop that buys its stock from suppliers. The chart of
   * accounts has had a Cost of Sales line since the beginning and nothing
   * ever posted to it.
   */
  inventory: { code: "1200", name: "Inventory", type: "asset" },
  /**
   * What the goods sold actually cost, matched to the sale that sold them.
   *
   * Posted when stock leaves for a customer rather than when it arrived, which
   * is the whole point: gross profit is a sale minus the cost of that sale, and
   * a business that expensed its deliveries on the day they landed would show
   * a loss every time it restocked and a fortune every quiet week.
   *
   * Code 5000, which the default chart already carried under this name.
   */
  costOfSales: { code: "5000", name: "Cost of Sales", type: "expense" },
  /**
   * Owed to suppliers for stock that has arrived.
   *
   * Where a delivery's other half lands. Crediting Cash instead would say the
   * money left the bank the moment the boxes did, and the books would disagree
   * with the statement until somebody reconciled it by hand.
   */
  accountsPayable: {
    code: "2000",
    name: "Accounts Payable",
    type: "liability",
  },
  /**
   * Money a customer overpaid, held against their next invoice rather than
   * refunded.
   *
   * A liability, not income: it is not earned until it is applied to
   * something they bought, and until then it is money the business owes
   * back — as a credit, not necessarily as cash. See `overpaymentPolicy` on
   * `invoicingSettings` and the `customerCredits` table, which is this
   * account's subsidiary ledger, broken down by customer.
   */
  customerCredits: {
    code: "2300",
    name: "Customer Credits",
    type: "liability",
  },
} as const;

/**
 * What a cash-flow statement counts as cash.
 *
 * A report that has to know this had no way to ask, so it wrote the codes down
 * — `["1000", "1010"]`, in a module that cannot import the chart they came
 * from. The starter chart is Core's and a business may edit it; either moving
 * changes what "cash in and out" means, and the symptom is not an error but a
 * wrong figure on a statement somebody makes decisions from.
 *
 * So the codes are named here, beside the accounts they belong to, and
 * `cashAccounts` resolves them against the chart a business actually has.
 */
export const CASH_ACCOUNT_CODES: readonly string[] = [
  CORE_ACCOUNTS.cash.code,
  CORE_ACCOUNTS.bank.code,
];

/**
 * The cash accounts one business actually holds, and the codes it does not.
 *
 * Read, never created: a report must not write to the books it is reporting
 * on, which is why this is not `ensureAccount`. A business is free to delete
 * an account it never used, so `missing` is an answer rather than an error —
 * but it is an answer the caller has to look at. A statement drawn over no
 * cash accounts at all reports zeroes, and zero movement on a trading business
 * is the wrong number rather than the absence of one; say so on the report
 * instead of drawing it.
 *
 * `codes` so a module with a wider idea of cash — a savings account a business
 * added itself — can pass its own list and still resolve it the same way.
 */
export async function cashAccounts(
  orgId: string,
  codes: readonly string[] = CASH_ACCOUNT_CODES,
): Promise<{ ids: string[]; missing: string[] }> {
  if (codes.length === 0) return { ids: [], missing: [] };
  const rows = await db
    .select({ id: schema.accounts.id, code: schema.accounts.code })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.organizationId, orgId),
        inArray(schema.accounts.code, [...codes]),
      ),
    );
  const found = new Set(rows.map((r) => r.code));
  return {
    ids: rows.map((r) => r.id),
    missing: codes.filter((code) => !found.has(code)),
  };
}

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
/**
 * Is this account the tax a return reads?
 *
 * "2200" is the shared Tax Payable account, and a document that charges two
 * named taxes — Canada's GST beside a PST, a UK invoice carrying standard and
 * reduced rates, any US jurisdiction at all — posts each one to an account of
 * its own, coded `2200-` plus the definition's id. That split is deliberate
 * and each filing needs its own figure.
 *
 * What was not deliberate is that every reader matched the code exactly. A UK
 * business whose invoice carried two VAT rates put its VAT on `2200-xxxxxxxx`
 * and its return's box 1 never saw a penny of it: the return was understated,
 * quietly, by the whole of that document's tax.
 *
 * One predicate, so a reader cannot be written that knows about the shared
 * account and not about the authorities' own.
 */
export function isTaxPayableCode(code: string): boolean {
  return (
    code === CORE_ACCOUNTS.taxPayable.code ||
    code.startsWith(`${CORE_ACCOUNTS.taxPayable.code}-`)
  );
}

/** The same rule as SQL, for a read that narrows on the code. */
export function taxPayableCodeMatch(column: PgColumn): SQL {
  return sql`(${column} = ${CORE_ACCOUNTS.taxPayable.code}
    or ${column} like ${`${CORE_ACCOUNTS.taxPayable.code}-%`})`;
}

/**
 * `tx` joins a transaction the caller already has open, the same option
 * `postJournalEntry` and `recordCreditMovement` take.
 *
 * Without it this read is always on its own connection, and so never sees a
 * change to the lock that the caller has made but not yet committed. That is
 * what stopped a year-end reopen being one transaction: the sequence unlocks,
 * posts a reversal dated inside the closed year, and locks again — and the
 * post is refused by a lock the reopen has already lifted, because the read
 * looked somewhere the unlock had not reached. So the three steps were three
 * commits, and a failure between the first and the last left a business's
 * closed year open, silently, with nothing on any screen saying so. A closed
 * period is a control an auditor asks about; it must not come off by accident.
 */
export async function closedThrough(
  orgId: string,
  options: { tx?: LedgerTx } = {},
): Promise<Date | null> {
  const [row] = await (options.tx ?? db)
    .select({ closedThrough: schema.ledgerSettings.closedThrough })
    .from(schema.ledgerSettings)
    .where(eq(schema.ledgerSettings.organizationId, orgId))
    .limit(1);
  return row?.closedThrough ?? null;
}

/**
 * The extra fields a business keeps on its bills and its money in and out.
 *
 * Read from the same `ledgerSettings` row `closedThrough` lives on, and
 * needed by both halves of the books: the Free side stores them on a
 * transaction, the paid side on a bill, and neither owns the other's package.
 * A purchase-order number, a job reference, which van the fuel went into —
 * none of it worth a migration, and the rule that matters is the platform's,
 * in the module SDK's `coerceCustomValues`: a value is only ever written
 * against a field somebody defined.
 */
export const ACCOUNTING_SUBJECTS = ["bill", "transaction"] as const;

/** The definitions this business has, or none. */
export async function accountingFieldsFor(
  organizationId: string,
): Promise<CustomField[]> {
  const [row] = await db
    .select({ customFields: schema.ledgerSettings.customFields })
    .from(schema.ledgerSettings)
    .where(eq(schema.ledgerSettings.organizationId, organizationId))
    .limit(1);
  return row?.customFields ?? [];
}

/**
 * The values on one record, checked against what the business defined.
 *
 * Anything without a definition is dropped rather than kept "just in case".
 * The body of a request is not a schema, and without this any caller could
 * write any key onto any bill or transaction for ever.
 */
export async function accountingValues(
  organizationId: string,
  subject: (typeof ACCOUNTING_SUBJECTS)[number],
  input: unknown,
): Promise<Record<string, string | number | boolean | null>> {
  if (input === undefined) return {};
  return coerceCustomValues(
    await accountingFieldsFor(organizationId),
    subject,
    input,
  );
}

/**
 * Which part of the business a journal line belongs to.
 *
 * A class is a job, a project, a department, a product line; a location is a
 * branch, a van, a site. Both live on the journal line rather than the entry,
 * so one bill can cover two jobs.
 *
 * Read from here by both halves of the books for the same reason the custom
 * field helpers above are: a transaction tags itself on the Free side, a bill
 * line tags itself on the paid side, and the check — does this id genuinely
 * belong to this business — has to be one implementation or it drifts.
 */
export const KINDS = ["class", "location"] as const;
export type DimensionKind = (typeof KINDS)[number];

/**
 * A class or a location this business has, checked before anything posts to it.
 *
 * An archived one is still valid to post against — a job closed in March can
 * still receive a correcting entry in April, and refusing that would send
 * somebody to un-archive a job to fix a typo.
 */
export async function ownedDimension(
  organizationId: string,
  kind: DimensionKind,
  id: unknown,
): Promise<string | null | "unknown"> {
  if (id === undefined || id === null || id === "") return null;
  const [row] = await db
    .select({ id: schema.dimensions.id })
    .from(schema.dimensions)
    .where(
      and(
        eq(schema.dimensions.id, String(id)),
        eq(schema.dimensions.organizationId, organizationId),
        eq(schema.dimensions.kind, kind),
      ),
    )
    .limit(1);
  return row ? row.id : "unknown";
}

export interface Tagging {
  classId: string | null;
  locationId: string | null;
}

/**
 * The class and location on a request, both checked.
 *
 * Returned together because they are used together, and refused as a pair: a
 * request naming a location that is not this business's should not quietly
 * post with the class it did get right.
 */
export async function taggingFrom(
  organizationId: string,
  body: Record<string, unknown>,
): Promise<Tagging | { error: string }> {
  const classId = await ownedDimension(organizationId, "class", body.classId);
  if (classId === "unknown") {
    return { error: "that is not a class of yours" };
  }
  const locationId = await ownedDimension(
    organizationId,
    "location",
    body.locationId,
  );
  if (locationId === "unknown") {
    return { error: "that is not a location of yours" };
  }
  return { classId, locationId };
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
    /*
     * Refused rather than ignored.
     *
     * A period parameter that could not be read used to fall back to "no
     * bound", which turns "the March quarter" into the whole history of the
     * business and looks like a report rather than a mistake. And a day that
     * never existed — 30 February — rolled forward into the next month, which
     * moved the boundary of a VAT quarter or a US filing period by two days
     * with every figure downstream agreeing with itself.
     */
    const date = demandDate(value);
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
/** A transaction handle, for a caller that has one open already. */
export type LedgerTx = DbTx;

export interface PostOptions {
  /**
   * Post into a period the books are closed through.
   *
   * There is exactly one caller, and it is the archive's carry-forward: the
   * summary standing in for a closed period's removed detail has to be dated
   * inside that period or it would move every report over it. Every other
   * caller — every route, every job, every webhook — leaves this alone and is
   * refused by the lock, which is the point of the lock.
   */
  intoClosedPeriod?: boolean;
  /**
   * Join a transaction the caller already has open.
   *
   * So that posting a summary and removing the detail it stands for either
   * both happen or neither does. Without it the two are separate commits and a
   * crash between them leaves the books stating a period twice.
   */
  tx?: LedgerTx;
}

export async function postJournalEntry(
  orgId: string,
  memo: string,
  source: string,
  lines: Posting[],
  postedAt?: Date,
  options?: PostOptions,
) {
  const d = lines.reduce((s, l) => s + (l.debitCents ?? 0), 0);
  const c = lines.reduce((s, l) => s + (l.creditCents ?? 0), 0);
  if (d !== c) throw new Error(`Unbalanced entry: debits ${d} != credits ${c}`);

  /*
   * Checked before this function opens a transaction of its own, because a
   * refusal is not a rollback: nothing should be written and then undone to
   * find out the answer.
   *
   * Read on the caller's transaction when there is one, so a caller that has
   * just moved the lock inside that transaction is answered by the lock as it
   * now stands rather than as it was committed.
   *
   * The comparison is against the whole of the closed day. `closedThrough` is
   * the last day that is closed, so an entry timestamped anywhere inside it is
   * inside the closed period — storing the boundary as a date and comparing
   * instants is how a lock lets in everything after breakfast on its last day.
   */
  const closed = options?.intoClosedPeriod
    ? null
    : await closedThrough(orgId, { tx: options?.tx });
  if (closed) {
    const endOfClosedDay = new Date(closed);
    endOfClosedDay.setUTCHours(23, 59, 59, 999);
    if ((postedAt ?? new Date()) <= endOfClosedDay) {
      throw new PeriodClosedError(closed);
    }
  }
  const connection = options?.tx ?? db;
  return connection.transaction(async (tx) => {
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
 * Where a document's sale happened, written onto the sale as it reaches the
 * books.
 *
 * Here rather than at each of the five places that post an invoice, for the
 * reason the posting itself is here: a sale whose place was recorded by only
 * some of its callers is a return that is right until somebody bills from the
 * other screen.
 *
 * The address is the customer's company record, which is the only address this
 * platform keeps — but it is *copied onto the sale*, not joined to at reporting
 * time, and those are different things. A join drops a consumer, because a
 * consumer is a person with no company; it also re-reads a country that may
 * have been edited since, so a filed quarter could change underneath a return
 * that has already been submitted. A copy does neither.
 *
 * Nothing is written when there is no country to write. A sale nobody can
 * place is reported as exactly that, with its figures beside it — inventing
 * the seller's own country here would put a cross-border supply on a domestic
 * return and never be noticed.
 */
async function placeFromCustomer(
  orgId: string,
  source: string,
  documentId: string,
  tx?: DbTx,
): Promise<void> {
  const [buyer] = await (tx ?? db)
    .select({
      country: schema.companies.country,
      region: schema.companies.state,
      taxIdentifier: schema.companies.taxIdentifier,
      taxIdentifierValid: schema.companies.taxIdentifierValid,
    })
    .from(schema.invoices)
    // Left, every time. An inner join here would silently record nothing for
    // exactly the customer this exists to reach.
    .leftJoin(
      schema.contacts,
      and(
        eq(schema.invoices.contactId, schema.contacts.id),
        eq(schema.contacts.organizationId, orgId),
      ),
    )
    .leftJoin(
      schema.companies,
      and(
        eq(schema.contacts.companyId, schema.companies.id),
        eq(schema.companies.organizationId, orgId),
      ),
    )
    .where(
      and(
        eq(schema.invoices.organizationId, orgId),
        eq(schema.invoices.id, documentId),
      ),
    )
    .limit(1);

  const country = buyer?.country?.trim();
  if (!country) return;
  await recordSalePlace(
    orgId,
    source,
    {
      country,
      region: buyer?.region,
      basis: "customer-address",
      evidence: [
        { kind: "customer-address", country, region: buyer?.region ?? null },
      ],
      documentId,
      customerTaxId: buyer?.taxIdentifier,
      customerTaxIdValid: buyer?.taxIdentifierValid,
    },
    tx,
  );
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
  /**
   * The transaction the document itself was written in.
   *
   * An invoice row saying `open` and no entry behind it is revenue on a
   * document and nowhere in the books — and it is reachable, because posting
   * refuses a date inside a closed period and every one of these callers
   * accepts a back-dated issue date. The two go in one commit or neither does.
   */
  options?: PostOptions,
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
      ...(tax > 0
        ? (
            await taxShares(
              orgId,
              invoice.id,
              tax,
              rate,
              taxPayable,
              options?.tx,
            )
          ).map((share) => ({
            accountId: share.accountId,
            creditCents: share.cents,
          }))
        : []),
    ],
    postedAt,
    options,
  );
  await placeFromCustomer(
    orgId,
    `invoice:${invoice.id}`,
    invoice.id,
    options?.tx,
  );
}

/**
 * The entry a credit note makes: the sale's entry with its sides swapped.
 *
 * Dr Income for the net, Dr each tax band's liability account for its share,
 * Cr Accounts Receivable for the whole — read from the credit note's own
 * frozen bands through the same split as the sale, so a document that unwinds
 * a GST+PST stack or a lone US jurisdiction debits exactly the accounts the
 * sale credited. The version this replaced debited income for the gross
 * amount with no tax split at all, so a business that refunded a taxed sale
 * kept that sale's tax in every filing figure — the VAT return, the state
 * filing — and quietly over-paid its authority.
 */
export async function postCreditNoteIssued(
  orgId: string,
  note: {
    id: string;
    number: string;
    taxCents: number;
    totalCents: number;
    /** What the credited document's currency was worth when it was raised. */
    rateMicro?: number | null;
  },
  memo?: string,
  postedAt?: Date,
  /** The transaction the note itself was written in. See `postInvoiceIssued`. */
  options?: PostOptions,
): Promise<void> {
  const [ar, income, taxPayable] = await Promise.all([
    ensureAccount(orgId, CORE_ACCOUNTS.accountsReceivable),
    ensureAccount(orgId, CORE_ACCOUNTS.salesIncome),
    ensureAccount(orgId, CORE_ACCOUNTS.taxPayable),
  ]);

  const rate = note.rateMicro ?? RATE_SCALE;
  const credit = toBaseCents(note.totalCents, rate);
  const tax = toBaseCents(note.taxCents, rate);
  const net = credit - tax;

  await postJournalEntry(
    orgId,
    memo ?? `Credit note ${note.number}`,
    `credit-note:${note.id}`,
    [
      ...(net > 0 ? [{ accountId: income, debitCents: net }] : []),
      ...(tax > 0
        ? (
            await taxShares(orgId, note.id, tax, rate, taxPayable, options?.tx)
          ).map((share) => ({
            accountId: share.accountId,
            debitCents: share.cents,
          }))
        : []),
      { accountId: ar, creditCents: credit },
    ],
    postedAt,
    options,
  );
  await placeFromCustomer(
    orgId,
    `credit-note:${note.id}`,
    note.id,
    options?.tx,
  );
}

/**
 * The tax side of a document, split by band: one amount, or one per tax.
 *
 * Side-agnostic on purpose — an invoice credits these accounts and a credit
 * note debits the very same ones, and two copies of this split would be two
 * chances for them to disagree about which account a filing reads.
 *
 * A document that charges a single tax posts to Tax Payable ("2200") exactly
 * as it always has — the UK VAT return reads that account by code, and moving
 * a lone VAT credit elsewhere would empty box 1 of every return. The split
 * exists for the document that charges two: Canada's GST beside a PST is owed
 * to two authorities, and one liability figure for both is a number neither
 * filing can use. Each definition gets its own liability account, made on
 * first use and found again by a code derived from the definition's id — the
 * id rather than the name, because renaming "PST 7%" must not strand its
 * balance in an account nobody posts to any more.
 *
 * A US or Canadian definition splits even when it stands alone. A business
 * collecting for Texas on one invoice and for Ohio on the next owes two
 * authorities from two documents, and a shared account cannot say which —
 * the filing figure for each state has to be readable off its own ledger
 * account, not recomputed from documents. Canada is the same fact in
 * federal clothing: an Alberta sale carries GST alone, but the GST/HST
 * return reads the CRA's figure off the definition's own account, and a
 * lone GST credit parked on the shared account would fall out of it. Only
 * definitions whose regime is "us" or "ca" behave this way, so a lone UK
 * or EU VAT credit stays on "2200" and every existing return keeps reading
 * the account it always has.
 */
async function taxShares(
  orgId: string,
  documentId: string,
  taxBase: number,
  rateMicro: number,
  taxPayable: string,
  /**
   * Where to read the bands from.
   *
   * The caller may have written them in a transaction that has not committed
   * — converting a quote does exactly that — and bands read on another
   * connection would come back empty, sending a split document's whole tax to
   * the shared account instead of the authorities' own.
   */
  conn: LedgerTx | typeof db = db,
): Promise<{ accountId: string; cents: number }[]> {
  const bands = await conn
    .select({
      taxDefinitionId: schema.documentTaxes.taxDefinitionId,
      name: schema.documentTaxes.name,
      taxCents: schema.documentTaxes.taxCents,
      regime: schema.taxDefinitions.regime,
    })
    .from(schema.documentTaxes)
    .leftJoin(
      schema.taxDefinitions,
      eq(schema.documentTaxes.taxDefinitionId, schema.taxDefinitions.id),
    )
    .where(
      and(
        eq(schema.documentTaxes.organizationId, orgId),
        eq(schema.documentTaxes.documentType, "invoice"),
        eq(schema.documentTaxes.documentId, documentId),
      ),
    );

  const named = new Set(
    bands.map((b) => b.taxDefinitionId).filter((id) => id !== null),
  );
  const splitsAlone = bands.some((b) => b.regime === "us" || b.regime === "ca");
  if (named.size < 2 && !splitsAlone) {
    return [{ accountId: taxPayable, cents: taxBase }];
  }

  /**
   * Each band converted on its own, and the conversion's spare cent given to
   * the largest, so the shares still sum to exactly the tax inside the
   * entry — a split that does not balance is a split that throws.
   */
  const shares: { accountId: string; cents: number }[] = [];
  for (const band of bands) {
    if (band.taxCents === 0) continue;
    const accountId = band.taxDefinitionId
      ? await ensureAccount(orgId, {
          code: `2200-${band.taxDefinitionId.slice(0, 8)}`,
          name: `Tax Payable — ${band.name}`,
          type: "liability",
        })
      : taxPayable;
    shares.push({
      accountId,
      cents: toBaseCents(band.taxCents, rateMicro),
    });
  }
  if (shares.length === 0) {
    return [{ accountId: taxPayable, cents: taxBase }];
  }
  const drift = taxBase - shares.reduce((sum, s) => sum + s.cents, 0);
  if (drift !== 0) {
    let biggest = shares[0] as { cents: number };
    for (const share of shares) {
      if (share.cents > biggest.cents) biggest = share;
    }
    biggest.cents += drift;
  }
  return shares;
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

/**
 * Postgres rejects a malformed uuid with an error rather than an empty
 * result, so an id typed into a URL by hand would otherwise be a 500 rather
 * than the 404 it is. Private: the shape check callers reach for lives with
 * the modules; this one only protects the queries below.
 */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

/** An id the caller supplied, confirmed to belong to this business. */
export async function ownedAccount(
  orgId: string,
  accountId: string,
): Promise<boolean> {
  if (!isUuid(String(accountId))) return false;
  const [row] = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.id, String(accountId)),
        eq(schema.accounts.organizationId, orgId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * A contact id the caller supplied, confirmed to belong to this business.
 *
 * Same shape as `ownedAccount`, for the same reason: a document naming a
 * contact must name one of this organisation's, or a guessed id reads —
 * and mails — another business's customer.
 */
export async function ownedContact(
  orgId: string,
  contactId: string,
): Promise<boolean> {
  if (!isUuid(String(contactId))) return false;
  const [row] = await db
    .select({ id: schema.contacts.id })
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.id, String(contactId)),
        eq(schema.contacts.organizationId, orgId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

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
    .where(ledgerWhere(orgId, period));
}

/**
 * What per-account arithmetic needs of the ledger: one line, or a group of
 * lines already added up.
 *
 * `totalsByAccount` and the statements built on it read these six fields and
 * do nothing to them but add — so a row that is already the sum of a million
 * lines answers them with the same figure the million lines would. That is
 * what lets `ledgerTotals` stand in for `ledgerRows` without moving a cent.
 */
export type LedgerAmounts = Pick<
  LedgerRow,
  "accountId" | "code" | "name" | "type" | "debitCents" | "creditCents"
>;

/**
 * The same ledger, added up by the database instead of by the application.
 *
 * `ledgerRows` is the honest reader and the wrong one for a report: five years
 * of a busy business is 1,192,886 lines, and a statement over them is
 * 1,192,886 JavaScript objects built to produce twelve numbers. Measured end
 * to end on exactly that: a profit and loss over five years took 2,939 ms and
 * 3.5 GB of resident memory, a balance sheet 2,053 ms and 4.0 GB. Grouping in
 * the database makes them 138 ms and 134 ms, in 267 MB — which is the whole of
 * why a self-hosted instance needed 8 GB to print a statement.
 *
 * The grouping is the whole of the change. Identical filters — same join, same
 * period, the same `organizationId` on both sides — so the figures are the
 * ones `ledgerRows` would have produced, arriving as one row per account.
 *
 * `ledgerRows` stays, for the readers that genuinely need lines: the cash
 * basis walks entry by entry, and a drill-down is a list of lines by
 * definition.
 */
export async function ledgerTotals(
  orgId: string,
  period: {
    from?: Date;
    to?: Date;
    classId?: string;
    locationId?: string;
  } = {},
): Promise<LedgerAmounts[]> {
  return (
    db
      .select({
        accountId: schema.accounts.id,
        code: schema.accounts.code,
        name: schema.accounts.name,
        type: schema.accounts.type,
        /**
         * `bigint`, not `int`. A five-year sum of debits on the bank account
         * passes 2^31 cents — $21.5m — at which point a 32-bit cast stops
         * answering and starts throwing, which is the same defect that killed
         * the invoice list. `sumCents` refuses above 2^53 rather than rounding.
         */
        debitCents: sumCents(schema.journalLines.debitCents),
        creditCents: sumCents(schema.journalLines.creditCents),
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
      .where(ledgerWhere(orgId, period))
      // The account's primary key: its code, name and type follow from it.
      .groupBy(schema.accounts.id)
  );
}

/**
 * The filter both readers share, written once.
 *
 * Deliberately not duplicated. The two have to select the same lines or a
 * report and its drill-down disagree, and the org filter is the one that must
 * never drift: a faster query that reaches another business's entries is not
 * a faster query.
 */
function ledgerWhere(
  orgId: string,
  period: {
    from?: Date;
    to?: Date;
    classId?: string;
    locationId?: string;
  },
) {
  return and(
    eq(schema.journalEntries.organizationId, orgId),
    // Both sides are scoped: a line joined to an account belonging to
    // another business would be somebody else's figure in these totals.
    eq(schema.accounts.organizationId, orgId),
    ...(period.from ? [gte(schema.journalEntries.postedAt, period.from)] : []),
    ...(period.to ? [lte(schema.journalEntries.postedAt, period.to)] : []),
    ...(period.classId
      ? [eq(schema.journalLines.classId, period.classId)]
      : []),
    ...(period.locationId
      ? [eq(schema.journalLines.locationId, period.locationId)]
      : []),
  );
}

/**
 * A line as a cash-basis read of the books sees it.
 *
 * Eight fields rather than a `LedgerRow`'s ten: the conversion never looks at
 * a class or a location, and a row it cannot see is a column that need not
 * cross the wire a million times.
 */
export type CashBasisLine = Pick<
  LedgerRow,
  | "entryId"
  | "accountId"
  | "code"
  | "name"
  | "type"
  | "debitCents"
  | "creditCents"
  | "postedAt"
>;

/** One posted entry, with the lines a cash-basis read can see. */
export interface CashBasisEntry {
  id: string;
  postedAt: Date;
  rows: CashBasisLine[];
}

/**
 * The two control accounts a receivable or a payable is held in, by code.
 *
 * Read from `CORE_ACCOUNTS` rather than written out again, because the
 * conversion that walks these entries matches on the same codes: two lists
 * that must agree and are maintained apart eventually do not, and the symptom
 * would be a report that silently stopped seeing invoices.
 */
const CONTROL_CODES = [
  CORE_ACCOUNTS.accountsReceivable.code,
  CORE_ACCOUNTS.accountsPayable.code,
];

/**
 * Every line a cash-basis read can possibly use: income, expense, the two
 * control accounts and the tax account the VAT return takes its boxes from.
 *
 * A payment entry is a debit to the bank and a credit to the receivable, and
 * only the second of those means anything to this conversion — the bank line
 * is never pooled, never recognised and never named in the output. Five years
 * of the measured business is 1,192,886 lines and 714,776 of them are one of
 * these, so the filter is worth its clause.
 *
 * The tax account only when somebody asked for it. A VAT return needs those
 * lines; a profit and loss has no use for them at all — the tax an invoice
 * carries waits in a pool of its own and is emitted to a collector only the
 * return passes. Leaving them where they are takes another 236,577 lines off
 * the same read.
 */
/**
 * The lines, in the order the conversion has to see them.
 *
 * `postedAt` then `id`, which is what the in-memory walk sorted by, so the
 * streamed read visits entries in exactly the order the array read did. A uuid
 * sorts the same way in Postgres as its canonical text does in JavaScript, so
 * the tie-break agrees too — and it only ever decides between two entries
 * posted on the same instant.
 *
 * Aliased column by column because these rows are read straight off the
 * driver rather than through Drizzle's own mapper: `accounts.id` and
 * `journal_entries.id` are both called `id` on the wire otherwise, and the
 * second would quietly overwrite the first.
 */
function cashBasisQuery(
  orgId: string,
  tax: boolean,
  ...extra: (SQL | undefined)[]
) {
  return db
    .select({
      entryId: sql<string>`${schema.journalEntries.id}`.as("entryId"),
      accountId: sql<string>`${schema.accounts.id}`.as("accountId"),
      code: sql<string>`${schema.accounts.code}`.as("code"),
      name: sql<string>`${schema.accounts.name}`.as("name"),
      type: sql<string>`${schema.accounts.type}`.as("type"),
      debitCents: sql<number>`${schema.journalLines.debitCents}`.as(
        "debitCents",
      ),
      creditCents: sql<number>`${schema.journalLines.creditCents}`.as(
        "creditCents",
      ),
      /**
       * The instant as milliseconds, not as a timestamp.
       *
       * These rows are read straight off the driver, which hands a
       * `timestamptz` back as whatever text the session's time zone renders —
       * `2021-09-20 07:50:28.013626`, with no offset on it at all. Parsing
       * that in JavaScript reads it as local time, which on a machine an hour
       * off UTC puts a settlement in the wrong month at the ends of a period.
       * An epoch is an absolute instant with no time zone in it to get wrong,
       * and `floor` to milliseconds is exactly what a `Date` holds anyway.
       */
      postedAtMs:
        sql<number>`floor(extract(epoch from ${schema.journalEntries.postedAt}) * 1000)::float8`.as(
          "postedAtMs",
        ),
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
        // Both sides, exactly as `ledgerWhere` scopes them. A cheaper read
        // that reaches another business's entries is not a cheaper read.
        eq(schema.journalEntries.organizationId, orgId),
        eq(schema.accounts.organizationId, orgId),
        or(
          inArray(schema.accounts.type, ["income", "expense"]),
          inArray(schema.accounts.code, CONTROL_CODES),
          // The tax account and every authority's own, when a return asked
          // for them: narrowing to the bare "2200" left a split document's
          // tax out of the read altogether.
          ...(tax ? [taxPayableCodeMatch(schema.accounts.code)] : []),
        ),
        ...extra,
      ),
    )
    .orderBy(
      asc(schema.journalEntries.postedAt),
      asc(schema.journalEntries.id),
    );
}

/** Whether an entry grew or settled a receivable or a payable. */
function touchesControl(orgId: string) {
  const line = alias(schema.journalLines, "control_line");
  const account = alias(schema.accounts, "control_account");
  return exists(
    db
      .select({ one: sql`1` })
      .from(line)
      .innerJoin(account, eq(line.accountId, account.id))
      .where(
        and(
          eq(line.entryId, schema.journalEntries.id),
          eq(account.organizationId, orgId),
          inArray(account.code, CONTROL_CODES),
        ),
      ),
  );
}

/**
 * The entries a cash-basis report has to walk, streamed, oldest first.
 *
 * **This one cannot be a `group by`, and that is a property of the question
 * rather than of the code.** Accrual figures are a sum over a period, so the
 * database can add them up; cash figures are what a sequence of settlements
 * recognised out of a pool of unpaid work, which depends on every settlement
 * before it. An invoice for 1,200 holding 1,000 of income and 200 of tax,
 * half-paid twice and then credited, recognises different amounts in each
 * period depending on what had already come out — there is no grouping of the
 * ledger that produces that, only a walk of it in order.
 *
 * So the walk stays and is bounded instead, three ways:
 *
 * - **Only the lines it can read.** 1,192,886 lines become 714,776.
 * - **Nothing after the period.** An entry posted after `to` can recognise
 *   nothing inside it and is never looked at again, so it is not read.
 * - **Before the period, only what builds the opening position.** An entry
 *   older than `from` matters solely through the receivable or payable it
 *   left behind; one that touched neither recognised its money the day it was
 *   posted and has nothing to carry forward. A year's report on five years of
 *   trading reads 3,708 lines rather than 1,192,886.
 *
 * And it is a cursor, so what the process holds is one chunk and the pools,
 * not the history. Measured on the five-year dataset: an all-time read is
 * 1,497 ms in 141 MB of resident memory, against 1,866 ms and gigabytes for
 * the array it replaces — and unlike the array it does not grow with the part
 * of the history the report was never asked about.
 */
export async function* cashBasisEntries(
  orgId: string,
  period: { from?: Date; to?: Date } = {},
  /** Whether the reader is going to look at the tax lines. */
  options: { tax?: boolean; chunkRows?: number } = {},
): AsyncGenerator<CashBasisEntry> {
  const tax = options.tax ?? false;
  const chunkRows = options.chunkRows ?? 5000;
  /*
   * Two statements rather than one with an `or` across them. The opening
   * position and the period are disjoint by date, so nothing is read twice —
   * and a single query would have to test "is this entry before the period
   * and does it touch a control account" for every row in the period as well,
   * which measured a full second slower over five years than reading them
   * apart.
   */
  if (period.from) {
    yield* streamEntries(
      cashBasisQuery(
        orgId,
        tax,
        lt(schema.journalEntries.postedAt, period.from),
        touchesControl(orgId),
      ),
      chunkRows,
    );
  }
  yield* streamEntries(
    cashBasisQuery(
      orgId,
      tax,
      period.from
        ? gte(schema.journalEntries.postedAt, period.from)
        : undefined,
      period.to ? lte(schema.journalEntries.postedAt, period.to) : undefined,
    ),
    chunkRows,
  );
}

/**
 * One query, read through a server-side cursor and grouped back into entries.
 *
 * The query is built by Drizzle and handed to the driver as text and
 * parameters, so there is one definition of the filter — including the two
 * organization clauses — rather than a second copy written out by hand for
 * the sake of streaming.
 *
 * Rows arrive ordered by entry, so an entry is complete the moment a row with
 * a different id shows up. The chunk is large enough that no entry is ever
 * split across two of them in practice, and it would not matter if one were:
 * the grouping spans chunks.
 */
async function* streamEntries(
  query: ReturnType<typeof cashBasisQuery>,
  chunkRows: number,
): AsyncGenerator<CashBasisEntry> {
  const { sql: text, params } = query.toSQL();
  const client = db.$client as unknown as {
    unsafe: (
      text: string,
      params: unknown[],
    ) => {
      cursor: (
        size: number,
      ) => AsyncIterable<
        (Omit<CashBasisLine, "postedAt"> & { postedAtMs: number })[]
      >;
    };
  };

  let current: CashBasisEntry | null = null;
  for await (const rows of client.unsafe(text, params).cursor(chunkRows)) {
    for (const { postedAtMs, ...rest } of rows) {
      const postedAt = new Date(postedAtMs);
      if (current && current.id !== rest.entryId) {
        yield current;
        current = null;
      }
      if (!current) current = { id: rest.entryId, postedAt, rows: [] };
      current.rows.push({ ...rest, postedAt });
    }
  }
  if (current) yield current;
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
  rows: LedgerAmounts[],
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
