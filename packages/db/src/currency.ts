import { and, db, desc, eq, lte, schema } from "./index";

/**
 * More than one currency, without the books becoming unreadable.
 *
 * A document may be raised in anything a customer or supplier uses. The ledger
 * is kept in exactly one currency, because a report that adds euros to dollars
 * is not a report — so every posting is converted on the way in, at the rate
 * that applied on the document's own date.
 *
 * Rates are stored rather than fetched. A rate has to be the one that applied
 * when the document was raised, not the one a service returns today, or last
 * year's accounts change every time somebody opens them.
 *
 * Here rather than in Accounting because both sides of the books need it. The
 * purchase side had it and the sales side did not, which is how invoices came
 * to be posted at face value whatever currency they were raised in.
 */

/** Rates are held in millionths, so 0.782341 survives without a float. */
export const RATE_SCALE = 1_000_000;

/**
 * An amount in another currency, as base-currency cents.
 *
 * Rounded once, at the end. Converting each line and adding them up gives a
 * different total from converting the total, and the document's own total is
 * the figure the customer will pay.
 */
export function toBaseCents(amountCents: number, rateMicro: number): number {
  return Math.round((amountCents * rateMicro) / RATE_SCALE);
}

export async function baseCurrency(orgId: string): Promise<string> {
  const [org] = await db
    .select({ baseCurrency: schema.organizations.baseCurrency })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId))
    .limit(1);
  return org?.baseCurrency ?? "USD";
}

/**
 * The rate for a currency on a date — the latest one recorded on or before it.
 *
 * Null when the business has never recorded one, which is a refusal rather
 * than a guess: posting a foreign document at 1:1 because no rate was set
 * would put a plausible and wrong number in the books, and nothing downstream
 * would ever question it.
 */
export async function rateOn(
  orgId: string,
  code: string,
  on: Date,
): Promise<number | null> {
  if (code === (await baseCurrency(orgId))) return RATE_SCALE;
  const [row] = await db
    .select({ rateMicro: schema.exchangeRates.rateMicro })
    .from(schema.exchangeRates)
    .where(
      and(
        eq(schema.exchangeRates.organizationId, orgId),
        eq(schema.exchangeRates.code, code.toUpperCase()),
        lte(schema.exchangeRates.asOf, on),
      ),
    )
    .orderBy(desc(schema.exchangeRates.asOf))
    .limit(1);
  return row?.rateMicro ?? null;
}
