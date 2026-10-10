import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import { recordCreditMovement } from "@sentrello/db/customer-credit";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import invoicing from "./index";

/**
 * One button, pressed ten times at once.
 *
 * Every route here reads the invoice, decides, and then writes. Ten requests
 * that all read before any of them wrote all decide the same way, so a check
 * that is only a read lets every one of them through: ten payments of the full
 * balance, ten credit notes for the whole invoice, ten draws on one customer's
 * credit. Each test fires the same request ten times together and counts what
 * reached the books.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const app = new Hono<SentrelloEnv>();
const TIMES = 10;
const SLOW = 30_000;

let orgId: string;
let headers: Headers;
let contactId: string;
let userId: string;

const call = (path: string, body?: unknown) =>
  app.request(`http://localhost${path}`, {
    method: "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const tenAtOnce = (path: string, body?: unknown) =>
  Promise.all(Array.from({ length: TIMES }, () => call(path, body)));

const codes = (results: Response[]) => results.map((r) => r.status);

beforeAll(async () => {
  invoicing.register({
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
    email: `pressed-twice-${suffix}@example.test`,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  userId = signUp.response.user.id;
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Pressed Twice ${suffix}`, slug: `pressed-twice-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  const [contact] = await db
    .insert(schema.contacts)
    .values({ organizationId: orgId, name: "Okafor & Co", email: "o@o.test" })
    .returning();
  if (!contact) throw new Error("could not create a test contact");
  contactId = contact.id;
});

afterAll(async () => {
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  await db.delete(schema.session).where(eq(schema.session.userId, userId));
  await db.delete(schema.account).where(eq(schema.account.userId, userId));
  await db.delete(schema.user).where(eq(schema.user.id, userId));
});

// The void-rollback test closes the books; nothing else wants them closed.
afterEach(async () => {
  await db
    .delete(schema.ledgerSettings)
    .where(eq(schema.ledgerSettings.organizationId, orgId));
});

/** A draft for 500.00, or the same issued. */
async function anInvoice(issue = true): Promise<string> {
  const made = (await (
    await call("/api/invoices", {
      status: "draft",
      contactId,
      lines: [
        { description: "Survey", quantityMilli: 1000, unitPriceCents: 50_000 },
      ],
    })
  ).json()) as { invoice: { id: string; totalCents: number } };
  if (issue) {
    const res = await call(`/api/invoices/${made.invoice.id}/issue`);
    if (res.status !== 200) throw new Error(`issue said ${res.status}`);
  }
  return made.invoice.id;
}

async function totalOf(invoiceId: string) {
  const [row] = await db
    .select({ totalCents: schema.invoices.totalCents })
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoiceId));
  return row?.totalCents ?? 0;
}

async function paymentsOn(invoiceId: string) {
  return db
    .select({ id: schema.payments.id, cents: schema.payments.amountCents })
    .from(schema.payments)
    .where(eq(schema.payments.invoiceId, invoiceId));
}

async function entriesFrom(sources: string[]) {
  if (sources.length === 0) return [];
  return db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(
      and(
        eq(schema.journalEntries.organizationId, orgId),
        inArray(schema.journalEntries.source, sources),
      ),
    );
}

test(
  "issuing one draft ten times at once posts it once",
  async () => {
    const id = await anInvoice(false);
    const results = await tenAtOnce(`/api/invoices/${id}/issue`);
    expect(codes(results).filter((c) => c === 200)).toHaveLength(1);
    expect(codes(results).filter((c) => c === 409)).toHaveLength(TIMES - 1);
    expect(await entriesFrom([`invoice:${id}`])).toHaveLength(1);
  },
  SLOW,
);

test(
  "voiding one invoice ten times at once reverses it once",
  async () => {
    const id = await anInvoice();
    const results = await tenAtOnce(`/api/invoices/${id}/void`);
    expect(codes(results).filter((c) => c === 200)).toHaveLength(1);
    const issued = await entriesFrom([`invoice:${id}`]);
    expect(issued).toHaveLength(1);
    expect(
      await entriesFrom(issued.map((e) => `reversal:${e.id}`)),
    ).toHaveLength(1);
  },
  SLOW,
);

test(
  "paying the whole balance ten times at once takes it once",
  async () => {
    const id = await anInvoice();
    const total = await totalOf(id);
    const results = await tenAtOnce(`/api/invoices/${id}/payments`, {
      amountCents: total,
    });
    expect(codes(results).filter((c) => c === 201)).toHaveLength(1);

    const paid = await paymentsOn(id);
    expect(paid).toHaveLength(1);
    expect(paid.reduce((s, p) => s + p.cents, 0)).toBe(total);
    expect(await entriesFrom(paid.map((p) => `payment:${p.id}`))).toHaveLength(
      1,
    );
  },
  SLOW,
);

test(
  "ten part-payments at once never take more than is owed",
  async () => {
    const id = await anInvoice();
    const total = await totalOf(id);
    // Each a third: three fit, the rest would go over.
    await tenAtOnce(`/api/invoices/${id}/payments`, {
      amountCents: Math.floor(total / 3),
    });
    const paid = await paymentsOn(id);
    expect(paid.reduce((s, p) => s + p.cents, 0)).toBeLessThanOrEqual(total);
    expect(paid.length).toBeLessThanOrEqual(3);
  },
  SLOW,
);

test(
  "crediting the whole invoice ten times at once makes one credit note",
  async () => {
    const id = await anInvoice();
    const results = await tenAtOnce(`/api/invoices/${id}/credit`);
    expect(codes(results).filter((c) => c === 201)).toHaveLength(1);
    const notes = await db
      .select({ id: schema.invoices.id })
      .from(schema.invoices)
      .where(eq(schema.invoices.referenceInvoiceId, id));
    expect(notes).toHaveLength(1);
  },
  SLOW,
);

test(
  "applying held credit ten times at once spends it once",
  async () => {
    const id = await anInvoice();
    const total = await totalOf(id);
    await recordCreditMovement({
      organizationId: orgId,
      contactId,
      cents: total * 3,
      reason: "held for the test",
    });

    const results = await tenAtOnce(`/api/invoices/${id}/apply-credit`);
    expect(codes(results).filter((c) => c === 200)).toHaveLength(1);
    const paid = await paymentsOn(id);
    expect(paid).toHaveLength(1);
    expect(paid[0]?.cents).toBe(total);

    // Spend what is left so the next test starts from nothing.
    await recordCreditMovement({
      organizationId: orgId,
      contactId,
      cents: -total * 2,
      reason: "cleared after the test",
    });
  },
  SLOW,
);

test(
  "one customer's credit spent on ten invoices at once never goes below zero",
  async () => {
    const ids = await Promise.all(
      Array.from({ length: TIMES }, () => anInvoice()),
    );
    const total = await totalOf(ids[0] as string);
    await recordCreditMovement({
      organizationId: orgId,
      contactId,
      cents: total,
      reason: "enough for one invoice",
    });

    await Promise.all(
      ids.map((id) => call(`/api/invoices/${id}/apply-credit`)),
    );

    const spent = await db
      .select({ cents: schema.payments.amountCents })
      .from(schema.payments)
      .where(
        and(
          inArray(schema.payments.invoiceId, ids),
          eq(schema.payments.method, "credit"),
        ),
      );
    expect(spent.reduce((s, p) => s + p.cents, 0)).toBe(total);
  },
  SLOW,
);

test(
  "a void and a payment at once cannot both land",
  async () => {
    const id = await anInvoice();
    const total = await totalOf(id);
    const [voided, paid] = await Promise.all([
      call(`/api/invoices/${id}/void`),
      call(`/api/invoices/${id}/payments`, { amountCents: total }),
    ]);
    expect(voided.status === 200 && paid.status === 201).toBe(false);
  },
  SLOW,
);

async function aQuote(): Promise<string> {
  const made = (await (
    await call("/api/quotes", {
      contactId,
      lines: [
        { description: "Survey", quantityMilli: 1000, unitPriceCents: 50_000 },
      ],
    })
  ).json()) as { quote: { id: string } };
  return made.quote.id;
}

test(
  "converting one quote ten times at once raises one invoice",
  async () => {
    const id = await aQuote();
    const results = await tenAtOnce(`/api/quotes/${id}/convert`);
    expect(codes(results).filter((c) => c === 201)).toHaveLength(1);
    const raised = await db
      .select({ id: schema.invoices.id })
      .from(schema.invoices)
      .where(eq(schema.invoices.quoteId, id));
    expect(raised).toHaveLength(1);
  },
  SLOW,
);

test(
  "ten quotes from one deal at once all come back",
  async () => {
    const [deal] = await db
      .insert(schema.deals)
      .values({
        organizationId: orgId,
        name: "Roof survey",
        amountCents: 50_000,
        contactIds: [contactId],
      })
      .returning();
    if (!deal) throw new Error("no deal");
    const results = await tenAtOnce(`/api/deals/${deal.id}/quote`);
    expect(codes(results).every((c) => c === 201)).toBe(true);
  },
  SLOW,
);

/**
 * Not a double press, but the same freeze: a transaction that takes the
 * document counter and then asks the pool for a second connection. Ten at once
 * left nine waiting on the counter and the tenth waiting on a connection.
 */
test(
  "ten invoices raised and posted at once all come back",
  async () => {
    const results = await tenAtOnce("/api/invoices", {
      contactId,
      lines: [
        { description: "Survey", quantityMilli: 1000, unitPriceCents: 50_000 },
      ],
    });
    expect(codes(results).every((c) => c === 201)).toBe(true);
  },
  SLOW,
);

/**
 * The void and its reversal are one commit.
 *
 * The reversal was posted after the void committed, so a posting that failed
 * left a void invoice whose receivable was still in the books. Closing the
 * books through tomorrow makes today's reversal refuse; the void must go back
 * with it.
 */
test(
  "a void whose reversal is refused leaves the invoice as it was",
  async () => {
    const id = await anInvoice();
    await db.insert(schema.ledgerSettings).values({
      organizationId: orgId,
      closedThrough: new Date(Date.now() + 2 * 86_400_000),
    });
    const res = await call(`/api/invoices/${id}/void`);
    expect(res.status).not.toBe(200);
    const [row] = await db
      .select({ status: schema.invoices.status })
      .from(schema.invoices)
      .where(eq(schema.invoices.id, id));
    expect(row?.status).toBe("open");
  },
  SLOW,
);
