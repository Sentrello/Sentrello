import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, inArray, schema } from "@sentrello/db";
import {
  CORE_ACCOUNTS,
  ensureAccount,
  postJournalEntry,
} from "@sentrello/db/ledger";
import { recordSalePlace } from "@sentrello/db/sale-place";
import { dropOrganization, dropUsers } from "@sentrello/db/testing";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { Hono } from "hono";
import {
  DISTANCE_SELLING_THRESHOLD_CENTS,
  distanceSalesPosition,
} from "./distance-selling";
import invoicing from "./index";

const suffix = crypto.randomUUID().slice(0, 8);
const email = `distance-${suffix}@example.test`;
const app = new Hono<SentrelloEnv>();

let orgId: string;
let headers: Headers;

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
    body: { name: `Distance ${suffix}`, slug: `distance-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
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
  await db
    .delete(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));
  await db
    .delete(schema.documentTaxes)
    .where(eq(schema.documentTaxes.organizationId, orgId));
  await db
    .delete(schema.salePlaces)
    .where(eq(schema.salePlaces.organizationId, orgId));
  await db
    .delete(schema.invoices)
    .where(eq(schema.invoices.organizationId, orgId));
  await db
    .delete(schema.accounts)
    .where(eq(schema.accounts.organizationId, orgId));
  await db
    .delete(schema.contacts)
    .where(eq(schema.contacts.organizationId, orgId));
  await db
    .delete(schema.companies)
    .where(eq(schema.companies.organizationId, orgId));
  await db
    .delete(schema.documentCounters)
    .where(eq(schema.documentCounters.organizationId, orgId));
  await dropOrganization(orgId);
  await dropUsers(email);
});

/** A customer in the given country: a company, and a person who works there. */
async function buyerIn(
  country: string,
  taxIdentifier: string | null,
): Promise<string> {
  const [company] = await db
    .insert(schema.companies)
    .values({
      organizationId: orgId,
      name: `Buyer ${country} ${crypto.randomUUID().slice(0, 6)}`,
      country,
      taxIdentifier,
    })
    .returning();
  const [contact] = await db
    .insert(schema.contacts)
    .values({
      organizationId: orgId,
      companyId: company?.id,
      name: "Some Customer",
    })
    .returning();
  if (!contact) throw new Error("could not create buyer");
  return contact.id;
}

async function invoiceTo(contactId: string, netCents: number, status = "open") {
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "EUR",
      status,
      lines: [{ description: "Goods", quantity: 1, unitPriceCents: netCents }],
    }),
  });
  if (res.status !== 201) {
    throw new Error(`invoice not created: ${await res.text()}`);
  }
}

test("the threshold is €10,000, in cents", () => {
  expect(DISTANCE_SELLING_THRESHOLD_CENTS).toBe(1_000_000);
});

test("a seller outside the EU has no distance-selling threshold to watch", async () => {
  // The organisation starts with no country at all — most instances.
  const position = await distanceSalesPosition(orgId);
  expect(position.applies).toBe(false);
});

test("below the threshold, home-country VAT stands and the figures say so", async () => {
  // An Irish business, books in euros.
  await db
    .update(schema.organizations)
    .set({ countryCode: "IE", baseCurrency: "EUR" })
    .where(eq(schema.organizations.id, orgId));

  // €4,000 of goods to a German consumer — a company record with no VAT
  // number is an unregistered customer, which is what B2C means to VAT.
  const consumer = await buyerIn("DE", null);
  await invoiceTo(consumer, 400_000);

  const position = await distanceSalesPosition(orgId);
  expect(position.applies).toBe(true);
  expect(position.yearCents).toBe(400_000);
  expect(position.thresholdCents).toBe(1_000_000);
  expect(position.exceeded).toBe(false);
});

test("sales that are not intra-EU distance selling stay out of the sum", async () => {
  // B2B: a French customer with a VAT number accounts for its own VAT.
  const registered = await buyerIn("FR", "FR40303265045");
  await invoiceTo(registered, 5_000_000);
  // Domestic: an Irish customer is not cross-border.
  const domestic = await buyerIn("IE", null);
  await invoiceTo(domestic, 5_000_000);
  // Outside the union entirely.
  const american = await buyerIn("US", null);
  await invoiceTo(american, 5_000_000);
  // A draft is not a sale yet.
  const consumer = await buyerIn("NL", null);
  await invoiceTo(consumer, 5_000_000, "draft");

  const position = await distanceSalesPosition(orgId);
  expect(position.yearCents).toBe(400_000); // unchanged from the last test
  expect(position.exceeded).toBe(false);
});

test("over the threshold, the position says VAT moves to the customer's country", async () => {
  // €7,000 more to a Dutch consumer: €11,000 for the year, over the line.
  const consumer = await buyerIn("NL", null);
  await invoiceTo(consumer, 700_000);

  const position = await distanceSalesPosition(orgId);
  expect(position.yearCents).toBe(1_100_000);
  expect(position.exceeded).toBe(true);

  const res = await app.request(
    "http://localhost/api/invoicing/distance-sales",
    { headers },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { exceeded: boolean; advice: string };
  expect(body.exceeded).toBe(true);
  expect(body.advice).toContain("OSS");
});

test("last year over the line keeps this year over it too", async () => {
  // Article 59c looks at the preceding year as well: a business that passed
  // the threshold last December cannot start January at zero.
  const aYearOn = new Date();
  aYearOn.setUTCFullYear(aYearOn.getUTCFullYear() + 1);
  const position = await distanceSalesPosition(orgId, aYearOn);
  expect(position.yearCents).toBe(0);
  expect(position.priorYearCents).toBe(1_100_000);
  expect(position.exceeded).toBe(true);
});

test("books kept outside the euro report figures without pretending to compare", async () => {
  await db
    .update(schema.organizations)
    .set({ baseCurrency: "DKK" })
    .where(eq(schema.organizations.id, orgId));
  try {
    const position = await distanceSalesPosition(orgId);
    // Denmark states the threshold in kroner; euro cents against krone cents
    // would be a comparison of nothing with nothing.
    expect(position.thresholdCents).toBeNull();
    expect(position.exceeded).toBeNull();
    expect(position.yearCents).toBe(1_100_000);
  } finally {
    await db
      .update(schema.organizations)
      .set({ baseCurrency: "EUR" })
      .where(eq(schema.organizations.id, orgId));
  }
});

test("selling into a member state with no rate set is a warning, not silence", async () => {
  /*
   * A download sold to a Belgian consumer by a shop that has set no Belgian
   * rate. The place is established and the evidence is on the sale — the
   * charge of nothing is the *only* thing that went wrong — and the old
   * reading of this could not have seen the sale at all, let alone the gap.
   */
  const orderId = crypto.randomUUID();
  await recordSalePlace(orgId, `shop-order:${orderId}`, {
    country: "BE",
    basis: "declared",
    documentId: orderId,
    evidence: [
      { kind: "billing-address", country: "BE" },
      { kind: "ip-address", country: "BE" },
    ],
  });
  const [cash, income] = await Promise.all([
    ensureAccount(orgId, CORE_ACCOUNTS.cash),
    ensureAccount(orgId, CORE_ACCOUNTS.salesIncome),
  ]);
  await postJournalEntry(
    orgId,
    "Download to Belgium",
    `shop-order:${orderId}`,
    [
      { accountId: cash, debitCents: 2_000 },
      { accountId: income, creditCents: 2_000 },
    ],
  );

  const position = await distanceSalesPosition(orgId);
  expect(position.unratedStates).toEqual([
    { memberState: "BE", sales: 1, netCents: 2_000 },
  ]);

  const res = await app.request(
    "http://localhost/api/invoicing/distance-sales",
    { headers },
  );
  const body = (await res.json()) as { warning: string | null };
  expect(body.warning).toContain("BE");
  expect(body.warning).toContain("no threshold under it for digital supplies");
});

test("a zero somebody chose is not a warning", async () => {
  const orderId = crypto.randomUUID();
  await db.insert(schema.documentTaxes).values({
    organizationId: orgId,
    documentType: "shop-order",
    documentId: orderId,
    name: "Zero-rated",
    rateBp: 0,
    ratePpm: 0,
    categoryCode: "Z",
    taxableCents: 5_000,
    taxCents: 0,
  });
  await recordSalePlace(orgId, `shop-order:${orderId}`, {
    country: "PT",
    basis: "declared",
    documentId: orderId,
  });
  const [cash, income] = await Promise.all([
    ensureAccount(orgId, CORE_ACCOUNTS.cash),
    ensureAccount(orgId, CORE_ACCOUNTS.salesIncome),
  ]);
  await postJournalEntry(
    orgId,
    "Zero-rated supply to Portugal",
    `shop-order:${orderId}`,
    [
      { accountId: cash, debitCents: 5_000 },
      { accountId: income, creditCents: 5_000 },
    ],
  );

  const position = await distanceSalesPosition(orgId);
  expect(
    position.unratedStates?.some((state) => state.memberState === "PT"),
  ).toBe(false);
});
