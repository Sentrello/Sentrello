import { type DbTx, db } from "./client";
import { sumCents } from "./money";
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
      total: sumCents(schema.customerCredits.cents),
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

/**
 * Records a movement: positive grants credit, negative spends it.
 *
 * `tx` joins a transaction the caller already has open, the same option
 * `postJournalEntry` takes — and for the same reason. This row is the
 * subsidiary ledger behind a posting to the customer credits account: which
 * customer the liability is held for. Written in a commit of its own, a crash
 * between the two leaves a business owing money the books say it owes and no
 * record of whose it is, or a customer holding credit nothing was posted for.
 * Either way the subsidiary ledger and the account it explains disagree, and
 * nothing notices until somebody asks for their money.
 *
 * It was added because callers had begun writing the insert out by hand to
 * get inside their own transaction, which is the same row recorded in three
 * places and the shape most of this project's defects have had.
 */
export async function recordCreditMovement(
  entry: {
    organizationId: string;
    contactId: string;
    cents: number;
    paymentId?: string;
    invoiceId?: string;
    reason: string;
  },
  options: { tx?: DbTx } = {},
): Promise<void> {
  await (options.tx ?? db).insert(schema.customerCredits).values(entry);
}
