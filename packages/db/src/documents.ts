import { and, eq } from "drizzle-orm";
import { db } from "./client";
import { rateOn } from "./currency";
import { postInvoiceIssued } from "./ledger";
import { MoneyError, documentTotals } from "./money";
import { nextDocumentNumber } from "./numbering";
import * as schema from "./schema";

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
 * When an invoice raised from a quote falls due.
 *
 * Thirty days, because an invoice with no due date can never be late: it sits
 * outside every aging bucket, the overdue chase skips it, and it never reaches
 * the dashboard's overdue figure. A quote carries no terms of its own, so this
 * is the assumption — worth making configurable once anyone asks for different
 * terms.
 */
export function defaultDueDate(from = new Date()): Date {
  return new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000);
}

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

  const lines = await db
    .select()
    .from(schema.quoteLines)
    .where(eq(schema.quoteLines.quoteId, quoteId));

  const invoice = await db.transaction(async (tx) => {
    const [inv] = await tx
      .insert(schema.invoices)
      .values({
        organizationId,
        contactId: quote.contactId,
        quoteId: quote.id,
        currency: quote.currency,
        number: await nextDocumentNumber(tx, organizationId, "invoice"),
        status: "open",
        // Without this, converting a quote produced an invoice that could
        // never be chased. The portal's own acceptance path set one; this one
        // did not, so which screen accepted the work decided whether the
        // business would ever be reminded to ask for the money.
        dueDate: defaultDueDate(),
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

    await tx
      .update(schema.quotes)
      .set({
        status: "accepted",
        // What it became, so it cannot become a second one.
        convertedInvoiceId: inv.id,
        updatedAt: new Date(),
      })
      .where(eq(schema.quotes.id, quoteId));
    return inv;
  });

  // An invoice from an accepted quote is an invoice: it posts the same entry
  // as one raised directly, or the revenue exists on the invoice and nowhere
  // in the books.
  await postInvoiceIssued(organizationId, invoice);
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
 * Everything on the line travels: the unit, the fractional quantity, the tax
 * rate. So do the stored tax bands, rather than being recomputed — the bands
 * are what the document was taxed at, and recomputing gives a different answer
 * the day after a rate changes.
 */
export async function copyInvoice(
  organizationId: string,
  sourceInvoiceId: string,
  overrides: {
    status?: string;
    issueDate?: Date;
    dueDate?: Date | null;
    contactId?: string | null;
  } = {},
): Promise<typeof schema.invoices.$inferSelect | null> {
  const [source] = await db
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

  const [lines, bands] = await Promise.all([
    db
      .select()
      .from(schema.invoiceLines)
      .where(eq(schema.invoiceLines.invoiceId, source.id)),
    db
      .select()
      .from(schema.documentTaxes)
      .where(
        and(
          eq(schema.documentTaxes.documentType, "invoice"),
          eq(schema.documentTaxes.documentId, source.id),
        ),
      ),
  ]);

  return await db.transaction(async (tx) => {
    const [made] = await tx
      .insert(schema.invoices)
      .values({
        organizationId,
        contactId:
          overrides.contactId !== undefined
            ? overrides.contactId
            : source.contactId,
        currency: source.currency,
        number: await nextDocumentNumber(tx, organizationId, "invoice"),
        status: overrides.status ?? "draft",
        issueDate: overrides.issueDate ?? new Date(),
        dueDate:
          overrides.dueDate !== undefined ? overrides.dueDate : source.dueDate,
        notes: source.notes,
        paymentTerms: source.paymentTerms,
        templateId: source.templateId,
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
  });
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
 */
export async function raiseInvoice(
  organizationId: string,
  input: {
    contactId: string | null;
    currency?: string;
    dueDate?: Date;
    notes?: string | null;
    lines: {
      description: string;
      quantity: number;
      unitPriceCents: number;
      taxRateBp?: number;
      taxDefinitionId?: string | null;
      unit?: string;
    }[];
  },
): Promise<typeof schema.invoices.$inferSelect | null> {
  if (input.lines.length === 0) return null;

  const currency = input.currency ?? "USD";
  /**
   * Refused rather than guessed.
   *
   * Posting at 1:1 because nobody recorded a rate puts a plausible and wrong
   * number in the books, and nothing downstream ever questions it. The same
   * refusal the invoice screen and the recurring job make.
   */
  const rate = await rateOn(organizationId, currency, new Date());
  if (rate === null) {
    throw new MoneyError(
      `no exchange rate recorded for ${currency} — set one under Accounting first`,
    );
  }

  const totals = documentTotals(
    input.lines.map((l) => ({
      quantity: l.quantity,
      unitPrice: l.unitPriceCents,
      taxRateBp: l.taxRateBp ?? 0,
      taxDefinitionId: l.taxDefinitionId ?? null,
    })),
  );

  const invoice = await db.transaction(async (tx) => {
    const [inv] = await tx
      .insert(schema.invoices)
      .values({
        organizationId,
        contactId: input.contactId,
        number: await nextDocumentNumber(tx, organizationId, "invoice"),
        status: "open",
        currency,
        rateMicro: rate,
        dueDate: input.dueDate ?? defaultDueDate(),
        notes: input.notes ?? null,
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
        taxDefinitionId: l.taxDefinitionId ?? null,
        taxRateBp: l.taxRateBp ?? 0,
        sortOrder: i,
      })),
    );
    return inv;
  });

  // In the books, or the revenue exists on a document and nowhere else.
  await postInvoiceIssued(organizationId, invoice);
  return invoice;
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
  const parts = [
    ...bands.map((band) => ({
      name: band.name,
      rateBp: band.rateBp,
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

  const today = new Date();
  const made = await db.transaction(async (tx) => {
    const invoices: (typeof schema.invoices.$inferSelect)[] = [];

    for (const [index, part] of plan.entries()) {
      const label = part.label?.trim() || instalmentLabel(index, plan.length);
      const subtotal = split.reduce(
        (sum, band) => sum + (band.taxables[index] ?? 0),
        0,
      );
      const tax = split.reduce(
        (sum, band) => sum + (band.taxes[index] ?? 0),
        0,
      );

      const due = new Date(today);
      due.setDate(due.getDate() + Math.max(0, part.dueInDays));

      const [invoice] = await tx
        .insert(schema.invoices)
        .values({
          organizationId,
          contactId: quote.contactId,
          quoteId: quote.id,
          currency: quote.currency,
          number: await nextDocumentNumber(tx, organizationId, "invoice"),
          status: "draft",
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
        split
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
            sortOrder: at,
          })),
      );

      const rows = split
        .filter(
          (band) =>
            (band.taxables[index] ?? 0) !== 0 || (band.taxes[index] ?? 0) !== 0,
        )
        .filter((band) => band.rateBp > 0)
        .map((band) => ({
          organizationId,
          documentType: "invoice",
          documentId: invoice.id,
          taxDefinitionId: band.taxDefinitionId,
          name: band.name,
          rateBp: band.rateBp,
          categoryCode: band.categoryCode,
          taxableCents: band.taxables[index] ?? 0,
          taxCents: band.taxes[index] ?? 0,
        }));
      if (rows.length > 0) await tx.insert(schema.documentTaxes).values(rows);

      invoices.push(invoice);
    }

    await tx
      .update(schema.quotes)
      .set({
        status: "accepted",
        // The first of them, so the quote cannot be converted twice. The rest
        // are found through their own `quoteId`.
        convertedInvoiceId: invoices[0]?.id ?? null,
        updatedAt: new Date(),
      })
      .where(eq(schema.quotes.id, quoteId));

    return invoices;
  });

  // Nothing is posted to the ledger here: these are drafts, and a draft is not
  // revenue. Issuing one posts it, the same as any other invoice.
  return { invoices: made };
}
