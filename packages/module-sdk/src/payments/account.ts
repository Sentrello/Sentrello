import * as secrets from "../secrets";
import { paypalProvider } from "./paypal";
import type { Credentials, PaymentProvider } from "./provider";
import { stripeProvider } from "./stripe";

/**
 * A stored connection, opened into something that can take money.
 *
 * Six lines, and it existed twice before this file did — once in the Shop and
 * once in Settings, byte for byte. Two copies of six lines is survivable; the
 * till wanting a third is what made it worth fixing, because the thing being
 * copied is the step that decrypts a secret key and picks a processor. A
 * divergence there is not a cosmetic one.
 *
 * It lives in the SDK rather than in either module because both repositories
 * can reach the SDK and neither can reach the other: the Shop is commercial
 * and Settings is in the public core.
 *
 * The row is taken by shape rather than by importing its type. This package is
 * the contract modules link against and it depends on nothing but Hono —
 * reaching into the database package to name one row would invert that, for a
 * type that five fields describe exactly as well.
 */
export interface StoredPaymentAccount {
  provider: string;
  /** `test` or `live`. Anything else is treated as live, which fails safe. */
  mode: string;
  publicKey: string | null;
  /** Sealed. Opened here and nowhere a route can reach. */
  secretKey: string | null;
  webhookSecret: string | null;
}

export function providerFromAccount(
  account: StoredPaymentAccount,
): PaymentProvider {
  const credentials: Credentials = {
    publicKey: account.publicKey,
    secretKey: account.secretKey ? secrets.open(account.secretKey) : "",
    webhookSecret: account.webhookSecret
      ? secrets.open(account.webhookSecret)
      : null,
    test: account.mode === "test",
  };
  return account.provider === "paypal"
    ? paypalProvider(credentials)
    : stripeProvider(credentials);
}
