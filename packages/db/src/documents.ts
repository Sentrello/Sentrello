import {
  type SQL,
  and,
  eq,
  inArray,
  isNull,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type DbTx, db } from "./client";
import { baseCurrency, rateOn } from "./currency";
import { dayIn, dayOf } from "./day";
import { postInvoiceIssued } from "./ledger";
import { MoneyError, bpToPpm, documentTotals, sumCents } from "./money";
import { nextDocumentNumber } from "./numbering";
import * as schema from "./schema";
import { demandDay, timezoneFor } from "./timezone";

/**
 * A quote becomes an invoice.
 *
 * Lifted out of the invoicing route because a second caller arrived: Make
 * Deal converts a quote the moment a customer accepts it. A flow that
 * reimplemented this would be a second place deciding what an invoice costs
 * and whether it reached the books.
 *
 * It sits in the shared data layer rather than in the invoicing module so that
 * a commercial module can drive it without importing a Free one — every module
 * already has this package, and none of them has each other.
 *
 * Returns null when the quote is not this organization's, so the caller
 * answers 404 rather than leaking whether an id exists.
 */
/**
 * When an invoice falls due, counting from a day.
 *
 * An invoice with no due date can never be late: it sits outside every aging
 * bucket, the overdue chase skips it, and it never reaches the dashboard's
 * overdue figure. So one is always chosen.
 *
 * Thirty days is only the fallback. How long a customer actually has is
 * `defaultDueDays` on the organization's invoicing settings — use
 * `defaultDueDateFor`, which reads it. This function exists for the arithmetic
 * and for tests.
 */
export function defaultDueDate(
  from = new Date(),
  days = DEFAULT_DUE_DAYS,
): Date {
  // A date, not an instant: midnight UTC, that many days on. Every due date a
  // person types is stored that way, and one carrying a time of day renders in
  // the reader's own zone — so the same invoice could be due on two different
  // days depending on who was looking at it.
  return new Date(dayOf(from).getTime() + days * 24 * 60 * 60 * 1000);
}

/** What a business gets when it has never said. Mirrors the column default. */
export const DEFAULT_DUE_DAYS = 30;

/**
 * The same thing, for a business that said how long its customers get.
 *
 * `defaultDueDays` has been a column on `invoicing_settings` since the module
 * was written, settable through the settings route, validated to 0–365 — and
 * read by nothing. Every invoice raised without a typed due date fell due in
 * thirty days, whatever a business had set, and the form said "thirty days" as
 * though that were the rule rather than one business's answer.
 *
 * And it counts from the day where the business is, not where the server is.
 * `dayOf(new Date())` in Denver at seven in the evening is already tomorrow in
 * UTC, so net-30 arrived on day 31 for half of every afternoon.
 */
export async function defaultDueDateFor(
  organizationId: string,
  from = new Date(),
): Promise<Date> {
  return (await invoiceDefaultsFor(organizationId, from)).dueDate;
}

/**
 * Both of the things a business decides once and every invoice inherits.
 *
 * `defaultPaymentTerms` had the same shape as the due days: a column whose own
 * comment said "printed at the foot of every document that does not override
 * it", a box on the settings panel that saved it, and no document that ever
 * read it. Terms were printed from `invoices.paymentTerms` with no fallback, so
 * a business that set its terms in one place saw them in that one place.
 *
 * Applied at creation rather than at render, because an invoice is a record of
 * what was agreed. Change the terms in settings next March and the invoice you
 * sent in January must still say what it said in January.
 */
export async function invoiceDefaultsFor(
  organizationId: string,
  from = new Date(),
  /** A transaction the caller holds, so the read takes no second connection. */
  conn: Pick<typeof db, "select"> = db,
): Promise<{ dueDate: Date; paymentTerms: string | null }> {
  const [settings] = await conn
    .select({
      days: schema.invoicingSettings.defaultDueDays,
      terms: schema.invoicingSettings.defaultPaymentTerms,
    })
    .from(schema.invoicingSettings)
    .where(eq(schema.invoicingSettings.organizationId, organizationId))
    .limit(1);
  return {
    dueDate: defaultDueDate(
      dayIn(from, await timezoneFor(organizationId, conn)),
      settings?.days ?? DEFAULT_DUE_DAYS,
    ),
    paymentTerms: settings?.terms?.trim() || null,
  };
}

/**
 * A quote that was converted by somebody else while this one was working.
 *
 * Private to this file: it exists to roll a transaction back, and the caller
 * sees the `null` this function has always answered with. Not an error anybody
 * should have to handle.
 */
class AlreadyConverted extends Error {}

export async function convertQuoteToInvoice(
  organizationId: string,
  quoteId: string,
): Promise<typeof schema.invoices.$inferSelect | null> {
  const [quote] = await db
    .select()
    .from(schema.quotes)
    .where(
      and(
        eq(schema.quotes.id, quoteId),
        eq(schema.quotes.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!quote) return null;

  /**
   * Once, and only once.
   *
   * A quote that has already become an invoice must not become a second one:
   * that is two bills for the same work, two journal entries for the same
   * revenue, and a customer who has to be talked down. The check is here
   * rather than in the route because two routes convert — the staff screen
   * and the customer accepting it in their own portal — and only one of them
   * would have been guarded.
   */
  if (quote.convertedInvoiceId) return null;

  /**
   * What the quote's currency is worth on the day the invoice is raised.
   *
   * The same omission `copyInvoice` had, with the same consequence: nothing
   * set `rateMicro`, so an accepted euro quote became an invoice at the column
   * default of 1:1 and posted euro cents into dollar books — and this path
   * posts immediately, so the wrong figure is in the ledger before anybody
   * opens the document. Derived at today's date rather than the quote's,
   * because the invoice is raised now and the money will be received at now's
   * rate; refused rather than guessed, as everywhere else that raises one.
   */
  const rateMicro = await rateOn(organizationId, quote.currency, new Date());
  if (rateMicro === null) {
    throw new MoneyError(
      `no exchange rate recorded for ${quote.currency} — record one under Money, in Tax and currency, first`,
    );
  }

  const lines = await db
    .select()
    .from(schema.quoteLines)
    .where(eq(schema.quoteLines.quoteId, quoteId));

  const invoice = await convertInside(
    organizationId,
    quote,
    quoteId,
    lines,
    rateMicro,
  ).catch((err) => {
    if (err instanceof AlreadyConverted) return null;
    throw err;
  });
  return invoice;
}

async function convertInside(
  organizationId: string,
  quote: typeof schema.quotes.$inferSelect,
  quoteId: string,
  lines: (typeof schema.quoteLines.$inferSelect)[],
  rateMicro: number,
) {
  // Read before the transaction: each is a pool connection of its own, and
  // wanted while holding the document counter they froze the pool when ten
  // conversions arrived at once.
  const fromSettings = await invoiceDefaultsFor(organizationId);
  const issuedOn = dayIn(new Date(), await timezoneFor(organizationId));
  const invoice = await db.transaction(async (tx) => {
    const [inv] = await tx
      .insert(schema.invoices)
      .values({
        organizationId,
        contactId: quote.contactId,
        quoteId: quote.id,
        currency: quote.currency,
        rateMicro,
        number: await nextDocumentNumber(tx, organizationId, "invoice"),
        status: "open",
        // The day the invoice is raised, where the business is — not the instant
        // the row was written, which the column default would have stored.
        issueDate: issuedOn,
        // The letterhead the customer was quoted on, so the invoice for the
        // same work does not arrive looking like it came from somewhere else.
        templateId: quote.templateId,
        // Gross-quoted or net-quoted travels with the document. The customer
        // accepted the figure on the quote, and the invoice states it the
        // same way round.
        pricesIncludeTax: quote.pricesIncludeTax,
        // Without this, converting a quote produced an invoice that could
        // never be chased. The portal's own acceptance path set one; this one
        // did not, so which screen accepted the work decided whether the
        // business would ever be reminded to ask for the money.
        dueDate: fromSettings.dueDate,
        // A quote has no terms column, so the business's own are what an invoice
        // raised from one goes out on.
        paymentTerms: fromSettings.paymentTerms,
        subtotalCents: quote.subtotalCents,
        discountType: quote.discountType,
        discountValue: quote.discountValue,
        discountCents: quote.discountCents,
        taxCents: quote.taxCents,
        totalCents: quote.totalCents,
        notes: quote.notes,
      })
      .returning();
    if (!inv) throw new Error("invoice insert returned no row");
    if (lines.length > 0) {
      await tx.insert(schema.invoiceLines).values(
        // Everything the line carried, not a subset: dropping the unit or
        // the fractional quantity here turns "2.5 hours" into "2 pieces" on
        // the document the customer is actually asked to pay.
        lines.map(({ id: _id, quoteId: _quoteId, ...rest }) => ({
          ...rest,
          invoiceId: inv.id,
        })),
      );
    }
    /**
     * The tax bands travel with it.
     *
     * The quote was banded when it was written; recomputing on the invoice
     * would give the same answer today and a different one after a rate
     * changes — and the customer agreed to the figure on the quote.
     */
    const bands = await tx
      .select()
      .from(schema.documentTaxes)
      .where(
        and(
          eq(schema.documentTaxes.documentType, "quote"),
          eq(schema.documentTaxes.documentId, quoteId),
        ),
      );
    if (bands.length > 0) {
      await tx.insert(schema.documentTaxes).values(
        bands.map(({ id: _id, ...band }) => ({
          ...band,
          documentType: "invoice",
          documentId: inv.id,
        })),
      );
    }

    /*
     * What it became, so it cannot become a second one — and the `is null` is
     * what makes that true rather than intended.
     *
     * The check at the top of this function is a read, and this wrote on
     * `quoteId` alone, so two conversions arriving together both passed it and
     * both got here: two invoices for one quote, two journal entries for the
     * same revenue, and a customer who has to be talked down. The same shape as
     * issuing a draft, where five requests put five entries and five times the
     * money in the books — measured on a running instance.
     *
     * Throwing rather than returning, because the invoice is already inserted
     * above: only a rollback takes it back out. `AlreadyConverted` is caught
     * outside the transaction and becomes the `null` this function has always
     * answered with, so both routes that convert behave exactly as before.
     */
    const marked = await tx
      .update(schema.quotes)
      .set({
        status: "accepted",
        convertedInvoiceId: inv.id,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.quotes.id, quoteId),
          isNull(schema.quotes.convertedInvoiceId),
        ),
      )
      .returning({ id: schema.quotes.id });
    if (marked.length === 0) throw new AlreadyConverted();

    /*
     * An invoice from an accepted quote is an invoice: it posts the same entry
     * as one raised directly, or the revenue exists on the invoice and nowhere
     * in the books. Inside this transaction, so a posting that is refused
     * takes the invoice and the quote's acceptance back with it — and so the
     * tax bands written a few lines above are visible to the split that reads
     * them.
     */
    await postInvoiceIssued(organizationId, inv, undefined, undefined, { tx });
    return inv;
  });
  return invoice;
}

/**
 * One invoice copied into another.
 *
 * Two callers want this and they are in different packages: the Duplicate
 * button in the invoicing module, and the recurring job, which raises this
 * month's invoice from a template invoice a person can actually open and
 * correct. Written once here, because a copy that drops a field is a document
 * that asks the customer for a different amount than the one it was copied
 * from — and the two callers would drop different fields.
 *
 * **What a copy carries is decided here and nowhere else.** The rule is that a
 * copy carries everything that makes the original correct, re-derives what
 * belongs to the new document's own date, and carries nothing that is a fact
 * about the original rather than about the sale. Written out because the
 * alternative is what happened: fields omitted by accident, differently, in
 * each caller, and nobody able to say which omissions were meant.
 *
 * **Carried.** The customer, the currency, the notes and payment terms, the
 * template, whether the prices quoted include tax, every discount *term*, the
 * totals, and the lines with their unit, fractional quantity and tax rate. The
 * stored tax bands travel rather than being recomputed — the bands are what the
 * document was taxed at, and recomputing gives a different answer the day after
 * a rate changes. `buyerReference` travels because it is the customer's own
 * reference and an invoice without it is one their accounts department cannot
 * match. The early-payment terms travel because they are an offer this business
 * makes to this customer, not something that happened once.
 *
 * `exemptionCertificateId` travels only while the customer does. It is why this
 * document carries no tax, and the certificate belongs to one buyer — carrying
 * it onto a copy addressed to somebody else would justify a zero-rating with a
 * stranger's paperwork.
 *
 * **Re-derived: the exchange rate.** `rateMicro` was never set at all, so every
 * copy took the column default of 1:1 and a euro invoice went into the books at
 * face value. Unattended, monthly, in the recurring path, with nobody looking.
 * It is re-derived at the copy's own issue date rather than inherited, because
 * a copy is a *new sale*, and money invoiced this month will be received at
 * this month's rate — inheriting would post January's rate for December's
 * invoice, which is the same defect moving more slowly. A credit note is the
 * opposite case and stays the opposite case: it unwinds a specific sale at the
 * rate that sale was booked at, and it says so where it is written.
 *
 * Refused rather than guessed when the business has never priced the currency —
 * the same refusal `raiseInvoice` and the invoice screen make. A caller that
 * has already looked the rate up passes it as `rateMicro` and no second lookup
 * happens.
 *
 * **Deliberately not carried**, each because it is a fact about the original
 * document and not about the sale: the quote it came from, the share link and
 * everything the customer's viewing of it recorded, the reminders sent, any
 * late fee applied, the early-payment discount actually *taken*, and the
 * number, status and issue date, which every copy gets new.
 *
 * **Credit notes are refused.** A credit note credits one specific invoice, so
 * a copy of it would credit that invoice a second time. Copying one used to
 * produce a plain invoice — the `kind` was dropped and the column default took
 * over — which is a document changing what it is on the way through.
 *
 * **A caller may lend it their transaction.** A copy raised as `open` is a
 * sale, and a sale has to reach the books or it has not happened: the recurring
 * run copies the template, commits, and only then posts the entry, so a period
 * closed between the two leaves an open invoice owed by a customer with no
 * receivable anywhere in the ledger — and nothing says so. Passing `tx` puts
 * the copy and its posting in one commit, which is the rule everywhere else
 * money is written: the document and the entry live or die together.
 */
export async function copyInvoice(
  organizationId: string,
  sourceInvoiceId: string,
  overrides: {
    status?: string;
    issueDate?: Date;
    dueDate?: Date | null;
    contactId?: string | null;
    /**
     * The rate the caller has already looked up for this copy's date.
     *
     * For the recurring run, which reads one rate for the whole batch. Absent,
     * the rate is read here for the copy's issue date.
     */
    rateMicro?: number;
    /**
     * The caller's transaction, when the copy has to commit with something
     * else — its ledger entry above all.
     */
    tx?: DbTx;
  } = {},
): Promise<typeof schema.invoices.$inferSelect | null> {
  const conn = overrides.tx ?? db;
  const [source] = await conn
    .select()
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.id, sourceInvoiceId),
        eq(schema.invoices.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!source) return null;
  if (source.kind !== "invoice") {
    throw new MoneyError(
      "a credit note cannot be copied — it credits one invoice, and a second copy would credit it twice",
    );
  }

  /*
   * A day, not the moment the copy was made.
   *
   * The issue date is printed on the document and decides which period its
   * journal entry lands in, so a copy raised at nine in the evening in New York
   * was dated the first of the next month in UTC — a sale booked into a month
   * the business had not traded in. The business's own day, and UTC when it has
   * not said where it is.
   */
  const issueDate =
    overrides.issueDate ??
    dayIn(new Date(), await timezoneFor(organizationId, overrides.tx));
  const rateMicro =
    overrides.rateMicro ??
    (await rateOn(organizationId, source.currency, issueDate, overrides.tx));
  if (rateMicro === null) {
    throw new MoneyError(
      `no exchange rate recorded for ${source.currency} — record one under Money, in Tax and currency, first`,
    );
  }

  const [lines, bands] = await Promise.all([
    conn
      .select()
      .from(schema.invoiceLines)
      .where(eq(schema.invoiceLines.invoiceId, source.id)),
    conn
      .select()
      .from(schema.documentTaxes)
      .where(
        and(
          eq(schema.documentTaxes.documentType, "invoice"),
          eq(schema.documentTaxes.documentId, source.id),
        ),
      ),
  ]);

  /*
   * The caller's transaction is used as it stands rather than nested inside a
   * second one: a savepoint here would let this half roll back while the
   * caller's half stood, which is the failure this option exists to remove.
   */
  const write = async (tx: DbTx) => {
    const [made] = await tx
      .insert(schema.invoices)
      .values({
        organizationId,
        contactId:
          overrides.contactId !== undefined
            ? overrides.contactId
            : source.contactId,
        currency: source.currency,
        rateMicro,
        number: await nextDocumentNumber(tx, organizationId, "invoice"),
        status: overrides.status ?? "draft",
        issueDate,
        dueDate:
          overrides.dueDate !== undefined ? overrides.dueDate : source.dueDate,
        notes: source.notes,
        paymentTerms: source.paymentTerms,
        buyerReference: source.buyerReference,
        templateId: source.templateId,
        // The offer, not what somebody once took: `earlyDiscountTakenCents`
        // is a settlement on the original and starts at nothing here.
        earlyDiscountType: source.earlyDiscountType,
        earlyDiscountValue: source.earlyDiscountValue,
        earlyDiscountDays: source.earlyDiscountDays,
        // Only while it is the same buyer's document.
        exemptionCertificateId:
          overrides.contactId !== undefined &&
          overrides.contactId !== source.contactId
            ? null
            : source.exemptionCertificateId,
        // A copy quotes the way its original did, or its gross unit prices
        // would be read back as net and the copy would ask for less.
        pricesIncludeTax: source.pricesIncludeTax,
        discountType: source.discountType,
        discountValue: source.discountValue,
        discountCents: source.discountCents,
        subtotalCents: source.subtotalCents,
        taxCents: source.taxCents,
        totalCents: source.totalCents,
      })
      .returning();
    if (!made) throw new Error("invoice copy returned no row");

    if (lines.length > 0) {
      await tx.insert(schema.invoiceLines).values(
        lines.map(({ id: _id, invoiceId: _invoiceId, ...rest }) => ({
          ...rest,
          invoiceId: made.id,
        })),
      );
    }
    if (bands.length > 0) {
      await tx.insert(schema.documentTaxes).values(
        bands.map(({ id: _id, ...band }) => ({
          ...band,
          documentId: made.id,
        })),
      );
    }
    return made;
  };
  return overrides.tx ? await write(overrides.tx) : await db.transaction(write);
}

/**
 * Whether this business quotes gross — the price list already contains the tax.
 *
 * How the UK and the EU quote, and not how the US does: a price list says £120
 * and the VAT is inside it, so £120 is what the customer pays.
 *
 * **The one implementation**, here rather than in Invoicing, because
 * `@sentrello/db` is underneath every module and three things outside Invoicing
 * need the answer: this file's raising door, Pro's recurring engine, and
 * whatever bills next. Invoicing re-exports it under its own name, so the
 * screens keep the import they had and there is still one function.
 *
 * Read when a document is made and then frozen onto it. Every later reading
 * asks the document rather than the setting, so a business that changes its
 * mind does not silently restate what it has already sent.
 *
 * Absent settings read as net, which is the US default and what every row
 * written before the setting existed meant.
 */
export async function quotesGross(
  organizationId: string,
  /** A transaction the caller holds, so the read takes no second connection. */
  conn: Pick<typeof db, "select"> = db,
): Promise<boolean> {
  const [row] = await conn
    .select({ pricesIncludeTax: schema.invoicingSettings.pricesIncludeTax })
    .from(schema.invoicingSettings)
    .where(eq(schema.invoicingSettings.organizationId, organizationId))
    .limit(1);
  return row?.pricesIncludeTax === true;
}

/**
 * An invoice raised by something that is not the invoicing screen.
 *
 * A booking that charges is the first caller. It exists because Invoicing owns
 * money on this platform — one place a card is taken, one answer to what was
 * earned — so a module that needs to charge raises a document Invoicing
 * understands rather than growing a checkout of its own.
 *
 * Deliberately small. It takes lines that have already been priced and does
 * the four things every raised invoice needs and that are easy to half-do: a
 * number from the shared sequence, the rate the document's currency was worth
 * today, the totals, and the entry in the books. What it does not do is decide
 * what anything costs — the caller knows that, and a shared function guessing
 * at prices is how two modules disagree about the same sale.
 *
 * **Whether the price already contains the tax is the business's answer, not
 * the caller's.** This read neither the setting nor wrote it onto the document,
 * so every invoice raised here was net-quoted: a UK business whose plan says
 * £120 including VAT billed £120 + £24, every month, to every subscriber, and
 * the document then agreed with itself because its own copy of the flag said
 * net too. Three callers, all of them billing a price somebody typed into a
 * plan or a service — a subscription, a mid-period change and an appointment —
 * and the US is the one market where the default was right. Read once here and
 * frozen onto the row, which is exactly what the invoicing screen does with it.
 */
export async function raiseInvoice(
  organizationId: string,
  input: {
    contactId: string | null;
    currency?: string;
    /**
     * The day the document is dated, and its journal entry with it: a
     * `YYYY-MM-DD`, or a day as this platform stores one (midnight UTC).
     *
     * For a period billed after the fact — March's renewal is March's,
     * whenever the run got to it. Absent is today where the business is. A day
     * in a closed period is refused by the posting, exactly as the invoice
     * screen's back-dated issue is, and nothing is written; a day in the future
     * is refused as the screen refuses it. The exchange rate and the default
     * due date are read for this day rather than today.
     */
    issueDate?: Date | string;
    /** A day. Absent, the business's own terms counted from the issue date. */
    dueDate?: Date;
    notes?: string | null;
    lines: {
      description: string;
      quantity: number;
      unitPriceCents: number;
      /** Millionths — 99,750 is 9.975%. Wins when both rate fields are set. */
      taxRatePpm?: number;
      /** @deprecated Basis points, read as `bp × 100`. */
      taxRateBp?: number;
      taxDefinitionId?: string | null;
      /**
       * Every named tax on the line, in charging order — GST beside a PST or
       * QST, a state beside a city. Each is banded and posted to its own
       * authority's account. When present and non-empty it is the whole truth
       * and the three single-tax fields above are ignored, as the invoice
       * screen reads its own list. `ratePpm` absent means the definition's own
       * rate; whether a tax compounds is the definition's answer.
       */
      taxes?: { taxDefinitionId: string; ratePpm?: number }[];
      unit?: string;
    }[];
    /**
     * The caller's transaction, when the document has to commit with
     * something else.
     *
     * A billing run is the caller that needs it: the row that claims a period
     * and the invoice that pays for it have to land together, or a crash
     * between the two leaves a claim with no invoice and the next run bills
     * the month again. Same shape as `copyInvoice`, for the same reason.
     */
    tx?: DbTx;
  },
): Promise<typeof schema.invoices.$inferSelect | null> {
  if (input.lines.length === 0) return null;

  /*
   * The business's own money when the caller does not say.
   *
   * This read `?? "USD"`, and a caller that leaves the field off is the
   * normal case — a booking turning into an invoice says what was booked and
   * nothing about currency. On a GBP or EUR instance that fallback asked for
   * a dollar rate, no such rate is ever recorded on a business that does not
   * trade in dollars, and the refusal below fired: **booking could not raise
   * an invoice at all on three of our four markets.** Silent, too, until
   * somebody looked for the invoice that never appeared.
   *
   * Found 2026-09-28, in the same sweep as the invoice form, quotes and
   * subscriptions. Same fallback, four places, one shape of consequence.
   */
  /*
   * Every read below goes through the caller's transaction when it has one. A
   * billing run holds a lock in that transaction, and a read on the pool from
   * inside it is a second connection wanted while the first is held; enough of
   * those at once and nobody gets one.
   */
  const conn = input.tx ?? db;
  const currency = input.currency ?? (await baseCurrency(organizationId, conn));
  /**
   * Refused rather than guessed.
   *
   * Posting at 1:1 because nobody recorded a rate puts a plausible and wrong
   * number in the books, and nothing downstream ever questions it. The same
   * refusal the invoice screen and the recurring job make.
   */
  const zone = await timezoneFor(organizationId, conn);
  // A day, in the business's own zone. The column defaults to now(), and a
  // billing run at 02:00 UTC dated a New York business's invoices the evening
  // before.
  const today = dayIn(new Date(), zone);
  const issueDate =
    input.issueDate === undefined
      ? today
      : typeof input.issueDate === "string"
        ? demandDay(input.issueDate)
        : dayOf(input.issueDate);
  if (Number.isNaN(issueDate.getTime())) {
    throw new MoneyError("the issue date is not a real date");
  }
  // Revenue that has not happened yet — the same refusal as the screen's.
  if (issueDate.getTime() > today.getTime()) {
    throw new MoneyError(
      "an invoice cannot be issued with a date in the future",
    );
  }
  const backDated = issueDate.getTime() !== today.getTime();
  const rate = await rateOn(
    organizationId,
    currency,
    backDated ? issueDate : new Date(),
    conn,
  );
  if (rate === null) {
    throw new MoneyError(
      `no exchange rate recorded for ${currency} — record one under Money, in Tax and currency, first`,
    );
  }

  /*
   * The named rates, so the tax bands can be written the way the invoice
   * screen writes them.
   *
   * This wrote no bands at all, and the posting reads them to decide where the
   * tax goes: with none, every subscription, proration, usage and booking
   * invoice put US and Canadian tax on the shared 2200, and the returns read
   * only the per-authority accounts. So the tax was charged, collected and
   * missing from the return. A rate from another business is refused, as the
   * screen refuses it.
   */
  for (const [i, l] of input.lines.entries()) {
    const named = (l.taxes ?? []).map((t) => t.taxDefinitionId);
    if (named.some((id) => typeof id !== "string" || !id)) {
      throw new MoneyError(`line ${i + 1}: unreadable tax on the line`);
    }
    // Charging the same tax twice is a typo, not a stack — refused, as the
    // screen refuses it.
    if (new Set(named).size !== named.length) {
      throw new MoneyError(`line ${i + 1}: the same tax is on the line twice`);
    }
  }
  const ids = [
    ...new Set(
      input.lines
        .flatMap((l) =>
          l.taxes?.length
            ? l.taxes.map((t) => t.taxDefinitionId)
            : [l.taxDefinitionId],
        )
        .filter((id): id is string => !!id),
    ),
  ];
  const definitions = new Map(
    (ids.length === 0
      ? []
      : await (input.tx ?? db)
          .select({
            id: schema.taxDefinitions.id,
            name: schema.taxDefinitions.name,
            categoryCode: schema.taxDefinitions.categoryCode,
            ratePpm: schema.taxDefinitions.ratePpm,
            rateBp: schema.taxDefinitions.rateBp,
            compound: schema.taxDefinitions.compound,
          })
          .from(schema.taxDefinitions)
          .where(
            and(
              eq(schema.taxDefinitions.organizationId, organizationId),
              inArray(schema.taxDefinitions.id, ids),
            ),
          )
    ).map((d) => [d.id, d]),
  );
  if (definitions.size !== ids.length) {
    throw new MoneyError("that tax rate does not exist");
  }

  /*
   * Each line's named taxes frozen from their definitions, in the shape the
   * invoice screen stores on `invoice_lines.taxes`, so the returns, the PDF and
   * the e-invoice read a raised line exactly as they read a typed one. Null
   * for a line on the single-tax fields, which is every caller before this.
   */
  const frozen = input.lines.map((l) =>
    l.taxes?.length
      ? l.taxes.map((t) => {
          const d = definitions.get(t.taxDefinitionId);
          if (!d) throw new MoneyError("that tax rate does not exist");
          const ratePpm = t.ratePpm ?? d.ratePpm ?? bpToPpm(d.rateBp);
          return {
            taxDefinitionId: t.taxDefinitionId,
            name: d.name,
            rateBp: Math.round(ratePpm / 100),
            ratePpm,
            categoryCode: d.categoryCode,
            compound: d.compound,
          };
        })
      : null,
  );
  // The single-tax columns: the line's own, or its first named tax, so
  // anything still reading them sees a tax rather than none.
  const single = input.lines.map((l, i) => {
    const first = frozen[i]?.[0];
    return first
      ? { taxDefinitionId: first.taxDefinitionId, taxRatePpm: first.ratePpm }
      : {
          taxDefinitionId: l.taxDefinitionId ?? null,
          taxRatePpm: l.taxRatePpm ?? bpToPpm(l.taxRateBp ?? 0),
        };
  });

  const pricesIncludeTax = await quotesGross(organizationId, conn);
  const totals = documentTotals(
    input.lines.map((l, i) => {
      const definition = l.taxDefinitionId
        ? definitions.get(l.taxDefinitionId)
        : undefined;
      return {
        quantity: l.quantity,
        unitPrice: l.unitPriceCents,
        taxRatePpm: l.taxRatePpm ?? bpToPpm(l.taxRateBp ?? 0),
        taxDefinitionId: l.taxDefinitionId ?? null,
        taxName: definition?.name ?? null,
        categoryCode: definition?.categoryCode ?? null,
        taxes: frozen[i],
      };
    }),
    null,
    { pricesIncludeTax },
  );

  const fromSettings = await invoiceDefaultsFor(
    organizationId,
    undefined,
    conn,
  );
  // The business's terms counted from the issue date: the same number of
  // days on from it as the default is from today.
  const dueDate =
    input.dueDate ??
    new Date(
      fromSettings.dueDate.getTime() - today.getTime() + issueDate.getTime(),
    );
  const write = async (tx: DbTx) => {
    const [inv] = await tx
      .insert(schema.invoices)
      .values({
        organizationId,
        contactId: input.contactId,
        number: await nextDocumentNumber(tx, organizationId, "invoice"),
        status: "open",
        currency,
        rateMicro: rate,
        issueDate,
        dueDate,
        paymentTerms: fromSettings.paymentTerms,
        notes: input.notes ?? null,
        pricesIncludeTax,
        subtotalCents: totals.subtotal,
        taxCents: totals.tax,
        totalCents: totals.total,
      })
      .returning();
    if (!inv) throw new Error("invoice insert returned no row");

    await tx.insert(schema.invoiceLines).values(
      input.lines.map((l, i) => ({
        invoiceId: inv.id,
        description: l.description,
        quantity: Math.round(l.quantity),
        quantityMilli: Math.round(l.quantity * 1000),
        unitPriceCents: l.unitPriceCents,
        unit: l.unit ?? "piece",
        taxDefinitionId: single[i]?.taxDefinitionId ?? null,
        taxRateBp: Math.round((single[i]?.taxRatePpm ?? 0) / 100),
        taxRatePpm: single[i]?.taxRatePpm ?? 0,
        taxes: frozen[i] ?? null,
        sortOrder: i,
      })),
    );
    // Before the posting, which reads them on this transaction.
    if (totals.bands.length > 0) {
      await tx.insert(schema.documentTaxes).values(
        totals.bands.map((band) => ({
          organizationId,
          documentType: "invoice",
          documentId: inv.id,
          taxDefinitionId: band.taxDefinitionId,
          name: band.name,
          rateBp: band.rateBp,
          ratePpm: band.ratePpm,
          categoryCode: band.categoryCode,
          taxableCents: band.taxableCents,
          taxCents: band.taxCents,
        })),
      );
    }
    // In the books, or the revenue exists on a document and nowhere else —
    // and in the same commit, so a refusal takes the document with it. A
    // back-dated document posts on its own day, as the screen's issue does,
    // and a closed day throws `PeriodClosedError` and writes nothing.
    await postInvoiceIssued(
      organizationId,
      inv,
      undefined,
      backDated ? issueDate : undefined,
      { tx, day: true },
    );
    return inv;
  };
  return input.tx ? await write(input.tx) : await db.transaction(write);
}

/**
 * One instalment of a quote, as the caller describes it.
 *
 * A share in basis points rather than a percentage, for the same reason tax
 * rates are: 33.33% of a job is a real arrangement, and three of them have to
 * add up to the whole.
 */
export interface Instalment {
  /** This instalment's share of the quote, in basis points of 10,000. */
  shareBp: number;
  /** Days from today until it is due. */
  dueInDays: number;
  /** What it is called on the invoice. "Deposit", "Stage 2". */
  label?: string;
}

/** "Deposit", "Stage 2", "Stage 3", …, and the last one is "Final". */
function instalmentLabel(index: number, count: number): string {
  if (index === 0) return "Deposit";
  return index === count - 1 ? "Final" : `Stage ${index + 1}`;
}

/**
 * Split a whole into shares that add back up to it.
 *
 * Each share is rounded on its own and the last one takes whatever is left,
 * so three thirds of £100 are 33.33, 33.33 and 33.34 rather than three lots
 * of 33.33 and a penny that belongs to nobody. Every apportionment in here
 * goes through this, which is why the generated invoices sum to the quote
 * exactly and no "rounding adjustment" line is needed.
 */
export function apportion(total: number, sharesBp: number[]): number[] {
  const out = sharesBp.map((bp) => Math.round((total * bp) / 10_000));
  const drift = total - out.reduce((sum, n) => sum + n, 0);
  const last = out.length - 1;
  if (last >= 0) out[last] = (out[last] ?? 0) + drift;
  return out;
}

/**
 * A quote becomes several invoices: a deposit, then stages.
 *
 * The alternative a business has today is raising the deposit by hand and
 * remembering the rest, which is how a stage goes unbilled. The quote is the
 * agreement; this turns it into the schedule that was agreed with it.
 *
 * They are drafts. An instalment due in ninety days is not money the business
 * is owed yet, and issuing it now would put the revenue in this month's books
 * and start the overdue clock on work nobody has done.
 *
 * The split is done on the taxable base of each tax band rather than on the
 * gross, so every instalment carries its own correctly-banded tax and the
 * figures reconcile without a rounding line. A discount on the quote is inside
 * that base already, which is what "carried over proportionally" means here.
 */
export async function convertQuoteToInstalments(
  organizationId: string,
  quoteId: string,
  plan: Instalment[],
): Promise<
  { invoices: (typeof schema.invoices.$inferSelect)[] } | { error: string }
> {
  if (plan.length < 2) {
    return { error: "an instalment plan needs at least two of them" };
  }
  if (plan.length > 24) {
    return { error: "that is more instalments than anybody agreed to" };
  }
  const shares = plan.map((part) => part.shareBp);
  if (shares.some((bp) => !Number.isInteger(bp) || bp <= 0)) {
    return { error: "every instalment has to be worth something" };
  }
  if (shares.reduce((sum, bp) => sum + bp, 0) !== 10_000) {
    return { error: "the instalments have to add up to the whole quote" };
  }

  const [quote] = await db
    .select()
    .from(schema.quotes)
    .where(
      and(
        eq(schema.quotes.id, quoteId),
        eq(schema.quotes.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!quote) return { error: "not found" };
  // The same guard the single conversion has, for the same reason: two bills
  // for one job is a customer who has to be talked down.
  if (quote.convertedInvoiceId) {
    return { error: "that quote has already been turned into an invoice" };
  }
  /**
   * Every instalment is raised in the quote's currency, so every one of them
   * needs the rate. Refused as a message rather than thrown, because this
   * function answers its caller that way and a plan of six invoices half of
   * which were made at 1:1 is worse than none.
   */
  const rateMicro = await rateOn(organizationId, quote.currency, new Date());
  if (rateMicro === null) {
    return {
      error: `no exchange rate recorded for ${quote.currency} — record one under Money, in Tax and currency, first`,
    };
  }

  const bands = await db
    .select()
    .from(schema.documentTaxes)
    .where(
      and(
        eq(schema.documentTaxes.documentType, "quote"),
        eq(schema.documentTaxes.documentId, quoteId),
      ),
    );

  /**
   * What is actually being split: the quote after its discount.
   *
   * Plus a rate-free band for whatever is not in any tax band, so a quote
   * with one taxed line and one untaxed line splits both.
   */
  const net = quote.subtotalCents - quote.discountCents;
  const banded = bands.reduce((sum, band) => sum + band.taxableCents, 0);

  /**
   * Two taxes on one line means two bands over the same money.
   *
   * A GST band and a PST band on a Quebec-or-BC quote each carry the whole
   * taxable base, so summing band taxables doubles the subtotal, and the
   * one-line-per-band shape below would bill the customer twice. When the
   * bands overlap the net, each instalment becomes a single lump-sum line for
   * its share of the net, carrying every tax on it — while the per-band tax
   * apportionment below still writes each authority's exact split.
   */
  const overlapping = banded > net;
  const netShares = apportion(net, shares);

  const parts = [
    ...bands.map((band) => ({
      name: band.name,
      rateBp: band.rateBp,
      // Bands frozen before the finer unit carry only basis points; ×100 is
      // the identical rate.
      ratePpm: band.ratePpm ?? bpToPpm(band.rateBp),
      categoryCode: band.categoryCode,
      taxDefinitionId: band.taxDefinitionId,
      taxable: band.taxableCents,
      tax: band.taxCents,
    })),
    ...(net - banded > 0
      ? [
          {
            name: "No tax",
            rateBp: 0,
            ratePpm: 0,
            categoryCode: "Z",
            taxDefinitionId: null,
            taxable: net - banded,
            tax: 0,
          },
        ]
      : []),
  ];

  const split = parts.map((part) => ({
    ...part,
    taxables: apportion(part.taxable, shares),
    taxes: apportion(part.tax, shares),
  }));

  // One day for the whole plan, where the business is: the instalments are
  // dated from it, and the first one is dated *on* it.
  const today = dayIn(new Date(), await timezoneFor(organizationId));
  const made = await db
    .transaction(async (tx) => {
      const invoices: (typeof schema.invoices.$inferSelect)[] = [];

      for (const [index, part] of plan.entries()) {
        const label = part.label?.trim() || instalmentLabel(index, plan.length);
        const subtotal = overlapping
          ? (netShares[index] ?? 0)
          : split.reduce((sum, band) => sum + (band.taxables[index] ?? 0), 0);
        const tax = split.reduce(
          (sum, band) => sum + (band.taxes[index] ?? 0),
          0,
        );

        // A date, for the reason `defaultDueDate` is one.
        const due = new Date(
          today.getTime() + Math.max(0, part.dueInDays) * 86_400_000,
        );

        const [invoice] = await tx
          .insert(schema.invoices)
          .values({
            organizationId,
            contactId: quote.contactId,
            quoteId: quote.id,
            currency: quote.currency,
            rateMicro,
            number: await nextDocumentNumber(tx, organizationId, "invoice"),
            status: "draft",
            issueDate: today,
            // Quoted gross stays quoted gross, on its own letterhead — the same
            // two fields the single conversion carries.
            pricesIncludeTax: quote.pricesIncludeTax,
            templateId: quote.templateId,
            dueDate: due,
            subtotalCents: subtotal,
            discountCents: 0,
            taxCents: tax,
            totalCents: subtotal + tax,
            notes: quote.notes,
          })
          .returning();
        if (!invoice) throw new Error("invoice insert returned no row");

        /**
         * One line per tax band, so the lines and the bands agree.
         *
         * A single line for a mixed-rate quote would have to name one rate and
         * be wrong about the rest, and the document a customer reads would not
         * add up to the tax printed under it.
         */
        await tx.insert(schema.invoiceLines).values(
          overlapping
            ? [
                {
                  invoiceId: invoice.id,
                  description: `${label} — ${quote.number}`,
                  quantityMilli: 1000,
                  unit: "lump sum",
                  unitPriceCents: netShares[index] ?? 0,
                  taxDefinitionId: split[0]?.taxDefinitionId ?? null,
                  taxRateBp: split[0]?.rateBp ?? 0,
                  taxRatePpm: split[0]?.ratePpm ?? 0,
                  // Every tax on the quote rides on the one line, so the
                  // document reads as taxed the way it actually is.
                  taxes: split.map((band) => ({
                    taxDefinitionId: band.taxDefinitionId,
                    name: band.name,
                    rateBp: band.rateBp,
                    ratePpm: band.ratePpm,
                    categoryCode: band.categoryCode,
                    compound: false,
                  })),
                  sortOrder: 0,
                },
              ]
            : split
                .map((band, at) => ({ band, at }))
                .filter(({ band }) => (band.taxables[index] ?? 0) !== 0)
                .map(({ band, at }) => ({
                  invoiceId: invoice.id,
                  description:
                    split.length > 1
                      ? `${label} — ${quote.number} (${band.name})`
                      : `${label} — ${quote.number}`,
                  quantityMilli: 1000,
                  unit: "lump sum",
                  unitPriceCents: band.taxables[index] ?? 0,
                  taxDefinitionId: band.taxDefinitionId,
                  taxRateBp: band.rateBp,
                  taxRatePpm: band.ratePpm,
                  sortOrder: at,
                })),
        );

        const rows = split
          .filter(
            (band) =>
              (band.taxables[index] ?? 0) !== 0 ||
              (band.taxes[index] ?? 0) !== 0,
          )
          .map((band) => ({
            organizationId,
            documentType: "invoice",
            documentId: invoice.id,
            taxDefinitionId: band.taxDefinitionId,
            name: band.name,
            rateBp: band.rateBp,
            ratePpm: band.ratePpm,
            categoryCode: band.categoryCode,
            taxableCents: band.taxables[index] ?? 0,
            taxCents: band.taxes[index] ?? 0,
          }));
        if (rows.length > 0) await tx.insert(schema.documentTaxes).values(rows);

        invoices.push(invoice);
      }

      /*
       * The first of them, so the quote cannot be converted twice. The rest are
       * found through their own `quoteId`.
       *
       * `is null` for the same reason as the single-invoice path above: the check
       * near the top of this function is a read, and writing on the quote's id
       * alone left a gap two requests arriving together both passed. This is the
       * mirror that fix nearly landed on only one side of.
       */
      const marked = await tx
        .update(schema.quotes)
        .set({
          status: "accepted",
          convertedInvoiceId: invoices[0]?.id ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.quotes.id, quoteId),
            isNull(schema.quotes.convertedInvoiceId),
          ),
        )
        .returning({ id: schema.quotes.id });
      if (marked.length === 0) throw new AlreadyConverted();

      return invoices;
    })
    .catch((err) => {
      /*
       * Somebody else converted it while this was building the schedule.
       *
       * The same sentinel the single-invoice path uses, turned into this
       * function's own shape: it answers with an error object rather than null,
       * and the words are the ones the check at the top of it already uses.
       */
      if (err instanceof AlreadyConverted) return null;
      throw err;
    });
  if (made === null) {
    return { error: "that quote has already been turned into an invoice" };
  }

  // Nothing is posted to the ledger here: these are drafts, and a draft is not
  // revenue. Issuing one posts it, the same as any other invoice.
  return { invoices: made };
}

/**
 * What has already been credited against each of these invoices, in cents.
 *
 * A credit note settles debt the way a payment does — the customer no longer
 * owes that part — so everything that answers "what is still due" needs this
 * beside the payments sum: the status recompute, the over-credit guard, the
 * balance a screen shows, the amount a reminder chases for. One query and one
 * definition, because a caller that summed credits its own way is how an
 * invoice ends up owed two different amounts depending on which screen is
 * asking.
 *
 * In the data layer rather than the invoicing module because the overdue and
 * reminder jobs need the same sum and may not import a module.
 *
 * Absent from the map means zero. Voided credit notes do not count; neither
 * do deleted ones.
 */
export async function creditedAgainst(
  orgId: string,
  invoiceIds: string[],
  /** Read inside a transaction that holds the invoice; see `holdInvoice`. */
  conn: DbTx | typeof db = db,
): Promise<Map<string, number>> {
  const credited = new Map<string, number>();
  if (invoiceIds.length === 0) return credited;
  const rows = await conn
    .select({
      invoiceId: schema.invoices.referenceInvoiceId,
      total: sumCents(schema.invoices.totalCents),
    })
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.organizationId, orgId),
        eq(schema.invoices.kind, "credit_note"),
        inArray(schema.invoices.referenceInvoiceId, invoiceIds),
        isNull(schema.invoices.deletedAt),
        sql`${schema.invoices.status} != 'void'`,
      ),
    )
    .groupBy(schema.invoices.referenceInvoiceId);
  for (const row of rows) {
    if (row.invoiceId) credited.set(row.invoiceId, row.total);
  }
  return credited;
}

/**
 * Every live invoice with what is still owed on it, worked out in the query.
 *
 * The same arithmetic `invoiceState` does, in the same order: the total, less
 * anything given up for paying early, less what has been paid, less what has
 * been credited, floored at zero. `draft` and `void` are excluded by the
 * filter rather than by the branch at the top of `invoiceState`, and `paid`
 * and `credited` with them — the stored column is a filter key and that is
 * what it is being used as.
 *
 * Credits count beside the payments because a credit note settles debt the
 * way money does; without them a partly credited invoice shows the credited
 * share as still owed. Voided and deleted credit notes do not count, which is
 * `creditedAgainst`'s rule and is written the same way here.
 *
 * **Here rather than on the dashboard, because two screens ask the same
 * question.** The dashboard's Money panel was rewritten to ask it in one row;
 * the invoicing panel beside it was not, and went on reading every unpaid
 * invoice and every payment against them into the process to add up in
 * JavaScript — 143 MB for four figures. Two spellings of "owed" would also
 * eventually disagree by a part-payment, on two cards of the same screen.
 *
 * Both settlements are added up once each, not once per invoice. Written
 * first as a correlated subquery, which reads beautifully and is a nested
 * loop: 8,105 unpaid invoices times every payment and every credit note,
 * measured at two minutes. Two hash aggregates ask it in one pass each.
 */
export function owingInvoices(orgId: string) {
  const credit = alias(schema.invoices, "credit_note");
  const paid = db
    .select({
      invoiceId: schema.payments.invoiceId,
      cents: sql<number>`sum(${schema.payments.amountCents})`.as("paid_cents"),
    })
    .from(schema.payments)
    .where(eq(schema.payments.organizationId, orgId))
    .groupBy(schema.payments.invoiceId)
    .as("paid");
  const credited = db
    .select({
      invoiceId: credit.referenceInvoiceId,
      cents: sql<number>`sum(${credit.totalCents})`.as("credited_cents"),
    })
    .from(credit)
    .where(
      and(
        eq(credit.organizationId, orgId),
        eq(credit.kind, "credit_note"),
        isNull(credit.deletedAt),
        ne(credit.status, "void"),
      ),
    )
    .groupBy(credit.referenceInvoiceId)
    .as("credited");

  return db
    .select({
      id: schema.invoices.id,
      number: schema.invoices.number,
      dueDate: schema.invoices.dueDate,
      owedCents:
        sql<number>`greatest(0, ${schema.invoices.totalCents} - coalesce(${schema.invoices.earlyDiscountTakenCents}, 0) - coalesce(${paid.cents}, 0) - coalesce(${credited.cents}, 0))`.as(
          "owed_cents",
        ),
    })
    .from(schema.invoices)
    .leftJoin(paid, eq(paid.invoiceId, schema.invoices.id))
    .leftJoin(credited, eq(credited.invoiceId, schema.invoices.id))
    .where(
      and(
        eq(schema.invoices.organizationId, orgId),
        eq(schema.invoices.kind, "invoice"),
        isNull(schema.invoices.deletedAt),
        notInArray(schema.invoices.status, [
          "paid",
          "credited",
          "void",
          "draft",
        ]),
      ),
    )
    .as("owing");
}

/**
 * Late once the due day is over, and only while money is owed — `isOverdue`'s
 * rule, said in SQL so the figure and the list agree with the rest of the
 * product about who is late.
 *
 * The boundary is the first instant of the business's today, so an invoice due
 * today is not late today. `zone` is the business's own timezone; left out it
 * is UTC, and never the server's clock.
 *
 * The instant goes in as text rather than as a `Date`. A due date is stored
 * without a time zone and read back as though it were UTC, which is what
 * `toISOString` writes; handing the driver a `Date` inside an expression it
 * has no column to type it against fails outright, and a cast that guessed
 * would move the boundary by an offset — which at the end of a month is an
 * invoice that is overdue on one screen and not on another.
 */
export function isOverdueSql(
  owing: ReturnType<typeof owingInvoices>,
  now: Date,
  zone: string | null = null,
): SQL<boolean> {
  const at = dayIn(now, zone).toISOString();
  return sql<boolean>`${owing.owedCents} > 0 and ${owing.dueDate} is not null and ${owing.dueDate} < ${at}`;
}

/**
 * Somebody else is changing this invoice's money right now, or just did.
 *
 * Thrown inside a transaction to roll it back; the route answers 409 with
 * `MOVED`. Nothing was written, and pressing the button again reads the
 * invoice as it now stands.
 */
export class InvoiceMoved extends Error {}

/**
 * The invoice locked for this transaction, and what is settled on it now.
 *
 * Every route that moves money against an invoice reads it, decides, and then
 * writes, and a decision made on a read is only as good as the gap behind it:
 * ten presses of "paid in full" all read nothing paid and all recorded the
 * whole balance — ten payments, ten entries, receivable at minus nine times
 * the invoice. The same shape spent one customer's credit on ten invoices and
 * credited one invoice ten times over.
 *
 * So the transaction that writes takes the row first, with NOWAIT: a second
 * caller is refused at once rather than queued. Queued, it would hold a pool
 * connection while it waited, and the winner still needs the pool to post
 * (`ensureAccount`, `timezoneFor`) — ten presses and every connection is
 * waiting on the one that cannot get one. The caller compares what comes back
 * with what it decided on and throws `InvoiceMoved` if any of it changed.
 */
export async function holdInvoice(
  tx: DbTx,
  orgId: string,
  invoiceId: string,
): Promise<{
  invoice: typeof schema.invoices.$inferSelect;
  paidCents: number;
  creditedCents: number;
}> {
  let invoice: typeof schema.invoices.$inferSelect | undefined;
  try {
    [invoice] = await tx
      .select()
      .from(schema.invoices)
      .where(
        and(
          eq(schema.invoices.id, invoiceId),
          eq(schema.invoices.organizationId, orgId),
        ),
      )
      .for("update", { noWait: true });
  } catch (err) {
    // 55P03, lock_not_available: another transaction holds it.
    const code =
      (err as { code?: string }).code ??
      (err as { cause?: { code?: string } }).cause?.code;
    if (code === "55P03") throw new InvoiceMoved();
    throw err;
  }
  if (!invoice) throw new InvoiceMoved();
  const [paid] = await tx
    .select({ total: sumCents(schema.payments.amountCents) })
    .from(schema.payments)
    .where(
      and(
        eq(schema.payments.invoiceId, invoiceId),
        eq(schema.payments.organizationId, orgId),
      ),
    );
  const creditedCents =
    (await creditedAgainst(orgId, [invoiceId], tx)).get(invoiceId) ?? 0;
  return { invoice, paidCents: paid?.total ?? 0, creditedCents };
}

/**
 * Whether the invoice `holdInvoice` returned is the one a decision was made
 * on: the same status and total, the same early-payment saving, and the same
 * amounts paid and credited against it.
 */
export function unmoved(
  held: Awaited<ReturnType<typeof holdInvoice>>,
  read: typeof schema.invoices.$inferSelect,
  paidCents: number,
  creditedCents: number,
): boolean {
  return (
    held.invoice.status === read.status &&
    held.invoice.totalCents === read.totalCents &&
    held.invoice.earlyDiscountTakenCents === read.earlyDiscountTakenCents &&
    held.paidCents === paidCents &&
    held.creditedCents === creditedCents
  );
}
