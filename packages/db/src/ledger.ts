import type { CustomField } from "@sentrello/module-sdk/custom-fields";
import { coerceCustomValues } from "@sentrello/module-sdk/custom-fields";
import { and, eq, gte, lte } from "drizzle-orm";
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
