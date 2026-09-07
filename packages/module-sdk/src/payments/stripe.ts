import { verifyStripeSignature } from "../stripe-signature";
import type {
  CheckoutRequest,
  ConnectionResult,
  Credentials,
  HostedCheckout,
  PaymentEvent,
  PaymentProvider,
} from "./provider";

/**
 * Stripe, with the shop owner's own keys.
 *
 * Stripe hosts the payment page, so no card details ever reach this instance —
 * which is the difference between a business that has to think about PCI and
 * one that does not.
 *
 * The REST API directly rather than the SDK: this runs inside a module bundle
 * that links a fixed short list of packages, and the calls are four.
 */

/**
 * Overridable so a test can point at a local server, and for no other reason —
 * unset everywhere real. Without it the only way to exercise this file is to
 * talk to Stripe, which means the paths that matter get tested by hand or not
 * at all.
 */
/**
 * Read per call rather than once at import, so a test can point it somewhere
 * after this module is already loaded — which is every test, since the module
 * is imported long before one runs.
 */
const api = () => process.env.STRIPE_API_BASE ?? "https://api.stripe.com/v1";

function form(values: Record<string, string | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, value);
  }
  return params;
}

/**
 * The processing fee out of an expanded Checkout Session, or undefined.
 *
 * Undefined in two cases that both matter. Stripe creates the balance
 * transaction **asynchronously**, so a webhook arriving promptly may find
 * nothing there yet. And the fee is denominated in the account's settlement
 * currency, which for a euro sale into a dollar account is not the currency of
 * the order — posting that number beside the order total would be adding two
 * different currencies together. In both cases the sale posts exactly as one
 * with no fee, which understates costs rather than misstating cash.
 */
function feeFrom(session: Record<string, unknown>): number | undefined {
  const intent = session.payment_intent as
    | { latest_charge?: { balance_transaction?: Record<string, unknown> } }
    | undefined;
  const balance = intent?.latest_charge?.balance_transaction;
  if (!balance || typeof balance.fee !== "number") return undefined;

  const settled = balance.currency;
  const ordered = session.currency;
  if (
    typeof settled === "string" &&
    typeof ordered === "string" &&
    settled.toLowerCase() !== ordered.toLowerCase()
  ) {
    return undefined;
  }
  return balance.fee;
}

export function stripeProvider(credentials: Credentials): PaymentProvider {
  const { secretKey, webhookSecret } = credentials;

  async function call(
    path: string,
    init: { method?: string; body?: URLSearchParams } = {},
  ): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${api()}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: init.body,
      // A payment processor that has stopped answering must not hold a
      // customer's checkout open indefinitely.
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    return { ok: res.ok, status: res.status, body };
  }

  return {
    id: "stripe",

    async testConnection(): Promise<ConnectionResult> {
      if (!secretKey) return { ok: false, message: "no secret key is stored" };

      // A live key on a shop set to test mode, or the reverse, is the mistake
      // this catches before a customer does.
      const looksLive = secretKey.startsWith("sk_live");
      if (looksLive === credentials.test) {
        return {
          ok: false,
          message: credentials.test
            ? "that is a live key, and this is the sandbox connection"
            : "that is a test key, and this is the live connection",
        };
      }

      const account = await call("/account");
      if (!account.ok) {
        const error = account.body.error as { message?: string } | undefined;
        return {
          ok: false,
          message:
            error?.message ?? `Stripe refused the key (${account.status})`,
        };
      }

      const label =
        (account.body.business_profile as { name?: string } | undefined)
          ?.name ??
        (account.body.email as string | undefined) ??
        (account.body.id as string);
      return { ok: true, message: `connected to ${label}`, label };
    },

    async createCheckout(req: CheckoutRequest): Promise<HostedCheckout> {
      if (!Number.isInteger(req.amountCents) || req.amountCents <= 0) {
        throw new Error("amountCents must be a positive integer");
      }

      const body = form({
        mode: "payment",
        success_url: req.successUrl,
        cancel_url: req.cancelUrl,
        "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": req.currency.toLowerCase(),
        "line_items[0][price_data][unit_amount]": String(req.amountCents),
        "line_items[0][price_data][product_data][name]": req.description,
        // One line for the order total rather than a line per product: the
        // shop's own arithmetic has already decided what is owed, including
        // tax and delivery, and sending it twice invites the two to disagree.
        "metadata[order_id]": req.orderId,
        "metadata[order_number]": req.orderNumber,
        client_reference_id: req.orderId,
        customer_email: req.customerEmail ?? undefined,
      });

      const res = await call("/checkout/sessions", { method: "POST", body });
      if (!res.ok) {
        const error = res.body.error as { message?: string } | undefined;
        throw new Error(
          `stripe checkout failed: ${error?.message ?? res.status}`,
        );
      }
      return {
        url: res.body.url as string,
        reference: res.body.id as string,
      };
    },

    async verifyWebhook(raw: string, headers: Headers): Promise<boolean> {
      if (!webhookSecret) return false;
      return verifyStripeSignature(
        raw,
        headers.get("stripe-signature"),
        webhookSecret,
      );
    },

    parseEvent(raw: string): PaymentEvent | null {
      const event = JSON.parse(raw) as {
        id?: string;
        type?: string;
        data?: { object?: Record<string, unknown> };
      };
      const object = event.data?.object ?? {};
      const eventId = event.id ?? "";

      if (event.type === "checkout.session.completed") {
        // `paid` rather than "the buyer came back": Stripe says whether the
        // money moved, and for a bank debit it may not have yet.
        if (object.payment_status !== "paid") return null;
        return {
          reference:
            (object.client_reference_id as string) ?? (object.id as string),
          status: "paid",
          eventId,
          amountCents:
            typeof object.amount_total === "number"
              ? object.amount_total
              : undefined,
        };
      }

      if (event.type === "checkout.session.async_payment_failed") {
        return {
          reference:
            (object.client_reference_id as string) ?? (object.id as string),
          status: "failed",
          eventId,
        };
      }

      if (event.type === "charge.refunded") {
        const metadata = (object.metadata ?? {}) as Record<string, string>;
        return {
          reference: metadata.order_id ?? (object.payment_intent as string),
          status: "refunded",
          eventId,
          amountCents:
            typeof object.amount_refunded === "number"
              ? object.amount_refunded
              : undefined,
        };
      }

      // Everything else Stripe sends is somebody else's business.
      return null;
    },

    async confirmPaid(reference: string) {
      // The fee is not on the session, nor on the webhook that announced it:
      // it lives on the balance transaction behind the charge. Expanded onto
      // the call the shop already makes rather than fetched separately, so
      // confirming a payment stays one round trip.
      const res = await call(
        `/checkout/sessions/${reference}?expand[]=payment_intent.latest_charge.balance_transaction`,
      );
      if (!res.ok) return { paid: false };
      return {
        paid: res.body.payment_status === "paid",
        amountCents:
          typeof res.body.amount_total === "number"
            ? res.body.amount_total
            : undefined,
        feeCents: feeFrom(res.body),
      };
    },

    async refund(reference: string, amountCents: number, _currency: string) {
      // The session holds the payment intent, which is what a refund is
      // against. Asking for the session first is one call more and means a
      // shop only ever has to store one reference.
      const session = await call(`/checkout/sessions/${reference}`);
      const intent = session.body.payment_intent as string | undefined;
      if (!session.ok || !intent) {
        return { ok: false, amountCents: 0, message: "no payment to refund" };
      }

      const res = await call("/refunds", {
        method: "POST",
        body: form({
          payment_intent: intent,
          amount: String(amountCents),
        }),
      });
      if (!res.ok) {
        const error = res.body.error as { message?: string } | undefined;
        return {
          ok: false,
          amountCents: 0,
          message: error?.message ?? "Stripe refused the refund",
        };
      }
      return {
        ok: true,
        amountCents:
          typeof res.body.amount === "number" ? res.body.amount : amountCents,
      };
    },
  };
}
