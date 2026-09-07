/**
 * The payment processor contract.
 *
 * Written for the Shop and moved into the SDK on 2026-08-28, because the Shop
 * was not the only thing that needs to take a card: an invoice with a Pay Now
 * button on its public page wants exactly this, and it was reading keys out of
 * the environment instead. One contract, one set of credentials pasted into a
 * screen, and every module that charges anybody goes through it.
 *
 * The keys always belong to the business running the shop. Sentrello is never
 * the merchant of record for what a customer sells, and never touches their
 * money — which is also why the credentials arrive as an argument here rather
 * than being read from the environment: they were pasted into a settings
 * screen, sealed, and stored per shop and per mode.
 *
 * Stripe and PayPal are not two flavours of one flow. Stripe hands back a
 * hosted session; PayPal creates an order the buyer approves and the seller
 * then captures. Writing to Stripe first and generalising later would bake its
 * shape in, so both go through this and a third provider is a file.
 */

export interface Credentials {
  /** The publishable half, where the provider has one. */
  publicKey: string | null;
  secretKey: string;
  webhookSecret: string | null;
  /** Whether these are the provider's sandbox keys. */
  test: boolean;
}

export interface CheckoutRequest {
  orderId: string;
  orderNumber: string;
  amountCents: number;
  currency: string;
  description: string;
  customerEmail?: string | null;
  /** Where the buyer lands afterwards. */
  successUrl: string;
  cancelUrl: string;
}

export interface HostedCheckout {
  url: string;
  /** The provider's own id, stored so a webhook can find the order again. */
  reference: string;
}

export type PaymentStatus = "paid" | "failed" | "refunded";

export interface PaymentEvent {
  /** Matches the order's stored reference, or the order id when echoed back. */
  reference: string;
  status: PaymentStatus;
  /** The provider's event id, for rejecting replays. */
  eventId: string;
  amountCents?: number;
  /**
   * What the processor kept, when it says so.
   *
   * Left undefined when the provider has not reported it — Stripe creates the
   * balance transaction asynchronously and it may not exist yet — and an
   * undefined fee posts the sale exactly as one with no fee at all. A guess
   * here would be worse than a gap: it would put a wrong number in the books
   * that nobody would ever think to check.
   */
  feeCents?: number;
}

export interface ConnectionResult {
  ok: boolean;
  /** Who the provider says we are: an account name, or an error to show. */
  message: string;
  label?: string;
}

export interface PaymentProvider {
  id: "stripe" | "paypal";

  /**
   * Whether these keys work, asked of the provider itself.
   *
   * The point of the connect flow: somebody pastes a key, presses a button and
   * is told there and then. The alternative is finding out at the first real
   * checkout, in front of a customer.
   */
  testConnection(): Promise<ConnectionResult>;

  createCheckout(req: CheckoutRequest): Promise<HostedCheckout>;

  /**
   * Verifies a webhook against the raw body — never a parsed object. Parsing
   * and re-serialising changes bytes, and the signature is over bytes.
   */
  verifyWebhook(raw: string, headers: Headers): Promise<boolean>;

  /** Returns null for events this module does not act on. */
  parseEvent(raw: string): PaymentEvent | null;

  /**
   * Work a provider must do on a verified event before it can report a
   * payment. PayPal captures an approved order here — approval is the buyer
   * agreeing, capture is the money moving. Stripe reports payment directly and
   * does not implement it.
   */
  settle?(raw: string): Promise<void>;

  /**
   * Asks the provider whether the money is really there.
   *
   * A signature says a message came from the provider. This says the payment
   * happened, and for how much — which is what a shop should require before it
   * posts income and hands over goods.
   */
  confirmPaid?(
    reference: string,
  ): Promise<{ paid: boolean; amountCents?: number; feeCents?: number }>;

  /** Sends money back. Returns what was actually refunded. */
  refund?(
    reference: string,
    amountCents: number,
    currency: string,
  ): Promise<{ ok: boolean; amountCents: number; message?: string }>;
}

/** Constant-time compare, for anything that is a credential. */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= (left[i] as number) ^ (right[i] as number);
  }
  return diff === 0;
}
