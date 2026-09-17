import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, inArray, schema } from "@sentrello/db";
import { dropOrganization, dropUsers } from "@sentrello/db/testing";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { Hono } from "hono";
import invoicing from "./index";
import { ossReturn, ossReturnCsv, quarterBounds } from "./oss-return";

/**
 * The One Stop Shop return, in euros, to the cent.
 *
 * Real figures rather than round ones where it matters: the conversion case
 * uses a rate that does not divide evenly, because a euro total that only
 * works at 1:1 has not been tested at all.
 *
 * The seller is Irish and the quarter is 2026 Q2, which is in the past — an
 * invoice cannot be issued in the future, and the credit notes have to be
 * raised today, which is what puts them in a later quarter than the sales
 * they correct. That is the correction case, and it is the real shape of it.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const email = `oss-${suffix}@example.test`;
const kronaEmail = `oss-sek-${suffix}@example.test`;
const app = new Hono<SentrelloEnv>();

let orgId: string;
let headers: Headers;
let kronaOrgId: string;
let kronaHeaders: Headers;

/** 2026 Q2: April, May and June — the quarter the sales below belong to. */
const Q2 = { year: 2026, quarter: 2 };
const MAY = "2026-05-15";

const noop = {
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
};

async function ownerOf(
  address: string,
  name: string,
  country: string,
  currency: string,
) {
  const signUp = await signUpAsOwner({
    email: address,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  const made = new Headers({ cookie, "content-type": "application/json" });
  const org = await auth.api.createOrganization({
    body: { name, slug: name.toLowerCase().replaceAll(" ", "-") },
    headers: made,
  });
  if (!org) throw new Error("could not create organization");
  await auth.api.setActiveOrganization({
    body: { organizationId: org.id },
    headers: made,
  });
  await db
    .update(schema.organizations)
    .set({ countryCode: country, baseCurrency: currency })
    .where(eq(schema.organizations.id, org.id));
  return { orgId: org.id, headers: made };
}

beforeAll(async () => {
  invoicing.register({ app, entitled: () => true, ...noop });
  ({ orgId, headers } = await ownerOf(email, `OSS ${suffix}`, "IE", "EUR"));
  ({ orgId: kronaOrgId, headers: kronaHeaders } = await ownerOf(
    kronaEmail,
    `OSS SEK ${suffix}`,
    "SE",
    "SEK",
  ));
});

async function tidy(id: string) {
  const invoices = await db
    .select({ id: schema.invoices.id })
    .from(schema.invoices)
    .where(eq(schema.invoices.organizationId, id));
  const invoiceIds = invoices.map((i) => i.id);
  if (invoiceIds.length > 0) {
    await db
      .delete(schema.invoiceLines)
      .where(inArray(schema.invoiceLines.invoiceId, invoiceIds));
  }
  const entries = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, id));
  const entryIds = entries.map((e) => e.id);
  if (entryIds.length > 0) {
    await db
      .delete(schema.journalLines)
      .where(inArray(schema.journalLines.entryId, entryIds));
  }
  for (const [table, column] of [
    [schema.journalEntries, schema.journalEntries.organizationId],
    [schema.documentTaxes, schema.documentTaxes.organizationId],
    [schema.taxDefinitions, schema.taxDefinitions.organizationId],
    [schema.invoices, schema.invoices.organizationId],
    [schema.billableItems, schema.billableItems.organizationId],
    [schema.exchangeRates, schema.exchangeRates.organizationId],
    [schema.accounts, schema.accounts.organizationId],
    [schema.contacts, schema.contacts.organizationId],
    [schema.companies, schema.companies.organizationId],
    [schema.documentCounters, schema.documentCounters.organizationId],
  ] as const) {
    await db.delete(table).where(eq(column, id));
  }
  await dropOrganization(id);
}

afterAll(async () => {
  await tidy(orgId);
  await tidy(kronaOrgId);
  await dropUsers(email);
  await dropUsers(kronaEmail);
});

/** A customer in a country: the company that has the address, and a person. */
async function buyerIn(
  org: string,
  country: string,
  taxIdentifier: string | null = null,
  taxIdentifierValid: boolean | null = null,
): Promise<string> {
  const [company] = await db
    .insert(schema.companies)
    .values({
      organizationId: org,
      name: `Buyer ${country} ${crypto.randomUUID().slice(0, 6)}`,
      country,
      taxIdentifier,
      taxIdentifierValid,
    })
    .returning();
  const [contact] = await db
    .insert(schema.contacts)
    .values({
      organizationId: org,
      companyId: company?.id,
      name: "Some Customer",
    })
    .returning();
  if (!contact) throw new Error("could not create buyer");
  return contact.id;
}

async function invoiceTo(
  who: { headers: Headers; currency: string },
  contactId: string,
  netCents: number,
  ratePpm: number,
  issueDate?: string,
  billableItemId?: string,
) {
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers: who.headers,
    body: JSON.stringify({
      contactId,
      currency: who.currency,
      ...(issueDate ? { issueDate } : {}),
      lines: [
        {
          description: "Supply",
          quantity: 1,
          unitPriceCents: netCents,
          taxRatePpm: ratePpm,
          ...(billableItemId ? { billableItemId } : {}),
        },
      ],
    }),
  });
  if (res.status !== 201) {
    throw new Error(`invoice not created: ${await res.text()}`);
  }
  return (
    (await res.json()) as { invoice: typeof schema.invoices.$inferSelect }
  ).invoice;
}

async function creditOf(who: Headers, invoiceId: string, amountCents: number) {
  const res = await app.request(
    `http://localhost/api/invoices/${invoiceId}/credit`,
    {
      method: "POST",
      headers: who,
      body: JSON.stringify({ amountCents }),
    },
  );
  if (res.status !== 201) {
    throw new Error(`credit note not created: ${await res.text()}`);
  }
  return (
    (await res.json()) as { creditNote: typeof schema.invoices.$inferSelect }
  ).creditNote;
}

const euro = { currency: "EUR" };
let germanInvoiceId: string;

test("a quarter's bounds and its deadline are the end of the next month", () => {
  expect(quarterBounds(2026, 2).from.toISOString()).toBe(
    "2026-04-01T00:00:00.000Z",
  );
  expect(quarterBounds(2026, 2).to.toISOString()).toBe(
    "2026-06-30T23:59:59.999Z",
  );
  // Q2 is due 31 July; Q4 rolls into the following January.
  expect(quarterBounds(2026, 2).dueDate.toISOString().slice(0, 10)).toBe(
    "2026-07-31",
  );
  expect(quarterBounds(2026, 4).dueDate.toISOString().slice(0, 10)).toBe(
    "2027-01-31",
  );
});

test("a seller outside the EU has no Union scheme return", async () => {
  await db
    .update(schema.organizations)
    .set({ countryCode: "US" })
    .where(eq(schema.organizations.id, orgId));
  const report = await ossReturn(orgId, Q2.year, Q2.quarter);
  expect(report.applies).toBe(false);
  await db
    .update(schema.organizations)
    .set({ countryCode: "IE" })
    .where(eq(schema.organizations.id, orgId));
});

test("a quarter with no cross-border sales is a nil return, not an error", async () => {
  const report = await ossReturn(orgId, 2026, 1);
  expect(report.applies).toBe(true);
  expect(report.lines).toEqual([]);
  expect(report.corrections).toEqual([]);
  expect(report.totalVatCents).toBe(0);
  expect(report.dueDate.toISOString().slice(0, 10)).toBe("2026-04-30");
  expect(report.caveats.join(" ")).toContain("nil return");
});

test("three member states at three rates, totalled to the cent", async () => {
  // Germany at 19%, France at 20%, the Netherlands at 21% — the rate the
  // customer's country charges, which is the whole point of the scheme.
  const german = await buyerIn(orgId, "DE");
  const invoice = await invoiceTo(
    { headers, ...euro },
    german,
    100_000,
    190_000,
    MAY,
  );
  germanInvoiceId = invoice.id;
  expect(invoice.taxCents).toBe(19_000);

  await invoiceTo(
    { headers, ...euro },
    await buyerIn(orgId, "FR"),
    50_000,
    200_000,
    MAY,
  );
  await invoiceTo(
    { headers, ...euro },
    await buyerIn(orgId, "NL"),
    25_000,
    210_000,
    MAY,
  );

  const report = await ossReturn(orgId, Q2.year, Q2.quarter);
  expect(report.currency).toBe("EUR");
  expect(report.conversion).toBeNull();
  expect(report.lines).toEqual([
    {
      memberState: "DE",
      ratePpm: 190_000,
      supplyType: "unclassified",
      taxableCents: 100_000,
      vatCents: 19_000,
    },
    {
      memberState: "FR",
      ratePpm: 200_000,
      supplyType: "unclassified",
      taxableCents: 50_000,
      vatCents: 10_000,
    },
    {
      memberState: "NL",
      ratePpm: 210_000,
      supplyType: "unclassified",
      taxableCents: 25_000,
      vatCents: 5_250,
    },
  ]);
  expect(report.totalTaxableCents).toBe(175_000);
  expect(report.totalVatCents).toBe(34_250);
  // €1,000 + €500 + €250 at 19, 20 and 21 per cent.
  expect(19_000 + 10_000 + 5_250).toBe(34_250);
});

test("a domestic sale and a B2B sale with a valid VAT number stay off the return", async () => {
  // Irish customer of an Irish business: the domestic return's business, and
  // putting it here would overstate one and understate the other.
  await invoiceTo(
    { headers, ...euro },
    await buyerIn(orgId, "IE"),
    80_000,
    230_000,
    MAY,
  );
  // Belgian company whose VAT number the register confirmed: the customer
  // accounts for the VAT, and the supply is not distance selling at all.
  await invoiceTo(
    { headers, ...euro },
    await buyerIn(orgId, "BE", "BE0403170701", true),
    40_000,
    210_000,
    MAY,
  );

  const report = await ossReturn(orgId, Q2.year, Q2.quarter);
  expect(report.lines.map((l) => l.memberState)).toEqual(["DE", "FR", "NL"]);
  expect(report.totalTaxableCents).toBe(175_000);
  expect(report.totalVatCents).toBe(34_250);
});

test("a credit note against an earlier quarter is a correction, not a reduction", async () => {
  // €595 of the German invoice given back today, which is a later quarter
  // than the sale. The original return cannot be amended, so this belongs on
  // the current return's correction panel, naming 2026 Q2.
  await creditOf(headers, germanInvoiceId, 59_500);

  // Last quarter is untouched: what it reported is what it reported.
  const q2 = await ossReturn(orgId, Q2.year, Q2.quarter);
  expect(q2.lines.find((l) => l.memberState === "DE")?.taxableCents).toBe(
    100_000,
  );
  expect(q2.corrections).toEqual([]);

  const now = new Date();
  const current = await ossReturn(
    orgId,
    now.getUTCFullYear(),
    Math.floor(now.getUTCMonth() / 3) + 1,
  );
  expect(current.corrections).toEqual([
    {
      memberState: "DE",
      period: "2026-Q2",
      taxableCents: -50_000,
      vatCents: -9_500,
      withinThreeYears: true,
    },
  ]);
  // And it is not also sitting in this quarter's supplies.
  expect(current.lines.some((l) => l.memberState === "DE")).toBe(false);
  expect(current.totalVatCents).toBe(-9_500);
});

test("a credit note inside its own quarter simply nets off", async () => {
  // Raised and credited in the same quarter: both movements are inside the
  // period being reported, so the return should show the net supply.
  const austrian = await buyerIn(orgId, "AT");
  const item = await db
    .insert(schema.billableItems)
    .values({
      organizationId: orgId,
      name: "A thing in a box",
      kind: "product",
      unitPriceCents: 30_000,
    })
    .returning();
  const invoice = await invoiceTo(
    { headers, ...euro },
    austrian,
    30_000,
    200_000,
    undefined,
    item[0]?.id,
  );
  await creditOf(headers, invoice.id, 12_000);

  const now = new Date();
  const report = await ossReturn(
    orgId,
    now.getUTCFullYear(),
    Math.floor(now.getUTCMonth() / 3) + 1,
  );
  const line = report.lines.find((l) => l.memberState === "AT");
  expect(line?.taxableCents).toBe(20_000);
  expect(line?.vatCents).toBe(4_000);
  // It came from a catalogue product, so the return's goods part is where it
  // goes — and the credit note takes that classification from the sale it
  // reverses rather than landing in a row of its own beside it.
  expect(report.lines.map((l) => l.supplyType)).toContain("goods");
  expect(report.lines.filter((l) => l.memberState === "AT")).toHaveLength(1);
});

test("books outside the euro refuse to guess, then convert at the prescribed rate", async () => {
  const consumer = await buyerIn(kronaOrgId, "DE");
  await invoiceTo(
    { headers: kronaHeaders, currency: "SEK" },
    consumer,
    1_000_000,
    190_000,
    MAY,
  );

  // No euro rate recorded: no figures. A return converted at whatever rate
  // was lying around is plausible, wrong, and signed.
  const guessing = await ossReturn(kronaOrgId, Q2.year, Q2.quarter);
  expect(guessing.applies).toBe(true);
  expect(guessing.lines).toEqual([]);
  expect(guessing.problem).toContain("European Central Bank");
  expect(guessing.problem).toContain("2026-06-30");

  // The ECB's rate for the last day of the quarter — the one the rules name.
  await db.insert(schema.exchangeRates).values({
    organizationId: kronaOrgId,
    code: "EUR",
    rateMicro: 11_250_000, // 1 EUR = 11.25 SEK
    asOf: new Date("2026-06-30T00:00:00.000Z"),
  });

  const report = await ossReturn(kronaOrgId, Q2.year, Q2.quarter);
  expect(report.conversion).toMatchObject({ from: "SEK", prescribed: true });
  // SEK 10,000.00 at 11.25 to the euro is €888.89; SEK 1,900.00 is €168.89.
  expect(report.lines).toEqual([
    {
      memberState: "DE",
      ratePpm: 190_000,
      supplyType: "unclassified",
      taxableCents: 88_889,
      vatCents: 16_889,
    },
  ]);
  expect(report.totalTaxableCents).toBe(88_889);
  expect(report.totalVatCents).toBe(16_889);
});

test("the route answers with the figures, a file, and no claim to have filed", async () => {
  const res = await app.request(
    "http://localhost/api/invoicing/oss-return?year=2026&quarter=2",
    { headers },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    totalVatCents: number;
    filing: string;
  };
  expect(body.totalVatCents).toBe(34_250);
  expect(body.filing).toContain("does not file it");

  const file = await app.request(
    "http://localhost/api/invoicing/oss-return?year=2026&quarter=2&format=csv",
    { headers },
  );
  expect(file.headers.get("content-type")).toContain("text/csv");
  expect(file.headers.get("content-disposition")).toContain(
    "oss-return-2026-Q2.csv",
  );
  const csv = await file.text();
  expect(csv).toContain("DE,19.00%,unclassified,1000.00,190.00");
  expect(csv).toContain("does not file it");
  expect(csv).toContain("2026-07-31");

  // A quarter nobody could file.
  const wrong = await app.request(
    "http://localhost/api/invoicing/oss-return?year=2026&quarter=5",
    { headers },
  );
  expect(wrong.status).toBe(400);

  // And no session is no return.
  const anonymous = await app.request(
    "http://localhost/api/invoicing/oss-return?year=2026&quarter=2",
  );
  expect(anonymous.status).toBe(401);
});

test("the file says which rate it used, and whether it was the prescribed one", () => {
  const report = {
    applies: true,
    year: 2026,
    quarter: 2,
    ...quarterBounds(2026, 2),
    currency: "EUR" as const,
    conversion: {
      from: "SEK",
      rateMicro: 11_250_000,
      asOf: new Date("2026-06-30T00:00:00.000Z"),
      prescribed: false,
    },
    lines: [],
    corrections: [],
    totalTaxableCents: 0,
    totalVatCents: 0,
    problem: null,
    filing: "This computes your return; it does not file it.",
    caveats: [],
  };
  const csv = ossReturnCsv(report);
  expect(csv).toContain("1 EUR = 11.250000 SEK");
  expect(csv).toContain("NOT the prescribed quarter-end rate");
});
