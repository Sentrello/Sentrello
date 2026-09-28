import type {
  CheckoutRequest,
  ConnectionResult,
  Credentials,
  HostedCheckout,
  PaymentEvent,
  PaymentProvider,
} from "./provider";

/**
 * PayPal, with the shop owner's own credentials.
 *
 * PayPal is not a variation of Stripe, which is why the provider interface
 * exists. Stripe hands back a hosted session and tells you when it was paid.
 * PayPal creates an *order*, sends the buyer to approve it, and then waits for
 * somebody to capture it — approval is not payment. So this provider
 * implements `settle`: an approved order is captured server-side from the
 * webhook, and the capture is what eventually reports as paid.
 *
 * From the webhook rather than the browser, because a buyer who closes the tab
 * on the way back would otherwise leave an approval nobody ever charged.
 *
 * The credentials are a client id and secret; the "webhook secret" column
 * holds PayPal's webhook id, because PayPal verifies signatures on its own
 * servers rather than handing over a key to HMAC with.
 */

const LIVE = "https://api-m.paypal.com";
const SANDBOX = "https://api-m.sandbox.paypal.com";

/** Cents to PayPal's decimal string: 5436 becomes "54.36". */
export function toDecimal(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** "54.36" back to 5436, for checking a capture matches the order. */
export function fromDecimal(value: string): number {
  return Math.round(Number.parseFloat(value) * 100);
}

/** As much of a PayPal capture as reading a payment needs. */
interface Capture {
  status?: string;
  amount?: { value?: string; currency_code?: string };
  seller_receivable_breakdown?: {
    paypal_fee?: { value?: string; currency_code?: string };
  };
}

/**
 * What PayPal kept out of a capture, or undefined.
 *
 * Undefined when the fee is in a different currency from the sale — a euro
 * order settling into a dollar balance — because the fee would then be a
 * number in one currency posted beside a total in another. The sale posts as
 * one with no fee instead, which understates costs rather than misstating cash.
 */
function feeFrom(capture: Capture | undefined): number | undefined {
  const fee = capture?.seller_receivable_breakdown?.paypal_fee;
  if (!fee?.value) return undefined;
  const ordered = capture?.amount?.currency_code;
  if (ordered && fee.currency_code && ordered !== fee.currency_code) {
    return undefined;
  }
  return fromDecimal(fee.value);
}

export function paypalProvider(credentials: Credentials): PaymentProvider {
  const base = credentials.test ? SANDBOX : LIVE;
  // The public key column holds the client id; the secret is the secret.
  const clientId = credentials.publicKey ?? "";
  const secret = credentials.secretKey;
  const webhookId = credentials.webhookSecret;

  async function accessToken(): Promise<string> {
    if (!clientId || !secret) throw new Error("PayPal credentials are not set");
    const res = await fetch(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${clientId}:${secret}`)}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`paypal auth failed: ${res.status}`);
    }
    const body = (await res.json()) as { access_token?: string };
    if (!body.access_token) throw new Error("paypal returned no access token");
    return body.access_token;
  }

  return {
    id: "paypal",

    async testConnection(): Promise<ConnectionResult> {
      if (!clientId || !secret) {
        return { ok: false, message: "a client id and secret are both needed" };
      }
      try {
        await accessToken();
        return {
          ok: true,
          message: credentials.test
            ? "connected to the PayPal sandbox"
            : "connected to PayPal",
          label: `${clientId.slice(0, 6)}…`,
        };
      } catch (err) {
        // Almost always the sandbox credentials against live or the reverse,
        // so say which one was tried rather than only "unauthorized".
        return {
          ok: false,
          message: `${(err as Error).message} — these were tried against ${
            credentials.test ? "the sandbox" : "live"
          }`,
        };
      }
    },

    async createCheckout(req: CheckoutRequest): Promise<HostedCheckout> {
      if (!Number.isInteger(req.amountCents) || req.amountCents <= 0) {
        throw new Error("amountCents must be a positive integer");
      }
      const token = await accessToken();

      const res = await fetch(`${base}/v2/checkout/orders`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          intent: "CAPTURE",
          purchase_units: [
            {
              // Our order id, echoed back on every event about this order.
              custom_id: req.orderId,
              invoice_id: req.orderNumber,
              description: req.description.slice(0, 127),
              amount: {
                currency_code: req.currency.toUpperCase(),
                value: toDecimal(req.amountCents),
              },
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                return_url: req.successUrl,
                cancel_url: req.cancelUrl,
                user_action: "PAY_NOW",
              },
            },
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        throw new Error(`paypal order failed: ${res.status}`);
      }

      const order = (await res.json()) as {
        id?: string;
        links?: { rel: string; href: string }[];
      };
      const approve = order.links?.find(
        (l) => l.rel === "payer-action" || l.rel === "approve",
      );
      if (!order.id || !approve) {
        throw new Error("paypal returned no approval link");
      }
      return { url: approve.href, reference: order.id };
    },

    /**
     * Verification is a call, not a computation, and it fails closed: any
     * error, and any answer other than SUCCESS, is a refusal.
     */
    async verifyWebhook(raw: string, headers: Headers): Promise<boolean> {
      if (!webhookId) return false;
      const required = [
        "paypal-auth-algo",
        "paypal-cert-url",
        "paypal-transmission-id",
        "paypal-transmission-sig",
        "paypal-transmission-time",
      ];
      if (required.some((h) => !headers.get(h))) return false;

      try {
        const token = await accessToken();
        const res = await fetch(
          `${base}/v1/notifications/verify-webhook-signature`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              auth_algo: headers.get("paypal-auth-algo"),
              cert_url: headers.get("paypal-cert-url"),
              transmission_id: headers.get("paypal-transmission-id"),
              transmission_sig: headers.get("paypal-transmission-sig"),
              transmission_time: headers.get("paypal-transmission-time"),
              webhook_id: webhookId,
              webhook_event: JSON.parse(raw),
            }),
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (!res.ok) return false;
        const body = (await res.json()) as { verification_status?: string };
        return body.verification_status === "SUCCESS";
      } catch {
        return false;
      }
    },

    /** Captures an approved order; the capture event marks it paid. */
    async settle(raw: string): Promise<void> {
      const event = JSON.parse(raw) as {
        event_type?: string;
        resource?: { id?: string };
      };
      if (event.event_type !== "CHECKOUT.ORDER.APPROVED") return;
      const orderId = event.resource?.id;
      if (!orderId) return;

      const token = await accessToken();
      const res = await fetch(`${base}/v2/checkout/orders/${orderId}/capture`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          // Capturing twice would charge twice; PayPal deduplicates on this.
          "paypal-request-id": `capture-${orderId}`,
        },
        signal: AbortSignal.timeout(15_000),
      });
      // 422 means already captured, which is a retry, not a failure.
      if (!res.ok && res.status !== 422) {
        throw new Error(`paypal capture failed: ${res.status}`);
      }
    },

    async confirmPaid(reference: string) {
      try {
        const token = await accessToken();
        const res = await fetch(`${base}/v2/checkout/orders/${reference}`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return { paid: false };

        const order = (await res.json()) as {
          status?: string;
          purchase_units?: { payments?: { captures?: Capture[] } }[];
        };
        const capture = order.purchase_units?.[0]?.payments?.captures?.find(
          (cap) => cap.status === "COMPLETED",
        );
        return {
          paid: order.status === "COMPLETED" && Boolean(capture),
          amountCents: capture?.amount?.value
            ? fromDecimal(capture.amount.value)
            : undefined,
          feeCents: feeFrom(capture),
        };
      } catch {
        return { paid: false };
      }
    },

    parseEvent(raw: string): PaymentEvent | null {
      const event = JSON.parse(raw) as {
        id?: string;
        event_type?: string;
        resource?: Capture & {
          custom_id?: string;
          supplementary_data?: { related_ids?: { order_id?: string } };
        };
      };
      if (!event.id) return null;

      const reference =
        event.resource?.custom_id ??
        event.resource?.supplementary_data?.related_ids?.order_id;
      if (!reference) return null;

      const amountCents = event.resource?.amount?.value
        ? fromDecimal(event.resource.amount.value)
        : undefined;

      switch (event.event_type) {
        case "PAYMENT.CAPTURE.COMPLETED":
          return {
            reference,
            status: "paid",
            eventId: event.id,
            amountCents,
            // Unlike Stripe, PayPal puts what it kept in the webhook itself,
            // so a paid order knows its fee without asking anybody.
            feeCents: feeFrom(event.resource),
          };
        case "PAYMENT.CAPTURE.DENIED":
        case "PAYMENT.CAPTURE.DECLINED":
          return { reference, status: "failed", eventId: event.id };
        case "PAYMENT.CAPTURE.REFUNDED":
          return {
            reference,
            status: "refunded",
            eventId: event.id,
            amountCents,
          };
        default:
          // CHECKOUT.ORDER.APPROVED lands here: `settle` acts on it, and the
          // capture that follows is what reports the payment.
          return null;
      }
    },

    async refund(reference: string, amountCents: number, currency: string) {
      try {
        const token = await accessToken();
        const order = await fetch(`${base}/v2/checkout/orders/${reference}`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15_000),
        });
        if (!order.ok) {
          return { ok: false, amountCents: 0, message: "no such PayPal order" };
        }
        const body = (await order.json()) as {
          purchase_units?: {
            payments?: { captures?: { id?: string; status?: string }[] };
          }[];
        };
        const capture = body.purchase_units?.[0]?.payments?.captures?.find(
          (cap) => cap.status === "COMPLETED",
        );
        if (!capture?.id) {
          return { ok: false, amountCents: 0, message: "nothing was captured" };
        }

        const res = await fetch(
          `${base}/v2/payments/captures/${capture.id}/refund`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              amount: {
                value: toDecimal(amountCents),
                // The order's own currency: refunding a euro order in dollars
                // is refused by PayPal, and would be wrong if it were not.
                currency_code: currency.toUpperCase(),
              },
            }),
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (!res.ok) {
          return {
            ok: false,
            amountCents: 0,
            message: `PayPal refused the refund (${res.status})`,
          };
        }
        return { ok: true, amountCents };
      } catch (err) {
        return { ok: false, amountCents: 0, message: (err as Error).message };
      }
    },
  };
}
