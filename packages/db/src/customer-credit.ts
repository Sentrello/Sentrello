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

/**
 * A customer's credit balance, held for the rest of this transaction.
 *
 * Spending credit reads the balance and then writes a negative movement, and
 * ten invoices for one customer paid from credit at once all read the same
 * balance and all spent it — a credit of 500.00 settled 5,000.00 of invoices.
 * A transaction-scoped advisory lock on the customer closes that, taken with
 * the `try` form so a second caller is refused rather than parked on a pool
 * connection (see `holdInvoice` in `./documents`). Null means somebody else is
 * spending it right now.
 */
export async function holdCreditBalance(
  tx: DbTx,
  orgId: string,
  contactId: string,
): Promise<number | null> {
  const [lock] = (await tx.execute(
    sql`select pg_try_advisory_xact_lock(hashtext(${`customer-credit:${orgId}:${contactId}`})) as held`,
  )) as unknown as { held: boolean }[];
  if (!lock?.held) return null;
  const [row] = await tx
    .select({ total: sumCents(schema.customerCredits.cents) })
    .from(schema.customerCredits)
    .where(
      and(
        eq(schema.customerCredits.organizationId, orgId),
        eq(schema.customerCredits.contactId, contactId),
      ),
    );
  return row?.total ?? 0;
}
