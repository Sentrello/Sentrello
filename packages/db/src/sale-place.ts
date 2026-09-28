import { and, eq, gte, lte } from "drizzle-orm";
import type { DbTx } from "./client";
import { db, schema } from "./index";
import { CORE_ACCOUNTS, isTaxPayableCode } from "./ledger";
import type { PlaceEvidence } from "./schema";

/**
 * Recording where a sale happened, once, for every module that sells.
 *
 * The tax returns read `sale_places` and nothing else to place a supply, so a
 * module that posts a sale to the ledger and does not call this has produced a
 * sale no return can report. That is the failure this function exists to make
 * cheap to avoid: one call beside the journal entry, the same shape whether
 * the sale was an invoice, a counter sale or a download bought from a
 * storefront.
 *
 * It is deliberately not inferred anywhere. A caller that cannot establish a
 * place writes nothing, and the sale surfaces on the return as unplaced with a
 * figure beside it — which is the honest answer, and the one thing a zero must
 * never be confused with.
 */

/** Which rule placed the sale. The vocabulary the guidance uses. */
export type PlaceBasis =
  | "delivery"
  | "billing"
  | "customer-address"
  | "shop-location"
  | "declared";

export interface SalePlace {
  /** ISO 3166-1 alpha-2. Stored upper-cased and trimmed. */
  country: string;
  /** A state or province where one decides the rate; null everywhere else. */
  region?: string | null;
  basis: PlaceBasis;
  /** What the place was established from — kept for as long as the sale is. */
  evidence?: PlaceEvidence[];
  /** Where this sale's `document_taxes` bands are filed, if it has any. */
  documentId?: string | null;
  /** The customer's registration at the moment of sale, and VIES's verdict. */
  customerTaxId?: string | null;
  customerTaxIdValid?: boolean | null;
}

/**
 * Write the place of a posted sale, keyed by the entry's ledger source.
 *
 * Upserted rather than inserted: posting is retried — a payment webhook
 * arrives twice, a job re-runs — and a second attempt must leave one row
 * saying the same thing, not a unique-violation that unwinds a sale that has
 * already been paid for.
 *
 * An empty country is refused rather than stored. "Somewhere, we think" is the
 * value that makes a return wrong while looking complete; not knowing is a
 * state the returns already handle.
 */
export async function recordSalePlace(
  organizationId: string,
  source: string,
  place: SalePlace,
  tx?: DbTx,
): Promise<void> {
  const country = place.country.trim().toUpperCase();
  if (!country) {
    throw new Error(`sale place for ${source} has no country`);
  }
  const row = {
    organizationId,
    source,
    documentId: place.documentId ?? null,
    country,
    region: place.region?.trim().toUpperCase() || null,
    basis: place.basis,
    evidence: place.evidence ?? null,
    customerTaxId: place.customerTaxId ?? null,
    customerTaxIdValid: place.customerTaxIdValid ?? null,
  };
  await (tx ?? db)
    .insert(schema.salePlaces)
    .values(row)
    .onConflictDoUpdate({
      target: [schema.salePlaces.organizationId, schema.salePlaces.source],
      set: row,
      where: and(
        eq(schema.salePlaces.organizationId, organizationId),
        eq(schema.salePlaces.source, source),
      ),
    });
}

/**
 * What an organisation sold in a period, where, and to whom — from the books.
 *
 * Every report that has to place a supply reads this rather than writing its
 * own query, because writing its own is how three of them came to answer the
 * same question differently. The OSS return took `invoice:%` and
 * `credit-note:%` sources only. The distance-selling threshold and the US
 * nexus watcher read invoice rows and joined through a company for the
 * country. All three were blind to a storefront sale, and two of them were
 * blind to every consumer, who is a person and has no company to join to.
 *
 * A sale is an entry that moved income. That is the whole test, and it is the
 * ledger's own: a payment moves cash and receivables, an expense moves the
 * other way, and neither is a supply. Nothing here knows which module raised
 * what, which is the property that keeps it true for the next one.
 *
 * Figures are credits less debits in base-currency cents, so an invoice is
 * positive and the credit note that reverses it is negative without anybody
 * asking which it was. An entry with no place recorded comes back with
 * `place: null` — never dropped, and never defaulted to somewhere.
 */
export interface PostedSale {
  /** The ledger source of the entry — "invoice:<id>", "shop-order:<id>". */
  source: string;
  /** Movement on income: net of tax, because tax posts to its own account. */
  netCents: number;
  /** Movement on the tax liability accounts. */
  vatCents: number;
  /** Null where nothing established where this sale happened. */
  place: {
    country: string;
    region: string | null;
    documentId: string | null;
    taxIdentifier: string | null;
    taxIdentifierValid: boolean | null;
  } | null;
}

export async function postedSales(
  organizationId: string,
  period: { from?: Date; to?: Date } = {},
): Promise<PostedSale[]> {
  const lines = await db
    .select({
      source: schema.journalEntries.source,
      type: schema.accounts.type,
      code: schema.accounts.code,
      debitCents: schema.journalLines.debitCents,
      creditCents: schema.journalLines.creditCents,
      placeCountry: schema.salePlaces.country,
      placeRegion: schema.salePlaces.region,
      placeDocumentId: schema.salePlaces.documentId,
      placeTaxId: schema.salePlaces.customerTaxId,
      placeTaxIdValid: schema.salePlaces.customerTaxIdValid,
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
    /*
     * Left, not inner. An inner join here would restore the exact fault this
     * function exists to end: a sale nobody could place would disappear
     * instead of coming back as one nobody could place.
     */
    .leftJoin(
      schema.salePlaces,
      and(
        eq(schema.salePlaces.organizationId, organizationId),
        eq(schema.salePlaces.source, schema.journalEntries.source),
      ),
    )
    .where(
      and(
        eq(schema.journalEntries.organizationId, organizationId),
        eq(schema.accounts.organizationId, organizationId),
        ...(period.from
          ? [gte(schema.journalEntries.postedAt, period.from)]
          : []),
        ...(period.to ? [lte(schema.journalEntries.postedAt, period.to)] : []),
      ),
    );

  const sales = new Map<string, PostedSale & { income: boolean }>();
  for (const line of lines) {
    const source = line.source;
    // No source is an adjustment somebody posted by hand, not a supply.
    if (!source) continue;
    const sale = sales.get(source) ?? {
      source,
      netCents: 0,
      vatCents: 0,
      place: null,
      income: false,
    };
    const movement = line.creditCents - line.debitCents;
    if (line.type === "income") {
      sale.income = true;
      sale.netCents += movement;
    }
    /*
     * A discount is a debit to contra-revenue, not a smaller credit to income,
     * so income alone overstates what was actually supplied. It has to come
     * off: the taxable amount of a supply is what the customer paid for it,
     * and a storefront that took 10% off a €100 basket supplied €90.
     *
     * It did not matter while only invoices reached the returns — an invoice
     * credits income net of its discount already, and there is nothing to
     * subtract. It matters the moment anything else can sell.
     */
    if (line.code === CORE_ACCOUNTS.salesDiscounts.code) {
      sale.netCents -= line.debitCents - line.creditCents;
    }
    if (isTaxPayableCode(line.code)) sale.vatCents += movement;
    if (line.placeCountry) {
      sale.place = {
        country: line.placeCountry,
        region: line.placeRegion,
        documentId: line.placeDocumentId,
        taxIdentifier: line.placeTaxId,
        taxIdentifierValid: line.placeTaxIdValid,
      };
    }
    sales.set(source, sale);
  }
  return [...sales.values()]
    .filter((sale) => sale.income)
    .map(({ income: _income, ...sale }) => sale);
}
