/**
 * Hearing from a payment processor, declared rather than hard-coded.
 *
 * A processor's webhook is the only thing that proves money moved: a buyer
 * returning to a success page proves they came back from a payment page, not
 * that a card was charged. So whichever module is waiting on that money has to
 * be the one the event reaches.
 *
 * It used to reach exactly one place. The URL handed to Stripe when a business
 * connected its keys named the Shop's endpoint, and nothing else. An invoice
 * paid by card therefore arrived at the Shop, which did not recognise the
 * event, ignored it, and answered 200 — the payment succeeded, the invoice
 * stayed open, and the customer was chased for money they had already paid.
 *
 * The defect was not that one module was missing from a list. It was that
 * there was a list at all, written once, in the file that sets up the
 * endpoint. So a module now **declares** that it listens — the same way it
 * declares nav, widgets, summaries and account sections — and the host runs
 * whatever this instance loaded. Shop is a consumer, invoicing is a consumer,
 * and the next module that takes money is one too without anybody editing the
 * connection screen.
 */

/** The verified event, offered to each module that listens. */
export interface PaymentWebhookDelivery {
  /** "stripe" | "paypal" | whatever else is connected. */
  provider: string;
  /** Whose instance it is — resolved from the connection, never from the body. */
  organizationId: string;
  /** The processor's own id for the event, for anything that logs or dedupes. */
  eventId: string;
  /** The processor's own name for what happened. */
  eventType: string;
  /**
   * The body exactly as it arrived.
   *
   * Raw, never a parsed object: the signature was computed over these bytes,
   * and a consumer that re-serialises before checking anything is a consumer
   * that can be fed a different document from the one that was signed.
   */
  raw: string;
  headers: Headers;
}

export interface PaymentWebhookConsumer {
  /**
   * Which processors this module wants to hear from. Left off, it hears from
   * all of them — which is right for anything keyed on its own metadata.
   */
  providers?: string[];
  /**
   * Offered the event. Answer true if this module recognised it and acted.
   *
   * False is not a failure — most events belong to somebody else, and saying
   * so is how the host knows the event found a home at all. Throwing *is* a
   * failure: the host answers 500 so the processor retries, because an event
   * dropped after being accepted is money moving with nothing recording it.
   */
  handle: (delivery: PaymentWebhookDelivery) => Promise<boolean> | boolean;
}

export interface RegisteredPaymentWebhook extends PaymentWebhookConsumer {
  moduleId: string;
}

/**
 * Module scope, not a class — the same arrangement as `widgets.ts`, and for
 * the same reason: every module resolves the SDK to the host's copy, so this
 * is one array for all of them. The host clears it before loading, because the
 * boot tests load modules more than once in one process.
 */
const registry: RegisteredPaymentWebhook[] = [];

/**
 * By module *and* by what it listens to.
 *
 * Replacing on the module id alone made a module with more than one ear
 * impossible: a Stripe consumer followed by a PayPal one left only PayPal, in
 * silence, which is this facility's own founding failure — an event arriving
 * somewhere that does not recognise it, money moving and nothing recording
 * it. The contract invites two, since `providers` belongs to the consumer
 * rather than to the module.
 *
 * The same module and the same providers still replaces, because that is a
 * second load of one module and a consumer offered the event twice would
 * confirm a payment twice.
 */
const listensTo = (c: RegisteredPaymentWebhook) =>
  `${c.moduleId} ${[...(c.providers ?? [])].sort().join(",")}`;

export function addPaymentWebhook(consumer: RegisteredPaymentWebhook): void {
  const key = listensTo(consumer);
  const at = registry.findIndex((w) => listensTo(w) === key);
  if (at >= 0) registry[at] = consumer;
  else registry.push(consumer);
}

/** Everyone listening, in registration order. */
export function paymentWebhookConsumers(
  provider?: string,
): RegisteredPaymentWebhook[] {
  return registry.filter(
    (c) => !provider || !c.providers || c.providers.includes(provider),
  );
}

/** For tests and for a host that loads its modules more than once. */
export function clearPaymentWebhooks(): void {
  registry.length = 0;
}

/**
 * The processor's own id and name for an event.
 *
 * Read from the body rather than asked of the provider, because every
 * processor puts them at the top level under one of two spellings and a method
 * per provider would be three files to keep in step for two fields. An event
 * with neither is still delivered — it is simply one nothing can dedupe, which
 * is worth knowing rather than worth refusing.
 */
export function identifyPaymentEvent(raw: string): {
  eventId: string;
  eventType: string;
} {
  try {
    const body = JSON.parse(raw) as Record<string, unknown>;
    return {
      eventId: typeof body.id === "string" ? body.id : "",
      eventType:
        typeof body.type === "string"
          ? body.type
          : typeof body.event_type === "string"
            ? body.event_type
            : "",
    };
  } catch {
    return { eventId: "", eventType: "" };
  }
}
