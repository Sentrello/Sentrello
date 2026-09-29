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

/**
 * The currencies of the markets this product serves, and no others.
 *
 * The US first, then Canada, the UK and the EU — the same scoping instrument
 * that decides which tax regimes exist at all. A business trading in something
 * else is not turned away: `setBaseCurrency` takes any three-letter code. This
 * is what a screen offers without making somebody type.
 */
export const MARKET_CURRENCIES = ["USD", "CAD", "GBP", "EUR"] as const;

/**
 * Whether the books can still be told what currency they are kept in.
 *
 * One entry is enough to stop it. Every figure in the ledger is base-currency
 * cents converted at the rate that applied on the day, so changing the base
 * afterwards does not relabel the books — it restates every one of them, at
 * rates nobody recorded.
 */
export async function baseCurrencyLocked(orgId: string): Promise<boolean> {
  const [posted] = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId))
    .limit(1);
  return Boolean(posted);
}

/**
 * Set the currency the books are kept in, while that is still possible.
 *
 * Here rather than in a route because there are two routes: Settings, on every
 * tier, and Accounting's own on Pro. They had one implementation between them
 * and it was the Pro one — so a Free instance anywhere outside the United
 * States invoiced in dollars for ever, with no screen able to say otherwise.
 * Two copies of this rule would disagree the week one of them changed, about
 * what somebody's books mean.
 *
 * Returns the refusal rather than throwing, so each route can answer with its
 * own status and the words reach the person who typed it.
 */
export async function setBaseCurrency(
  orgId: string,
  code: string,
): Promise<{ baseCurrency: string } | { error: string; status: 400 | 409 }> {
  const want = code.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(want)) {
    return { error: "a three-letter currency code", status: 400 };
  }
  if (
    want !== (await baseCurrency(orgId)) &&
    (await baseCurrencyLocked(orgId))
  ) {
    return {
      error:
        "the books already have entries in the current currency — changing it would restate every one of them",
      status: 409,
    };
  }
  await db
    .update(schema.organizations)
    .set({ baseCurrency: want })
    .where(eq(schema.organizations.id, orgId));
  return { baseCurrency: want };
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
