import { and, db, desc, eq, isNull, schema } from "@sentrello/db";
import {
  activePaymentAccount,
  organizationTakingCards,
} from "@sentrello/db/payments";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";
import {
  identifyPaymentEvent,
  paymentWebhookConsumers,
} from "@sentrello/module-sdk";
import { providerFrom } from "./payments";

/**
 * The one door a payment processor knocks on.
 *
 * A processor is pointed at exactly one URL per connection, so whatever is
 * behind that URL decides which parts of the product can hear about money.
 * It used to be one module's endpoint, named in the connection screen: a card
 * payment for an invoice arrived at the shop's handler, which did not
 * recognise it, answered 200, and dropped it. The payment succeeded, the
 * invoice stayed open, and the customer was chased for a bill they had paid.
 *
 * So the door belongs to the platform and the modules declare themselves
 * behind it — `registerPaymentWebhook`, the same shape as every other thing a
 * module declares. Shop is a consumer, invoicing is a consumer, and the next
 * module that takes money is one without this file changing.
 *
 * Three properties, in the order they matter:
 *
 *  - **Verified.** The signature is checked against the connection's own
 *    stored secret before anything is written or dispatched.
 *  - **Once.** Every processor retries. The event is written down before it is
 *    dispatched, under a unique index, so a redelivery loses the insert and
 *    never reaches a consumer — one charge, one journal entry.
 *  - **Never silent.** An event nobody claims is recorded with no claimant and
 *    reported on the payments screen. A processor telling us something we do
 *    not understand is not a no-op; it is the shape of the bug above.
 */

/** Where the screen looks, and the shape a test asserts on. */
export interface UnclaimedEvent {
  provider: string;
  eventId: string;
  eventType: string;
  receivedAt: Date;
}

/** Events no module on this instance recognised, newest first. */
export async function unclaimedPaymentEvents(
  organizationId: string,
  limit = 20,
): Promise<UnclaimedEvent[]> {
  return db
    .select({
      provider: schema.paymentWebhookEvents.provider,
      eventId: schema.paymentWebhookEvents.eventId,
      eventType: schema.paymentWebhookEvents.eventType,
      receivedAt: schema.paymentWebhookEvents.receivedAt,
    })
    .from(schema.paymentWebhookEvents)
    .where(
      and(
        eq(schema.paymentWebhookEvents.organizationId, organizationId),
        isNull(schema.paymentWebhookEvents.claimedBy),
      ),
    )
    .orderBy(desc(schema.paymentWebhookEvents.receivedAt))
    .limit(limit);
}

export function registerPaymentWebhookEndpoint(ctx: ModuleContext) {
  ctx.app.post("/api/payments/webhook/:provider", async (c: RouteContext) => {
    const name = c.req.param("provider") ?? "";

    /*
     * Whose event this is, from the connection rather than from the body.
     *
     * A processor sends no session and no origin header. `organizationTakingCards`
     * answers null rather than guessing when more than one business on an
     * instance has the same provider switched on — guessing would credit one
     * business's payment to another.
     */
    const orgId = await organizationTakingCards(name);
    if (!orgId) return c.json({ error: "not configured" }, 404);

    const account = await activePaymentAccount(orgId, name);
    if (!account) return c.json({ error: "not configured" }, 404);

    const provider = providerFrom(account);
    const raw = await c.req.text();
    if (!(await provider.verifyWebhook(raw, c.req.raw.headers))) {
      return c.json({ error: "invalid signature" }, 401);
    }

    const { eventId, eventType } = identifyPaymentEvent(raw);

    /*
     * Written down before it is acted on, and the unique index decides.
     *
     * Checking first and inserting after would let two deliveries arriving
     * together both pass the check — which is exactly the case a processor's
     * retry produces, and the one that charges a customer twice in the
     * books. An event with no id of its own cannot be deduped and is always
     * dispatched; that is a processor we do not know rather than a payment
     * we can afford to drop.
     */
    let recordId: string | null = null;
    if (eventId) {
      const [written] = await db
        .insert(schema.paymentWebhookEvents)
        .values({
          organizationId: orgId,
          provider: name,
          eventId,
          eventType,
        })
        .onConflictDoNothing()
        .returning({ id: schema.paymentWebhookEvents.id });
      if (!written) {
        // Seen before. Answered 200 so the processor stops retrying.
        return c.json({ ok: true, duplicate: true });
      }
      recordId = written.id;
    }

    /*
     * The record is the promise that this event was handled, so anything
     * that goes wrong from here has to take it back — otherwise the
     * processor's retry is deduped against a delivery that did nothing.
     */
    const forget = async () => {
      if (recordId) {
        await db
          .delete(schema.paymentWebhookEvents)
          .where(eq(schema.paymentWebhookEvents.id, recordId));
      }
    };

    // Some providers have to act before they can report: PayPal captures an
    // approved order here, and the capture is what later reports as paid.
    if (provider.settle) {
      try {
        await provider.settle(raw);
      } catch (err) {
        await forget();
        console.error("[payments] settling the event failed", err);
        // 500 so the processor retries: an approved order nobody captured is
        // money the business agreed to take and never took.
        return c.json({ error: "could not settle" }, 500);
      }
    }

    const delivery = {
      provider: name,
      organizationId: orgId,
      eventId,
      eventType,
      raw,
      headers: c.req.raw.headers,
    };

    let claimedBy: string | null = null;
    for (const consumer of paymentWebhookConsumers(name)) {
      try {
        if (await consumer.handle(delivery)) {
          claimedBy = consumer.moduleId;
          break;
        }
      } catch (err) {
        await forget();
        console.error(
          `[payments] ${consumer.moduleId} could not handle ${eventType || "an event"}`,
          err,
        );
        return c.json({ error: "could not record the payment" }, 500);
      }
    }

    if (claimedBy && recordId) {
      await db
        .update(schema.paymentWebhookEvents)
        .set({ claimedBy })
        .where(eq(schema.paymentWebhookEvents.id, recordId));
    }

    if (!claimedBy) {
      /*
       * Loud, on purpose.
       *
       * The whole failure this endpoint exists to end was an unrecognised
       * event answering 200 with nothing written anywhere. The row above is
       * the durable half and the payments screen reads it; this is the half
       * an operator watching logs sees.
       */
      console.warn(
        `[payments] ${name} sent ${eventType || "an event"} (${eventId || "no id"}) that no module claimed`,
      );
    }

    return c.json({ ok: true, claimedBy });
  });
}
