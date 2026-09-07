/**
 * Money entry, shared by every form that takes an amount.
 *
 * The browser is where floats get in: a text box holds "12.50" and the ledger
 * holds 1250. Converting in one place, tested, keeps the rest of the UI from
 * inventing its own rounding.
 */

export interface Line {
  description: string;
  quantity: number;
  /** integer cents */
  unitPrice: number;
  /** basis points: 875 is 8.75% */
  taxRateBp: number;
}

/** "12.50" → 1250. Anything unparseable is zero, never NaN. */
export function toCents(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** 1250 → "12.50", for putting cents back into a number input. */
export function toAmountInput(cents: number): string {
  return cents ? String(cents / 100) : "";
}

/**
 * Invoice totals, matching the server's `lineTotals`.
 *
 * Tax is rounded per line rather than on the subtotal: that is what the server
 * does, and a UI that rounds differently shows a customer a total the invoice
 * will not agree with.
 */
export function totals(lines: Line[]): {
  subtotal: number;
  tax: number;
  total: number;
} {
  let subtotal = 0;
  let tax = 0;
  for (const l of lines) {
    // No rounding of the net: quantity and unit price are both integers, so
    // this is exactly what `lineTotals` on the server computes.
    const net = l.quantity * l.unitPrice;
    subtotal += net;
    tax += Math.round((net * l.taxRateBp) / 10_000);
  }
  return { subtotal, tax, total: subtotal + tax };
}
