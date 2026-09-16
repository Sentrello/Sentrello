import { db } from "./client";
import { and, eq, sql } from "./orm";
import * as schema from "./schema";

/**
 * A customer's held credit — money it overpaid, kept against what it owes
 * next rather than refunded. See `customerCredits` in the schema for the
 * movement-row shape, and `CORE_ACCOUNTS.customerCredits` in `./ledger` for
 * the liability account every movement here has a matching posting in.
 *
 * Tracked in the organization's base currency, whatever currency the invoice
 * that created it was raised in — the same currency a payment's cash side is
 * already converted into. Applying a credit against an invoice in a
 * different currency from the base is refused rather than guessed at; see
 * the `ponytail:` note where it is applied, in the invoicing module.
 */

/** What a customer's credit balance is right now, in cents. Zero if never granted one. */
export async function creditBalanceFor(
  orgId: string,
  contactId: string,
): Promise<number> {
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${schema.customerCredits.cents}), 0)::int`,
    })
    .from(schema.customerCredits)
    .where(
      and(
        eq(schema.customerCredits.organizationId, orgId),
        eq(schema.customerCredits.contactId, contactId),
      ),
    );
  return row?.total ?? 0;
}

/** Records a movement: positive grants credit, negative spends it. */
export async function recordCreditMovement(entry: {
  organizationId: string;
  contactId: string;
  cents: number;
  paymentId?: string;
  invoiceId?: string;
  reason: string;
}): Promise<void> {
  await db.insert(schema.customerCredits).values(entry);
}
