import { and, eq } from "drizzle-orm";
import { db } from "./client";
import * as schema from "./schema";

/**
 * The card connection a business is actually using.
 *
 * Lives in the data layer rather than in a module, because more than one thing
 * charges people: an invoice with a Pay Now button on its public page, and a
 * shop taking an order. Both want the same account, and a business has one
 * Stripe account rather than one per module.
 *
 * Opening the secrets is deliberately *not* here. Sealing belongs to the
 * module SDK, which is where the key material and the provider glue live; this
 * only answers which row to use.
 */

export type PaymentAccount = typeof schema.paymentAccounts.$inferSelect;

/**
 * Exactly one row can be enabled, so there is never a question about which
 * keys a charge used — and turning on live is what stops a sandbox payment
 * being taken for real money.
 */
export async function activePaymentAccount(
  organizationId: string,
  provider?: string,
): Promise<PaymentAccount | null> {
  const [row] = await db
    .select()
    .from(schema.paymentAccounts)
    .where(
      and(
        eq(schema.paymentAccounts.organizationId, organizationId),
        eq(schema.paymentAccounts.enabled, true),
        ...(provider ? [eq(schema.paymentAccounts.provider, provider)] : []),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Whether this business can take a card at all.
 *
 * Asked before a Pay Now button is drawn. Offering one that leads to an error
 * is worse than not offering it: the customer has decided to pay and been
 * stopped, which is the one moment a business cannot afford a broken screen.
 */
export async function canTakeCards(organizationId: string): Promise<boolean> {
  const account = await activePaymentAccount(organizationId);
  return Boolean(account?.secretKey);
}

/**
 * Whose instance a payment event belongs to.
 *
 * A processor sends no Origin header and no session, so the connection itself
 * decides: one organization has this provider switched on, and that is the one
 * whose webhook secret the event is checked against. More than one is only
 * possible with more than one business on an instance, and guessing would
 * credit somebody's payment to another business — so it answers null and the
 * event is refused.
 */
export async function organizationTakingCards(
  provider?: string,
): Promise<string | null> {
  const rows = await db
    .select({
      organizationId: schema.paymentAccounts.organizationId,
      provider: schema.paymentAccounts.provider,
    })
    .from(schema.paymentAccounts)
    .where(eq(schema.paymentAccounts.enabled, true));

  const matching = provider
    ? rows.filter((r) => r.provider === provider)
    : rows;
  return matching.length === 1 ? (matching[0]?.organizationId ?? null) : null;
}
