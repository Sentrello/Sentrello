import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { secrets } from "@sentrello/module-sdk";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import {
  type EInvoiceTransport,
  registerTransport,
} from "./einvoice-transport";
import invoicing from "./index";

/**
 * An invoice leaving the building, and every way it can fail to.
 *
 * The driver itself is covered against a fake `fetch`. This is the route
 * around it: the refusals that have to happen *before* a document reaches
 * the network, and the row that has to exist afterwards whichever way it
 * went.
 *
 * The transport is a fake registered alongside Storecove, which is the whole
 * point of there being an interface — a test does not need somebody's API
 * key, and neither does a country that wants to write its own connector.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const email = `peppol-send-${suffix}@example.test`;
const app = new Hono<SentrelloEnv>();

let orgId: string;
let headers: Headers;
let contactId: string;

/** What the fake was asked to send, so the test can read it back. */
const asked: { ubl: string; to: string }[] = [];
let answer: (() => { reference: string }) | null = null;

const fake: EInvoiceTransport = {
  id: "test-access-point",
  label: "A test access point",
  async check() {
    return { name: "Fake Access Point" };
  },
  async lookup() {
    return { reachable: true };
  },
  async send(document) {
    asked.push({
      ubl: document.ubl,
      to: `${document.to.scheme}:${document.to.identifier}`,
    });
    if (!answer) throw new Error("the access point is having a day of it");
    return answer();
  },
};

beforeAll(async () => {
  registerTransport(fake);
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
    body: { name: `Peppol ${suffix}`, slug: `peppol-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  /*
   * A buyer the network can reach — and an address lives on the *company*,
   * not the person. An e-invoice is addressed to the legal entity being
   * billed rather than to whoever placed the order, which is why a
   * customer saved only as a contact cannot be sent one.
   *
   * Most EU businesses are addressed on Peppol by their VAT number, and a
   * Belgian one is scheme 9925.
   */
  const [company] = await db
    .insert(schema.companies)
    .values({
      organizationId: orgId,
      name: "Kolding Byg",
      country: "BE",
      taxIdentifier: "BE0123456789",
      address: "Rue Haute 12",
      city: "Brussels",
      postcode: "1000",
    })
    .returning();
  if (!company) throw new Error("could not create the customer company");

  const [contact] = await db
    .insert(schema.contacts)
    .values({
      organizationId: orgId,
      companyId: company.id,
      name: "Ines Declercq",
      email: "ap@kolding.test",
    })
    .returning();
  if (!contact) throw new Error("could not create the customer");
  contactId = contact.id;

  /*
   * The seller has a country and a VAT number too. An e-invoice names both
   * parties, and the generator refuses one that does not — which is the
   * right behaviour and the reason this has to be set up rather than
   * assumed.
   */
  await db
    .update(schema.organizations)
    .set({
      countryCode: "BE",
      taxId: "BE0987654321",
      address: "Rue Neuve 1",
      city: "Brussels",
      postcode: "1000",
    })
    .where(eq(schema.organizations.id, orgId));

  /*
   * A rate for the euro, because an invoice in a currency the books have no
   * rate for is refused before it exists — correctly, since it could not be
   * posted. The figure is irrelevant here; the customer's country is what
   * decides the Peppol address.
   */
  await db.insert(schema.exchangeRates).values({
    organizationId: orgId,
    code: "EUR",
    rateMicro: 1_080_000,
  });
});

afterAll(async () => {
  const invoices = await db
    .select({ id: schema.invoices.id })
    .from(schema.invoices)
    .where(eq(schema.invoices.organizationId, orgId));
  const ids = invoices.map((i) => i.id);
  if (ids.length > 0) {
    await db
      .delete(schema.invoiceLines)
      .where(inArray(schema.invoiceLines.invoiceId, ids));
  }
  // Journal lines hang off entries, not off the organisation.
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
    [schema.peppolSubmissions, schema.peppolSubmissions.organizationId],
    [schema.peppolConnections, schema.peppolConnections.organizationId],
    [schema.exchangeRates, schema.exchangeRates.organizationId],
    [schema.journalEntries, schema.journalEntries.organizationId],
    [schema.documentTaxes, schema.documentTaxes.organizationId],
    [schema.invoices, schema.invoices.organizationId],
    [schema.accounts, schema.accounts.organizationId],
    [schema.contacts, schema.contacts.organizationId],
    [schema.companies, schema.companies.organizationId],
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

async function anInvoice() {
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "EUR",
      lines: [
        { description: "Site survey", quantity: 1, unitPriceCents: 45000 },
      ],
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    invoice: typeof schema.invoices.$inferSelect;
  };
  return body.invoice;
}

const send = (id: string) =>
  app.request(`http://localhost/api/invoices/${id}/einvoice/send`, {
    method: "POST",
    headers,
  });

async function connect(provider = fake.id) {
  await db
    .insert(schema.peppolConnections)
    .values({
      organizationId: orgId,
      provider,
      apiKey: secrets.seal("a-test-key"),
      legalEntityId: "le-1",
      sandbox: true,
    })
    .onConflictDoUpdate({
      target: schema.peppolConnections.organizationId,
      set: { provider },
    });
}

const submissionsFor = (invoiceId: string) =>
  db
    .select()
    .from(schema.peppolSubmissions)
    .where(eq(schema.peppolSubmissions.invoiceId, invoiceId));

/**
 * No account, no send — and said in words a business can act on.
 *
 * This is the first thing anybody meets, because a fresh instance has no
 * access point. "Failed to send" would leave them looking at the invoice;
 * the answer is on a settings screen.
 */
test("with nothing connected it says where to go", async () => {
  const invoice = await anInvoice();
  const res = await send(invoice.id);
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toMatch(/access point is connected/i);
  expect(body.error).toMatch(/settings/i);
  // And nothing was recorded, because nothing was attempted.
  expect(await submissionsFor(invoice.id)).toHaveLength(0);
});

test("a document the network would refuse never reaches it", async () => {
  await connect();
  const invoice = await anInvoice();

  /*
   * Peppol wants a buyer reference, and this invoice has none — so the
   * refusal has to come from us, before the access point is billed for a
   * document its own validation would throw out. Checked by the fake not
   * having been asked.
   */
  const before = asked.length;
  const res = await send(invoice.id);
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string; missing: string[] };
  expect(body.missing.length).toBeGreaterThan(0);
  expect(asked.length).toBe(before);
});

/**
 * A buyer with an address but nothing to address them *by*.
 *
 * Belgium, a street, a postcode — and no VAT number, so there is no
 * identifier the network knows them under. The document validator catches
 * it first and says where to put one, which is the message worth asserting
 * because it is the one a business reads.
 *
 * The route checks again afterwards, and that is deliberate rather than
 * redundant: the validator answers for the profile being sent, and a
 * profile that did not demand an electronic address would otherwise hand a
 * document to the access point addressed to nobody.
 */
test("a customer with no electronic address is named, not guessed at", async () => {
  await connect();
  const [unlisted] = await db
    .insert(schema.companies)
    .values({
      organizationId: orgId,
      name: "Nobody Ltd",
      country: "BE",
      address: "Rue Basse 3",
      city: "Brussels",
      postcode: "1000",
    })
    .returning();
  if (!unlisted) throw new Error("could not create the second company");
  const [nameless] = await db
    .insert(schema.contacts)
    .values({
      organizationId: orgId,
      companyId: unlisted.id,
      name: "Someone There",
    })
    .returning();
  if (!nameless) throw new Error("could not create the second customer");

  const made = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId: nameless.id,
      currency: "EUR",
      buyerReference: "PO-1",
      lines: [{ description: "Work", quantity: 1, unitPriceCents: 1000 }],
    }),
  });
  const { invoice } = (await made.json()) as {
    invoice: typeof schema.invoices.$inferSelect;
  };

  const res = await send(invoice.id);
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  // Where to put one, not merely that it is absent.
  expect(body.error).toMatch(/electronic address/);
  expect(body.error).toMatch(/company record/);
});

test("a send that works is recorded with the reference to quote", async () => {
  await connect();
  answer = () => ({ reference: "sub-42" });

  const made = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "EUR",
      // What Peppol calls the buyer reference, and what it was missing above.
      buyerReference: "PO-2291",
      lines: [
        { description: "Site survey", quantity: 1, unitPriceCents: 45000 },
      ],
    }),
  });
  const { invoice } = (await made.json()) as {
    invoice: typeof schema.invoices.$inferSelect;
  };

  const res = await send(invoice.id);
  expect(res.status).toBe(200);

  const rows = await submissionsFor(invoice.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.status).toBe("sent");
  expect(rows[0]?.providerRef).toBe("sub-42");
  // Addressed by VAT number under Belgium's scheme, which is how most EU
  // businesses are reachable.
  expect(rows[0]?.recipient).toBe("9925:BE0123456789");
  expect(rows[0]?.sandbox).toBe(true);

  // And what went is the document we validate, not a re-description of it.
  const sent = asked.at(-1);
  expect(sent?.ubl).toContain("<cbc:ID>");
  expect(sent?.ubl).toContain("PO-2291");
});

/**
 * And the refusal is kept.
 *
 * "I pressed send and nothing happened" is the conversation this prevents.
 * A status column on the invoice would have been overwritten by the next
 * attempt; a row per attempt keeps the reason.
 */
test("a refusal is written down, in the access point's words", async () => {
  await connect();
  answer = null;

  const made = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "EUR",
      buyerReference: "PO-3",
      lines: [{ description: "Work", quantity: 1, unitPriceCents: 2500 }],
    }),
  });
  const { invoice } = (await made.json()) as {
    invoice: typeof schema.invoices.$inferSelect;
  };

  const res = await send(invoice.id);
  expect(res.status).toBe(502);

  const rows = await submissionsFor(invoice.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.status).toBe("failed");
  expect(rows[0]?.detail).toMatch(/having a day of it/);
});
