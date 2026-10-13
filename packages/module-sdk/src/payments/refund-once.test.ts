import { afterEach, expect, test } from "bun:test";
import { paypalProvider } from "./paypal";
import { stripeProvider } from "./stripe";

/**
 * A refund whose answer was lost, asked for again.
 *
 * Both processors are called with a fifteen-second deadline, and a refund the
 * processor made but did not answer in time comes back as a failure. Whoever
 * pressed Refund presses it again, and the customer is sent the money twice.
 * The processor can tell the second ask from a new refund only if the caller
 * names the refund — so the key is passed through, unchanged, to both.
 */
const saved = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = saved;
});

function processor(answer: (url: string) => unknown) {
  const seen: { url: string; headers: Headers }[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), headers: new Headers(init?.headers) });
    return Response.json(answer(String(url)));
  }) as typeof fetch;
  return seen;
}

test("a Stripe refund carries the caller's key", async () => {
  const seen = processor(() => ({ id: "re_1", amount: 500 }));
  const stripe = stripeProvider({
    secretKey: "sk_test_fake",
    publicKey: "pk_test_fake",
    webhookSecret: "",
    test: true,
  });
  await stripe.refund?.("pi_abc", 500, "usd", "refund/order-7/1");
  const refund = seen.find((s) => s.url.endsWith("/refunds"));
  expect(refund?.headers.get("idempotency-key")).toBe("refund/order-7/1");
});

test("a PayPal refund carries the caller's key", async () => {
  const seen = processor((url) =>
    url.endsWith("/oauth2/token")
      ? { access_token: "t" }
      : url.includes("/checkout/orders/")
        ? {
            purchase_units: [
              { payments: { captures: [{ id: "CAP1", status: "COMPLETED" }] } },
            ],
          }
        : { id: "R1" },
  );
  const paypal = paypalProvider({
    secretKey: "secret",
    publicKey: "client",
    webhookSecret: "",
    test: true,
  });
  await paypal.refund?.("ORDER1", 500, "usd", "refund/order-7/1");
  const refund = seen.find((s) => s.url.endsWith("/refund"));
  expect(refund?.headers.get("paypal-request-id")).toBe("refund/order-7/1");
});
