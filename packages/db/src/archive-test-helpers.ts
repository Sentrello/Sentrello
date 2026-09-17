import type { LedgerRow } from "./ledger";

/**
 * Per-account balances, in cents, as a plain object.
 *
 * The archive tests compare a whole report before and after — which is the
 * claim the feature makes — and doing that with `toEqual` on a map keyed by
 * account is both exact and readable when it fails. Debits positive, credits
 * negative, with no per-type flipping: this is the trial balance, not a
 * statement, and an identical trial balance is the strongest form of the claim.
 */
export function balanceOf(rows: LedgerRow[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const row of rows) {
    totals[row.accountId] =
      (totals[row.accountId] ?? 0) + row.debitCents - row.creditCents;
  }
  return totals;
}
