/**
 * Bank connections, one contract and two providers.
 *
 * The same shape as the payment processors beside it: the business pastes its
 * own credentials into a screen, and Sentrello is never in the money flow.
 */
export * from "./provider";
export { plaid } from "./plaid";
export { teller } from "./teller";

import { plaid } from "./plaid";
import type { BankProvider } from "./provider";
import { teller } from "./teller";

/**
 * Every provider a business may choose between.
 *
 * Ordered as a screen should offer them, which is not alphabetical: the one
 * that covers every market this product is sold into goes first, and the
 * cheaper United States one second. A business that picks by scrolling to the
 * bottom should still end up somewhere sensible.
 */
export const BANK_PROVIDERS: BankProvider[] = [plaid, teller];

export function bankProvider(id: string): BankProvider | null {
  return BANK_PROVIDERS.find((p) => p.id === id) ?? null;
}
