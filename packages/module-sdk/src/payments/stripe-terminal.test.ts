import { afterEach, beforeEach, expect, test } from "bun:test";
import { stripeProvider } from "./stripe";

/**
 * The card reader, driven from the server, against a Stripe that is not Stripe.
 *
 * Every one of these runs with no hardware in the room and no network. That is
 * the point: the readers arrive in November and the driver is being written in
 * October, so the only thing that can hold it up is a bug nobody could see.
 * A fake Stripe answers the four endpoints the driver uses, and the test says
 * what the till would do with each answer.
 *
 * What this cannot tell us, and November will: a reader that drops off the
 * network halfway through an authorisation, a printer with no paper, and a card
 * that is offline-PIN only — which is a real share of the cards issued in two
 * of our four markets.
 */

let stripe: ReturnType<typeof Bun.serve>;
let seen: {
  path: string;
  method: string;
  body: string;
  idempotency: string | null;
}[];
let reply: (path: string) => unknown;
let previousBase: string | undefined;

/**
 * The four reader methods, with the optionality resolved once.
 *
 * They are optional on the interface because a processor that cannot drive a
 * reader should not be forced to pretend it can. Stripe can, so the narrowing
 * here is also the assertion that it still does — delete one of the four and
 * every test below fails with a sentence saying which capability went missing,
 * rather than with a null dereference.
 */
function driver() {
  const provider = stripeProvider({
    secretKey: "sk_test_fake",
    publicKey: "pk_test_fake",
    webhookSecret: "",
    test: true,
  });
  const { listReaders, collectOnReader, readerPayment, cancelReaderPayment } =
    provider;
  if (
    !listReaders ||
    !collectOnReader ||
    !readerPayment ||
    !cancelReaderPayment
  ) {
    throw new Error("the Stripe provider no longer drives a card reader");
  }
  return { listReaders, collectOnReader, readerPayment, cancelReaderPayment };
}

beforeEach(() => {
  seen = [];
  reply = () => ({});
  stripe = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      seen.push({
        path: url.pathname,
        method: req.method,
        body: await req.text(),
        idempotency: req.headers.get("idempotency-key"),
      });
      const body = reply(url.pathname);
      if (body === null) return new Response("{}", { status: 402 });
      return Response.json(body);
    },
  });
  previousBase = process.env.STRIPE_API_BASE;
  process.env.STRIPE_API_BASE = `http://localhost:${stripe.port}`;
});

afterEach(() => {
  stripe.stop(true);
  process.env.STRIPE_API_BASE = previousBase;
});

test("a reader Stripe cannot reach is listed, not hidden", async () => {
  reply = () => ({
    data: [
      {
        id: "tmr_1",
        label: "Front counter",
        status: "online",
        serial_number: "A1",
        location: "tml_1",
      },
      { id: "tmr_2", label: "Van", status: "offline", serial_number: "B2" },
    ],
  });

  const readers = await driver().listReaders();

  // The offline one is the whole assertion. A cashier whose reader is unplugged
  // needs to see it greyed out, not watch it vanish and doubt themselves.
  expect(readers).toEqual([
    {
      id: "tmr_1",
      label: "Front counter",
      status: "online",
      serialNumber: "A1",
      locationId: "tml_1",
    },
    {
      id: "tmr_2",
      label: "Van",
      status: "offline",
      serialNumber: "B2",
      locationId: undefined,
    },
  ]);
});

test("collecting makes a card-present payment and hands it to the reader", async () => {
  reply = (path) =>
    path.endsWith("/payment_intents")
      ? { id: "pi_abc" }
      : {
          id: "tmr_1",
          action: {
            type: "process_payment_intent",
            status: "in_progress",
            process_payment_intent: { payment_intent: "pi_abc" },
          },
        };

  const result = await driver().collectOnReader({
    readerId: "tmr_1",
    amountCents: 1250,
    currency: "USD",
    idempotencyKey: "ticket-42-attempt-1",
    description: "Ticket 42",
  });

  expect(result).toEqual({ reference: "pi_abc", status: "waiting" });

  const [intent, handed] = seen;
  // card_present, not the automatic set: a card at a counter is a different
  // payment method from one typed into a page, and automatic excludes it.
  expect(intent?.body).toContain("payment_method_types%5B%5D=card_present");
  expect(intent?.body).toContain("amount=1250");
  // Lower-cased, because Stripe wants it that way and tills send what they hold.
  expect(intent?.body).toContain("currency=usd");
  // The call that creates money carries the key. Handing the same intent to the
  // same reader twice is one job, so the second does not need it.
  expect(intent?.idempotency).toBe("ticket-42-attempt-1");
  expect(handed?.path).toBe("/terminal/readers/tmr_1/process_payment_intent");
  expect(handed?.body).toBe("payment_intent=pi_abc");
});

test("a reader that refuses the job still returns the reference", async () => {
  reply = (path) =>
    path.endsWith("/payment_intents") ? { id: "pi_abc" } : null;

  const result = await driver().collectOnReader({
    readerId: "tmr_1",
    amountCents: 500,
    currency: "usd",
    idempotencyKey: "k",
  });

  // The payment exists at Stripe even though the reader would not take it, so
  // the till must keep the reference or the money has nowhere to be found.
  expect(result.reference).toBe("pi_abc");
  expect(result.status).toBe("failed");
  expect(result.message).toBeTruthy();
});

test("polling reports waiting, then paid", async () => {
  reply = () => ({
    id: "tmr_1",
    action: {
      status: "in_progress",
      process_payment_intent: { payment_intent: "pi_abc" },
    },
  });
  expect(await driver().readerPayment("tmr_1")).toEqual({
    reference: "pi_abc",
    status: "waiting",
  });

  reply = () => ({
    id: "tmr_1",
    action: {
      status: "succeeded",
      process_payment_intent: { payment_intent: "pi_abc" },
    },
  });
  expect(await driver().readerPayment("tmr_1")).toEqual({
    reference: "pi_abc",
    status: "paid",
  });
});

test("a decline carries Stripe's own words to the cashier", async () => {
  reply = () => ({
    id: "tmr_1",
    action: {
      status: "failed",
      failure_message: "Insert card instead",
      process_payment_intent: { payment_intent: "pi_abc" },
    },
  });

  const result = await driver().readerPayment("tmr_1");

  expect(result.status).toBe("failed");
  // Not rewritten. "Card declined" over the top of "insert card instead" is the
  // kind of help that costs a sale.
  expect(result.message).toBe("Insert card instead");
});

test("a cleared reader reads as waiting, not as a verdict", async () => {
  // A reader with no action has finished and been cleared, which looks exactly
  // like one never asked. Guessing either way is worse than waiting.
  reply = () => ({ id: "tmr_1", action: null });
  expect(await driver().readerPayment("tmr_1")).toEqual({
    reference: "",
    status: "waiting",
  });
});

test("cancelling asks the reader to stop and takes nothing", async () => {
  reply = () => ({ id: "tmr_1", action: null });
  await driver().cancelReaderPayment("tmr_1");
  expect(seen[0]?.path).toBe("/terminal/readers/tmr_1/cancel_action");
  expect(seen[0]?.method).toBe("POST");
});
