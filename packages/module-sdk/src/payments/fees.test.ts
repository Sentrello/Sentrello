import { afterEach, expect, test } from "bun:test";
import { paypalProvider } from "./paypal";
import { stripeProvider } from "./stripe";

/**
 * What each processor kept, read out of what it actually sends.
 *
 * The fee is the difference between the books and the bank statement, so
 * reading it wrong is not a cosmetic bug — it is a reconciliation somebody
 * does by hand every month. Both readers are allowed to answer "I do not
 * know", and both must, because the alternative is a plausible wrong number
 * that nobody thinks to check.
 *
 * The two providers report it in genuinely different places: PayPal puts the
 * breakdown in the webhook, Stripe puts it on a balance transaction behind the
 * charge and creates it asynchronously. These are the shapes each one sends.
 */

const credentials = {
  publicKey: null,
  secretKey: "sk_test_x",
  webhookSecret: null,
  test: true,
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function capture(fee: Record<string, string> | null, currency = "USD") {
  return JSON.stringify({
    id: "WH-1",
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: {
      custom_id: "order-1",
      amount: { value: "100.00", currency_code: currency },
      ...(fee ? { seller_receivable_breakdown: { paypal_fee: fee } } : {}),
    },
  });
}

test("PayPal reports the fee on the webhook itself", () => {
  const event = paypalProvider(credentials).parseEvent(
    capture({ value: "3.20", currency_code: "USD" }),
  );
  expect(event?.status).toBe("paid");
  expect(event?.amountCents).toBe(10_000);
  expect(event?.feeCents).toBe(320);
});

test("PayPal: a fee in another currency is not a number to post", () => {
  // A euro sale settling into a dollar balance. Posting 3.20 beside a total of
  // 100.00 would be adding two currencies together in the same entry.
  const event = paypalProvider(credentials).parseEvent(
    capture({ value: "3.20", currency_code: "USD" }, "EUR"),
  );
  expect(event?.feeCents).toBeUndefined();
});

test("PayPal: no breakdown means no fee, not a fee of zero", () => {
  const event = paypalProvider(credentials).parseEvent(capture(null));
  expect(event?.feeCents).toBeUndefined();
});

/** A Checkout Session as Stripe returns it, with whatever expansion resolved. */
function stripeSession(balance: Record<string, unknown> | null) {
  globalThis.fetch = (async (url: string) => {
    asked = String(url);
    return new Response(
      JSON.stringify({
        payment_status: "paid",
        amount_total: 10_000,
        currency: "usd",
        payment_intent: {
          latest_charge: balance ? { balance_transaction: balance } : {},
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}
let asked = "";

test("Stripe reads the fee off the balance transaction, in one round trip", async () => {
  stripeSession({ fee: 320, currency: "usd" });
  const confirmed = await stripeProvider(credentials).confirmPaid?.("cs_1");
  expect(confirmed?.paid).toBe(true);
  expect(confirmed?.feeCents).toBe(320);
  // The expansion is what makes it one call rather than three. Asserted
  // because dropping it would still pass every other check here, silently
  // costing every shop its fee.
  expect(asked).toContain(
    "expand[]=payment_intent.latest_charge.balance_transaction",
  );
});

test("Stripe: the balance transaction may not exist yet, and that is not zero", async () => {
  // Stripe creates it asynchronously, so a webhook arriving promptly finds
  // nothing. The sale must post as one with no fee, not as one with none.
  stripeSession(null);
  const confirmed = await stripeProvider(credentials).confirmPaid?.("cs_1");
  expect(confirmed?.paid).toBe(true);
  expect(confirmed?.feeCents).toBeUndefined();
});

test("Stripe: a fee settled in another currency is not posted", async () => {
  stripeSession({ fee: 300, currency: "eur" });
  const confirmed = await stripeProvider(credentials).confirmPaid?.("cs_1");
  expect(confirmed?.feeCents).toBeUndefined();
});
