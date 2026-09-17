import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import {
  CORE_ACCOUNTS,
  ensureAccount,
  postJournalEntry,
} from "@sentrello/db/ledger";
import { invoiceStatus } from "@sentrello/db/money";
import type {
  PaymentWebhookDelivery,
  SentrelloEnv,
} from "@sentrello/module-sdk";
import {
  addPaymentWebhook,
  clearPaymentWebhooks,
  secrets,
} from "@sentrello/module-sdk";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { registerPaymentWebhookEndpoint } from "./payment-webhook";

/**
 * The failure this endpoint exists to end.
 *
 * A customer paid an invoice by card. Stripe was pointed at the one endpoint
 * the connect screen knew how to name — the Shop's — which did not recognise
 * the event, answered 200 and dropped it. The money was taken, the invoice
 * stayed open, and the customer was chased for a bill they had already paid.
 * Nothing anywhere recorded that an event had arrived.
 *
 * So the three things below are the three that were wrong: the event has to
 * reach whichever module is waiting for it, it has to do so exactly once
 * however many times the processor retries, and an event nobody claims has to
 * leave a trace.
 *
 * The consumer here stands in for the invoicing one: it records the payment
 * and posts the balanced entry, which is what any consumer of a payment event
 * has to do. Core cannot import the paid bundle that owns the real one, and a
 * stand-in that does the same work at the same seam is what proves the seam.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const email = `payhook-${suffix}@example.test`;
const app = new Hono<SentrelloEnv>();
const SECRET = `whsec_${suffix}`;

let orgId: string;
let headers: Headers;
let invoiceId: string;

/** Signs exactly as Stripe does, so the test proves the check, not itself. */
async function signed(raw: string): Promise<Headers> {
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${raw}`),
  );
  const hex = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return new Headers({
    "content-type": "application/json",
    "stripe-signature": `t=${timestamp},v1=${hex}`,
  });
}

/** A Stripe checkout session that paid an invoice, as Stripe sends it. */
const paidEvent = (eventId: string, amountCents: number) =>
  JSON.stringify({
    id: eventId,
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_${eventId}`,
        payment_status: "paid",
        amount_total: amountCents,
        metadata: { invoice_id: invoiceId },
      },
    },
  });

/**
 * What a payment consumer has to do: write the payment, restate the invoice,
 * and post the two sides. Counted, so "delivered twice" can be told from
 * "handled twice".
 */
let handled = 0;
async function recordTheCardPayment(
  delivery: PaymentWebhookDelivery,
): Promise<boolean> {
  const event = JSON.parse(delivery.raw) as {
    type?: string;
    data?: { object?: Record<string, unknown> };
  };
  if (event.type !== "checkout.session.completed") return false;
  const session = event.data?.object ?? {};
  const forInvoice = (session.metadata as { invoice_id?: string } | undefined)
    ?.invoice_id;
  if (!forInvoice) return false;
  handled += 1;

  const amountCents = Number(session.amount_total ?? 0);
  const [payment] = await db
    .insert(schema.payments)
    .values({
      organizationId: delivery.organizationId,
      invoiceId: forInvoice,
      amountCents,
      method: "stripe",
      gatewayRef: String(session.id),
    })
    .returning();
  if (!payment) throw new Error("payment insert returned no row");

  const [invoice] = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.id, forInvoice));
  if (!invoice) return true;
  const paid = await db
    .select({ amountCents: schema.payments.amountCents })
    .from(schema.payments)
    .where(eq(schema.payments.invoiceId, forInvoice));
  const { status } = invoiceStatus(
    invoice.totalCents,
    paid.reduce((sum, p) => sum + p.amountCents, 0),
  );
  await db
    .update(schema.invoices)
    .set({ status })
    .where(eq(schema.invoices.id, forInvoice));

  const [cash, ar] = await Promise.all([
    ensureAccount(delivery.organizationId, CORE_ACCOUNTS.cash),
    ensureAccount(delivery.organizationId, CORE_ACCOUNTS.accountsReceivable),
  ]);
  await postJournalEntry(
    delivery.organizationId,
    `Payment for ${invoice.number}`,
    `payment:${payment.id}`,
    [
      { accountId: cash, debitCents: amountCents },
      { accountId: ar, creditCents: amountCents },
    ],
  );
  return true;
}

beforeAll(async () => {
  process.env.SENTRELLO_SECRET_KEY ||= `test-secret-${suffix}`;
  registerPaymentWebhookEndpoint({
    app,
    entitled: () => true,
    registerNav: () => {},
    registerPermission: () => {},
    registerSummary: () => {},
    registerWidget: () => {},
    registerAccountSection: () => {},
    registerSearch: () => {},
    registerPersonalData: () => {},
    registerOnboarding: () => {},
    registerCrawlable: () => {},
    provide: () => {},
    registerJob: () => {},
  });

  const signUp = await signUpAsOwner({
    email,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Payhook ${suffix}`, slug: `payhook-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;

  await db.insert(schema.paymentAccounts).values({
    organizationId: orgId,
    provider: "stripe",
    mode: "test",
    secretKey: secrets.seal("sk_test_never_used"),
    webhookSecret: secrets.seal(SECRET),
    enabled: true,
  });

  const [invoice] = await db
    .insert(schema.invoices)
    .values({
      organizationId: orgId,
      number: `CARD-${suffix}`,
      status: "open",
      subtotalCents: 12_500,
      totalCents: 12_500,
    })
    .returning();
  if (!invoice) throw new Error("invoice insert returned no row");
  invoiceId = invoice.id;
});

afterEach(() => {
  clearPaymentWebhooks();
});

afterAll(async () => {
  clearPaymentWebhooks();
  const entries = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));
  const entryIds = entries.map((e) => e.id);
  if (entryIds.length > 0) {
    await db
      .delete(schema.journalLines)
      .where(inArray(schema.journalLines.entryId, entryIds));
  }
  for (const [table, column] of [
    [schema.journalEntries, schema.journalEntries.organizationId],
    [schema.payments, schema.payments.organizationId],
    [schema.invoices, schema.invoices.organizationId],
    [schema.accounts, schema.accounts.organizationId],
    [schema.paymentWebhookEvents, schema.paymentWebhookEvents.organizationId],
    [schema.paymentAccounts, schema.paymentAccounts.organizationId],
  ] as const) {
    await db.delete(table).where(eq(column, orgId));
  }
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  const [u] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email));
  if (u) {
    await db.delete(schema.session).where(eq(schema.session.userId, u.id));
    await db.delete(schema.account).where(eq(schema.account.userId, u.id));
    await db.delete(schema.user).where(eq(schema.user.id, u.id));
  }
});

async function deliver(raw: string) {
  return app.request("http://localhost/api/payments/webhook/stripe", {
    method: "POST",
    headers: await signed(raw),
    body: raw,
  });
}

test("an invoice paid by card is confirmed, once, and the ledger balances", async () => {
  handled = 0;
  addPaymentWebhook({
    moduleId: "invoicing",
    providers: ["stripe"],
    handle: recordTheCardPayment,
  });

  const eventId = `evt_paid_${suffix}`;
  const first = await deliver(paidEvent(eventId, 12_500));
  expect(first.status).toBe(200);
  expect((await first.json()) as { claimedBy: string | null }).toMatchObject({
    claimedBy: "invoicing",
  });

  const [invoice] = await db
    .select({ status: schema.invoices.status })
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoiceId));
  expect(invoice?.status).toBe("paid");

  const entries = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));
  expect(entries.length).toBe(1);
  const lines = await db
    .select()
    .from(schema.journalLines)
    .where(
      inArray(
        schema.journalLines.entryId,
        entries.map((e) => e.id),
      ),
    );
  expect(lines.reduce((sum, l) => sum + l.debitCents, 0)).toBe(12_500);
  expect(lines.reduce((sum, l) => sum + l.debitCents, 0)).toBe(
    lines.reduce((sum, l) => sum + l.creditCents, 0),
  );

  /*
   * Stripe retries until it gets a 2xx, and it gets one for a failure in the
   * consumer as often as for a success. The same event delivered again has to
   * charge and post once — a second journal entry here is a customer credited
   * twice and a bank reconciliation that can never be made to agree.
   */
  const again = await deliver(paidEvent(eventId, 12_500));
  expect(again.status).toBe(200);
  expect((await again.json()) as { duplicate?: boolean }).toMatchObject({
    duplicate: true,
  });
  expect(handled).toBe(1);

  const payments = await db
    .select({ id: schema.payments.id })
    .from(schema.payments)
    .where(eq(schema.payments.invoiceId, invoiceId));
  expect(payments.length).toBe(1);

  const afterRetry = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));
  expect(afterRetry.length).toBe(1);
});

test("an event no module claims is written down, not swallowed", async () => {
  // Nothing registered: the state of an instance whose modules do not care
  // about this event, which is exactly what the shop endpoint looked like
  // when an invoice payment arrived at it.
  const eventId = `evt_orphan_${suffix}`;
  const res = await deliver(
    JSON.stringify({ id: eventId, type: "charge.dispute.created" }),
  );
  // Still 200: the processor has done nothing wrong and retrying would not
  // help. The difference is that there is now a record.
  expect(res.status).toBe(200);
  expect((await res.json()) as { claimedBy: string | null }).toMatchObject({
    claimedBy: null,
  });

  const [row] = await db
    .select()
    .from(schema.paymentWebhookEvents)
    .where(eq(schema.paymentWebhookEvents.eventId, eventId));
  expect(row?.eventType).toBe("charge.dispute.created");
  expect(row?.claimedBy).toBeNull();
  expect(row?.organizationId).toBe(orgId);

  // And where somebody would actually look: the connections screen.
  const { unclaimedPaymentEvents } = await import("./payment-webhook");
  const unclaimed = await unclaimedPaymentEvents(orgId);
  expect(unclaimed.map((e) => e.eventId)).toContain(eventId);
});

test("an event signed by nobody is refused before anything is written", async () => {
  const eventId = `evt_forged_${suffix}`;
  const raw = JSON.stringify({ id: eventId, type: "payment_intent.succeeded" });
  const res = await app.request(
    "http://localhost/api/payments/webhook/stripe",
    {
      method: "POST",
      headers: new Headers({
        "content-type": "application/json",
        "stripe-signature": "t=1,v1=deadbeef",
      }),
      body: raw,
    },
  );
  expect(res.status).toBe(401);
  const seen = await db
    .select({ id: schema.paymentWebhookEvents.id })
    .from(schema.paymentWebhookEvents)
    .where(eq(schema.paymentWebhookEvents.eventId, eventId));
  expect(seen.length).toBe(0);
});

test("a consumer that throws leaves nothing behind for the retry to trip on", async () => {
  addPaymentWebhook({
    moduleId: "invoicing",
    providers: ["stripe"],
    handle: () => {
      throw new Error("the books were closed");
    },
  });

  const eventId = `evt_thrown_${suffix}`;
  const raw = JSON.stringify({
    id: eventId,
    type: "checkout.session.completed",
  });
  const res = await deliver(raw);
  // 500 so the processor tries again — and the record is taken back, or the
  // retry would be deduped against a delivery that did nothing at all.
  expect(res.status).toBe(500);
  const seen = await db
    .select({ id: schema.paymentWebhookEvents.id })
    .from(schema.paymentWebhookEvents)
    .where(eq(schema.paymentWebhookEvents.eventId, eventId));
  expect(seen.length).toBe(0);
});
