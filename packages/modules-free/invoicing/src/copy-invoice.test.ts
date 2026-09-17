import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import { RATE_SCALE, toBaseCents } from "@sentrello/db/currency";
import { copyInvoice } from "@sentrello/db/documents";
import { ledgerRows } from "@sentrello/db/ledger";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import invoicing from "./index";

/**
 * A copy that quietly loses a field asks the customer for a different amount
 * than the document it came from.
 *
 * The one that mattered most was the exchange rate: `copyInvoice` never set
 * `rateMicro`, so every copy took the column default of 1:1 and a euro invoice
 * went into a dollar ledger at face value. In the recurring path that happens
 * monthly, unattended, with nobody looking, and the books drift further from
 * the business with each run. The rest of this file is the same defect wearing
 * its other faces — the customer's own reference, the early-payment terms, the
 * exemption certificate that justifies a zero-rating, and a credit note that
 * came out the other side as an invoice.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const email = `copy-invoice-${suffix}@example.test`;
const app = new Hono<SentrelloEnv>();

/** Two euro rates: one the source was raised at, one that applies today. */
const OLD_EUR = 1_100_000;
const TODAY_EUR = 1_320_000;

let orgId: string;
let headers: Headers;
let contactId: string;
let otherContactId: string;

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
    email,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Copy Invoice ${suffix}`, slug: `copy-invoice-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  const contacts = await db
    .insert(schema.contacts)
    .values([
      { organizationId: orgId, name: "Brandt GmbH", email: "b@b.test" },
      { organizationId: orgId, name: "Somebody Else", email: "e@b.test" },
    ])
    .returning();
  const [first, second] = contacts;
  if (!first || !second) throw new Error("could not create test contacts");
  contactId = first.id;
  otherContactId = second.id;

  // The euro, priced twice: a year ago and this month.
  await db.insert(schema.exchangeRates).values([
    {
      organizationId: orgId,
      code: "EUR",
      rateMicro: OLD_EUR,
      asOf: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
    },
    {
      organizationId: orgId,
      code: "EUR",
      rateMicro: TODAY_EUR,
      asOf: new Date(Date.now() - 24 * 60 * 60 * 1000),
    },
  ]);
});

afterAll(async () => {
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
  const invoices = await db
    .select({ id: schema.invoices.id })
    .from(schema.invoices)
    .where(eq(schema.invoices.organizationId, orgId));
  const invoiceIds = invoices.map((i) => i.id);
  if (invoiceIds.length > 0) {
    await db
      .delete(schema.invoiceLines)
      .where(inArray(schema.invoiceLines.invoiceId, invoiceIds));
  }
  for (const [table, column] of [
    [schema.journalEntries, schema.journalEntries.organizationId],
    [schema.documentTaxes, schema.documentTaxes.organizationId],
    [schema.taxDefinitions, schema.taxDefinitions.organizationId],
    [schema.invoices, schema.invoices.organizationId],
    [schema.accounts, schema.accounts.organizationId],
    [schema.contacts, schema.contacts.organizationId],
    [schema.exchangeRates, schema.exchangeRates.organizationId],
    [schema.documentCounters, schema.documentCounters.organizationId],
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

/** A euro invoice, then aged so it carries last year's rate. */
async function euroInvoice(
  totalCents = 120_000,
): Promise<typeof schema.invoices.$inferSelect> {
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "EUR",
      lines: [
        { description: "Retainer", quantity: 1, unitPriceCents: totalCents },
      ],
    }),
  });
  expect(res.status).toBe(201);
  const { invoice } = (await res.json()) as {
    invoice: typeof schema.invoices.$inferSelect;
  };
  const [aged] = await db
    .update(schema.invoices)
    .set({ rateMicro: OLD_EUR })
    .where(eq(schema.invoices.id, invoice.id))
    .returning();
  if (!aged) throw new Error("could not age the source invoice");
  return aged;
}

async function duplicate(id: string): Promise<Response> {
  return app.request(`http://localhost/api/invoices/${id}/duplicate`, {
    method: "POST",
    headers,
  });
}

async function invoiceRow(id: string) {
  const [row] = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.id, id));
  if (!row) throw new Error("invoice not found");
  return row;
}

test("a copied foreign-currency invoice carries a rate, and not 1:1", async () => {
  const source = await euroInvoice();
  const res = await duplicate(source.id);
  expect(res.status).toBe(201);
  const { invoice } = (await res.json()) as {
    invoice: typeof schema.invoices.$inferSelect;
  };

  const copy = await invoiceRow(invoice.id);
  // The defect: the column default, which says a euro is a dollar.
  expect(copy.rateMicro).not.toBe(RATE_SCALE);
  // Re-derived at the copy's own date, not inherited from a year ago.
  expect(copy.rateMicro).toBe(TODAY_EUR);
  expect(copy.rateMicro).not.toBe(source.rateMicro);
});

test("issuing the copy posts the converted figure, to the cent", async () => {
  const source = await euroInvoice(250_000);
  const res = await duplicate(source.id);
  const { invoice } = (await res.json()) as {
    invoice: typeof schema.invoices.$inferSelect;
  };

  const issued = await app.request(
    `http://localhost/api/invoices/${invoice.id}/issue`,
    { method: "POST", headers },
  );
  expect(issued.status).toBe(200);

  const copy = await invoiceRow(invoice.id);
  const expected = toBaseCents(copy.totalCents, TODAY_EUR);
  // €2,500.00 at 1.32 is $3,300.00 — and at par it would have been $2,500.00.
  expect(expected).toBe(330_000);

  const [entry] = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(
      and(
        eq(schema.journalEntries.organizationId, orgId),
        eq(schema.journalEntries.source, `invoice:${invoice.id}`),
      ),
    );
  if (!entry) throw new Error("the copy was issued and posted nothing");
  const rows = (await ledgerRows(orgId)).filter(
    (r) => r.entryId === entry.id && r.code === "1100",
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]?.debitCents).toBe(expected);
  expect(expected).not.toBe(copy.totalCents);
});

test("a rate the caller already looked up is used rather than read again", async () => {
  // The recurring run reads one rate for the batch; a second lookup here could
  // disagree with the figure the rest of that run is working from.
  const source = await euroInvoice();
  const copy = await copyInvoice(orgId, source.id, {
    status: "open",
    rateMicro: 1_234_567,
  });
  expect(copy?.rateMicro).toBe(1_234_567);
});

test("a currency the business has never priced is refused, and nothing is written", async () => {
  const source = await euroInvoice();
  // A currency with no rate on file. Set on the row because the invoice screen
  // makes the same refusal and would not let one be raised.
  await db
    .update(schema.invoices)
    .set({ currency: "SEK" })
    .where(eq(schema.invoices.id, source.id));

  const before = await db
    .select({ id: schema.invoices.id })
    .from(schema.invoices)
    .where(eq(schema.invoices.organizationId, orgId));

  const res = await duplicate(source.id);
  expect(res.status).toBe(400);
  expect((await res.json()) as { error: string }).toMatchObject({
    error: expect.stringContaining("SEK"),
  });

  // Refused before anything was inserted — not a half-made invoice at 1:1.
  const after = await db
    .select({ id: schema.invoices.id })
    .from(schema.invoices)
    .where(eq(schema.invoices.organizationId, orgId));
  expect(after).toHaveLength(before.length);
});

test("everything that makes the original correct travels; everything that happened to it does not", async () => {
  const source = await euroInvoice();
  const certificateId = crypto.randomUUID();
  await db
    .update(schema.invoices)
    .set({
      buyerReference: "PO-99812",
      earlyDiscountType: "percent",
      earlyDiscountValue: 200,
      earlyDiscountDays: 14,
      exemptionCertificateId: certificateId,
      // Facts about the original document, not about the sale.
      earlyDiscountTakenCents: 2_400,
      shareToken: `tok-${suffix}`,
      published: true,
      viewCount: 7,
      lateFeeCents: 5_000,
      lateFeeAppliedAt: new Date(),
      lastReminderAt: new Date(),
    })
    .where(eq(schema.invoices.id, source.id));

  const res = await duplicate(source.id);
  expect(res.status).toBe(201);
  const { invoice } = (await res.json()) as {
    invoice: typeof schema.invoices.$inferSelect;
  };
  const copy = await invoiceRow(invoice.id);

  expect(copy.buyerReference).toBe("PO-99812");
  expect(copy.earlyDiscountType).toBe("percent");
  expect(copy.earlyDiscountValue).toBe(200);
  expect(copy.earlyDiscountDays).toBe(14);
  expect(copy.exemptionCertificateId).toBe(certificateId);

  expect(copy.earlyDiscountTakenCents).toBe(0);
  expect(copy.shareToken).toBeNull();
  expect(copy.published).toBe(false);
  expect(copy.viewCount).toBe(0);
  expect(copy.lateFeeCents).toBe(0);
  expect(copy.lateFeeAppliedAt).toBeNull();
  expect(copy.lastReminderAt).toBeNull();
  expect(copy.quoteId).toBeNull();
});

test("an exemption certificate does not follow the copy to a different buyer", async () => {
  // The certificate is one buyer's paperwork, and it is the reason the document
  // carries no tax. Carrying it to somebody else justifies a zero-rating with a
  // stranger's evidence.
  const source = await euroInvoice();
  const certificateId = crypto.randomUUID();
  await db
    .update(schema.invoices)
    .set({ exemptionCertificateId: certificateId })
    .where(eq(schema.invoices.id, source.id));

  const same = await copyInvoice(orgId, source.id, { contactId });
  expect(same?.exemptionCertificateId).toBe(certificateId);

  const moved = await copyInvoice(orgId, source.id, {
    contactId: otherContactId,
  });
  expect(moved?.contactId).toBe(otherContactId);
  expect(moved?.exemptionCertificateId).toBeNull();
});

test("a credit note is refused rather than copied into an invoice", async () => {
  const source = await euroInvoice();
  await app.request(`http://localhost/api/invoices/${source.id}/issue`, {
    method: "POST",
    headers,
  });
  const credited = await app.request(
    `http://localhost/api/invoices/${source.id}/credit`,
    { method: "POST", headers, body: JSON.stringify({}) },
  );
  expect(credited.status).toBe(201);
  const { creditNote } = (await credited.json()) as {
    creditNote: typeof schema.invoices.$inferSelect;
  };
  expect(creditNote.kind).toBe("credit_note");

  const res = await duplicate(creditNote.id);
  expect(res.status).toBe(400);
  // Never a plain invoice carrying a credit note's figures and reference.
  const copies = await db
    .select({ id: schema.invoices.id })
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.organizationId, orgId),
        eq(schema.invoices.referenceInvoiceId, source.id),
      ),
    );
  expect(copies).toHaveLength(1);
});

test("a copy of an invoice that is not this business's is still not found", async () => {
  // The refusals above must not have turned a 404 into an error with detail.
  const res = await duplicate(crypto.randomUUID());
  expect(res.status).toBe(404);
});

// ---------------------------------------------------------------------------
// The same omission, two doors along
// ---------------------------------------------------------------------------

/**
 * A quote becoming an invoice is a copy too, and had the identical defect.
 *
 * Worse in one respect: the single conversion posts to the ledger immediately,
 * so an accepted euro quote put euro cents into dollar books before anybody
 * opened the document. The instalment plan makes drafts, which post the same
 * way the moment each stage is issued.
 */
async function euroQuote(
  unitPriceCents = 200_000,
  currency = "EUR",
): Promise<{ id: string; number: string }> {
  const res = await app.request("http://localhost/api/quotes", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency,
      lines: [
        { description: "Fit-out", quantity: 1, unitPrice: unitPriceCents },
      ],
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { quote: { id: string; number: string } })
    .quote;
}

test("a converted euro quote is an invoice at today's rate, posted converted", async () => {
  const quote = await euroQuote(200_000);
  const res = await app.request(
    `http://localhost/api/quotes/${quote.id}/convert`,
    { method: "POST", headers },
  );
  expect(res.status).toBe(201);
  const { invoice } = (await res.json()) as { invoice: { id: string } };

  const row = await invoiceRow(invoice.id);
  expect(row.rateMicro).toBe(TODAY_EUR);
  expect(row.rateMicro).not.toBe(RATE_SCALE);

  const [entry] = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(
      and(
        eq(schema.journalEntries.organizationId, orgId),
        eq(schema.journalEntries.source, `invoice:${invoice.id}`),
      ),
    );
  if (!entry) throw new Error("converting a quote posted nothing");
  const ar = (await ledgerRows(orgId)).filter(
    (r) => r.entryId === entry.id && r.code === "1100",
  );
  // €2,000.00 at 1.32 is $2,640.00; at par it would have been $2,000.00.
  expect(ar).toHaveLength(1);
  expect(ar[0]?.debitCents).toBe(toBaseCents(row.totalCents, TODAY_EUR));
  expect(ar[0]?.debitCents).toBe(264_000);
});

test("a quote in a currency nobody has priced is declined, not booked at par", async () => {
  const quote = await euroQuote(90_000);
  await db
    .update(schema.quotes)
    .set({ currency: "SEK" })
    .where(eq(schema.quotes.id, quote.id));

  const res = await app.request(
    `http://localhost/api/quotes/${quote.id}/convert`,
    { method: "POST", headers },
  );
  expect(res.status).toBe(400);
  expect((await res.json()) as { error: string }).toMatchObject({
    error: expect.stringContaining("SEK"),
  });

  // The quote is still answerable once somebody records a rate.
  const [after] = await db
    .select({ convertedInvoiceId: schema.quotes.convertedInvoiceId })
    .from(schema.quotes)
    .where(eq(schema.quotes.id, quote.id));
  expect(after?.convertedInvoiceId).toBeNull();
});

test("every instalment of a split quote carries the rate", async () => {
  const quote = await euroQuote(300_000);
  const res = await app.request(
    `http://localhost/api/quotes/${quote.id}/convert`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        instalments: [
          { shareBp: 5_000, dueInDays: 0, label: "Deposit" },
          { shareBp: 5_000, dueInDays: 30, label: "On completion" },
        ],
      }),
    },
  );
  expect(res.status).toBe(201);
  const { invoices } = (await res.json()) as { invoices: { id: string }[] };
  expect(invoices).toHaveLength(2);
  for (const made of invoices) {
    const row = await invoiceRow(made.id);
    expect(row.rateMicro).toBe(TODAY_EUR);
  }
});

test("an unpriced currency stops the whole instalment plan, not half of it", async () => {
  const quote = await euroQuote(300_000);
  await db
    .update(schema.quotes)
    .set({ currency: "SEK" })
    .where(eq(schema.quotes.id, quote.id));
  const before = await db
    .select({ id: schema.invoices.id })
    .from(schema.invoices)
    .where(eq(schema.invoices.organizationId, orgId));

  const res = await app.request(
    `http://localhost/api/quotes/${quote.id}/convert`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        instalments: [
          { shareBp: 5_000, dueInDays: 0 },
          { shareBp: 5_000, dueInDays: 30 },
        ],
      }),
    },
  );
  expect(res.status).toBe(400);
  const after = await db
    .select({ id: schema.invoices.id })
    .from(schema.invoices)
    .where(eq(schema.invoices.organizationId, orgId));
  expect(after).toHaveLength(before.length);
});
