import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import { caReturnsFor, caTaxAccountCode } from "@sentrello/db/ca-tax";
import { postJournalEntry } from "@sentrello/db/ledger";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import invoicing from "./index";

/**
 * The Canadian returns, end to end: a rate is named with its jurisdiction,
 * a sale is invoiced, and the figures land on the return the right
 * authority reads — the CRA's, Revenu Québec's, or a province's — with a
 * credit note taking back exactly what its sale put in.
 *
 * Everything here goes through the real routes and the real ledger,
 * because the property being proven is the UK return's property: what the
 * screen shows is the books' own answer, recomputed when asked.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const email = `ca-tax-${suffix}@example.test`;
const otherEmail = `ca-tax-other-${suffix}@example.test`;
const app = new Hono<SentrelloEnv>();

let orgId: string;
let headers: Headers;
let contactId: string;
let otherOrgId: string;
let otherHeaders: Headers;

let gstId: string;
let pstId: string;
let qstId: string;

async function owner(ownerEmail: string, name: string, slug: string) {
  const signUp = await signUpAsOwner({
    email: ownerEmail,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  const sessionHeaders = new Headers({
    cookie,
    "content-type": "application/json",
  });
  const org = await auth.api.createOrganization({
    body: { name, slug },
    headers: sessionHeaders,
  });
  if (!org) throw new Error("could not create organization");
  await auth.api.setActiveOrganization({
    body: { organizationId: org.id },
    headers: sessionHeaders,
  });
  return { orgId: org.id, headers: sessionHeaders };
}

beforeAll(async () => {
  invoicing.register({
    app,
    entitled: () => true,
    registerNav: () => {},
    registerPermission: () => {},
    registerSummary: () => {},
    registerSearch: () => {},
    registerPersonalData: () => {},
    registerOnboarding: () => {},
    registerCrawlable: () => {},
    provide: () => {},
    registerJob: () => {},
  });

  const main = await owner(email, `CA Tax ${suffix}`, `ca-tax-${suffix}`);
  orgId = main.orgId;
  headers = main.headers;

  const other = await owner(
    otherEmail,
    `CA Tax Other ${suffix}`,
    `ca-tax-other-${suffix}`,
  );
  otherOrgId = other.orgId;
  otherHeaders = other.headers;

  const [contact] = await db
    .insert(schema.contacts)
    .values({
      organizationId: orgId,
      name: "Laurier Traders",
      email: "buyer@laurier.test",
    })
    .returning();
  if (!contact) throw new Error("could not create test contact");
  contactId = contact.id;
});

afterAll(async () => {
  for (const org of [orgId, otherOrgId]) {
    const entries = await db
      .select({ id: schema.journalEntries.id })
      .from(schema.journalEntries)
      .where(eq(schema.journalEntries.organizationId, org));
    const entryIds = entries.map((e) => e.id);
    if (entryIds.length > 0) {
      await db
        .delete(schema.journalLines)
        .where(inArray(schema.journalLines.entryId, entryIds));
    }
    const invoices = await db
      .select({ id: schema.invoices.id })
      .from(schema.invoices)
      .where(eq(schema.invoices.organizationId, org));
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
      [schema.documentCounters, schema.documentCounters.organizationId],
    ] as const) {
      await db.delete(table).where(eq(column, org));
    }
    await db.delete(schema.member).where(eq(schema.member.organizationId, org));
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, org));
  }
  for (const address of [email, otherEmail]) {
    const [u] = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, address));
    if (u) {
      await db.delete(schema.session).where(eq(schema.session.userId, u.id));
      await db.delete(schema.account).where(eq(schema.account.userId, u.id));
      await db.delete(schema.user).where(eq(schema.user.id, u.id));
    }
  }
});

async function makeTax(body: Record<string, unknown>, as = headers) {
  const res = await app.request("http://localhost/api/invoicing/taxes", {
    method: "POST",
    headers: as,
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  return (
    (await res.json()) as {
      tax: typeof schema.taxDefinitions.$inferSelect;
    }
  ).tax;
}

async function invoiceOf(lines: unknown[], as = headers, contact = contactId) {
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers: as,
    // The organization's base currency, so every figure is 1:1 with the
    // ledger — a Canadian business would set its base to CAD and get the
    // same property.
    body: JSON.stringify({ contactId: contact, currency: "USD", lines }),
  });
  expect(res.status).toBe(201);
  return (
    (await res.json()) as { invoice: typeof schema.invoices.$inferSelect }
  ).invoice;
}

/** The journal lines behind one source, with their account codes. */
async function linesFor(source: string, org = orgId) {
  const [entry] = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(
      and(
        eq(schema.journalEntries.organizationId, org),
        eq(schema.journalEntries.source, source),
      ),
    );
  if (!entry) throw new Error(`no journal entry for ${source}`);
  return db
    .select({
      code: schema.accounts.code,
      debitCents: schema.journalLines.debitCents,
      creditCents: schema.journalLines.creditCents,
    })
    .from(schema.journalLines)
    .innerJoin(
      schema.accounts,
      eq(schema.journalLines.accountId, schema.accounts.id),
    )
    .where(eq(schema.journalLines.entryId, entry.id));
}

async function accountId(code: string, name: string, type: string) {
  const [existing] = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.organizationId, orgId),
        eq(schema.accounts.code, code),
      ),
    )
    .limit(1);
  if (existing) return existing.id;
  const [made] = await db
    .insert(schema.accounts)
    .values({ organizationId: orgId, code, name, type })
    .returning();
  if (!made) throw new Error(`could not create account ${code}`);
  return made.id;
}

test("a Canadian jurisdiction makes a rate Canadian, and PST provinces make it cost", async () => {
  const gst = await makeTax({
    name: "GST 5%",
    ratePpm: 50_000,
    jurisdiction: "ca",
  });
  expect(gst.jurisdiction).toBe("CA");
  expect(gst.regime).toBe("ca");
  // GST comes back on purchases as an input tax credit.
  expect(gst.recoverable).toBe(true);
  gstId = gst.id;

  const pst = await makeTax({
    name: "BC PST 7%",
    ratePpm: 70_000,
    jurisdiction: "ca-bc",
  });
  expect(pst.jurisdiction).toBe("CA-BC");
  expect(pst.regime).toBe("ca");
  // PST never comes back; it is part of what a purchase cost.
  expect(pst.recoverable).toBe(false);
  pstId = pst.id;

  const qst = await makeTax({
    name: "QST 9.975%",
    ratePpm: 99_750,
    jurisdiction: "CA-QC",
  });
  expect(qst.regime).toBe("ca");
  // Quebec's QST is recoverable — the ITR mirrors the ITC.
  expect(qst.recoverable).toBe(true);
  qstId = qst.id;
});

test("a GST-only sale posts to GST's own account and lands on the federal return alone", async () => {
  // $1,000 to Alberta: GST 5% and nothing provincial.
  const invoice = await invoiceOf([
    {
      description: "Consulting",
      quantity: 1,
      unitPrice: 100_000,
      taxDefinitionIds: [gstId],
    },
  ]);
  expect(invoice.taxCents).toBe(5_000);

  // A lone Canadian tax must not park on the shared account: the CRA's
  // figure is read off GST's own account, and "2200" is not on the return.
  const lines = await linesFor(`invoice:${invoice.id}`);
  expect(
    lines.find((l) => l.code === caTaxAccountCode(gstId))?.creditCents,
  ).toBe(5_000);
  expect(lines.find((l) => l.code === "2200")).toBeUndefined();

  const out = await caReturnsFor(orgId);
  expect(out.currency).toBe("USD");
  expect(out.gstHst?.line101SalesCents).toBe(100_000);
  expect(out.gstHst?.line105CollectedCents).toBe(5_000);
  expect(out.gstHst?.line109NetTaxCents).toBe(5_000);
  expect(out.qst?.line205CollectedCents).toBe(0);
  expect(out.pst.find((p) => p.jurisdiction === "CA-BC")?.collectedCents).toBe(
    0,
  );
});

test("a GST+PST sale files to two governments: the CRA's figure and BC's never share a line", async () => {
  // $2,000 to BC: GST $100, PST $140 — two taxes on one line, two returns.
  const invoice = await invoiceOf([
    {
      description: "Cabinets",
      quantity: 1,
      unitPrice: 200_000,
      taxDefinitionIds: [gstId, pstId],
    },
  ]);
  expect(invoice.taxCents).toBe(10_000 + 14_000);

  const out = await caReturnsFor(orgId);
  expect(out.gstHst?.line105CollectedCents).toBe(5_000 + 10_000);
  const bc = out.pst.find((p) => p.jurisdiction === "CA-BC");
  expect(bc?.collectedCents).toBe(14_000);
  expect(bc?.dueCents).toBe(14_000);
  // PST is not on the federal return, and GST is not on BC's.
  expect(out.gstHst?.line109NetTaxCents).toBe(15_000);
  expect(bc?.taxes.map((t) => t.definitionId)).toEqual([pstId]);
});

test("a Quebec sale puts GST on the federal side and QST beside it, to the exact millionth", async () => {
  // $1,000 to Quebec: GST $50, QST at exactly 9.975% = $99.75 → $100 by
  // per-line rounding. The rate only survives because it is millionths.
  const invoice = await invoiceOf([
    {
      description: "Design",
      quantity: 1,
      unitPrice: 100_000,
      taxDefinitionIds: [gstId, qstId],
    },
  ]);
  expect(invoice.taxCents).toBe(5_000 + 9_975);

  const out = await caReturnsFor(orgId);
  expect(out.gstHst?.line105CollectedCents).toBe(15_000 + 5_000);
  expect(out.qst?.line205CollectedCents).toBe(9_975);
  expect(out.qst?.line209NetTaxCents).toBe(9_975);
  // QST is not GST: the federal net must not contain Quebec's tax.
  expect(out.gstHst?.line109NetTaxCents).toBe(20_000);
});

test("input tax credits reduce GST owed; PST paid on a purchase reduces nothing", async () => {
  const expense = await accountId("5000", "Cost of Goods", "expense");
  const bank = await accountId("1000", "Bank", "asset");
  const [gstAccount] = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.organizationId, orgId),
        eq(schema.accounts.code, caTaxAccountCode(gstId)),
      ),
    )
    .limit(1);
  if (!gstAccount) throw new Error("no GST liability account");

  // A supplier's bill: $400 of materials plus $20 GST, paid from the bank.
  await postJournalEntry(orgId, "Materials", `bill:ca-${suffix}`, [
    { accountId: expense, debitCents: 40_000 },
    { accountId: gstAccount.id, debitCents: 2_000 },
    { accountId: bank, creditCents: 42_000 },
  ]);

  const before = await caReturnsFor(orgId);
  expect(before.gstHst?.line108ItcsCents).toBe(2_000);
  expect(before.gstHst?.line109NetTaxCents).toBe(20_000 - 2_000);

  // The same purchase pattern with PST is a mis-posting — PST belongs in
  // the cost — and the province's return must refuse to net it.
  const [pstAccount] = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.organizationId, orgId),
        eq(schema.accounts.code, caTaxAccountCode(pstId)),
      ),
    )
    .limit(1);
  if (!pstAccount) throw new Error("no PST liability account");
  await postJournalEntry(orgId, "Mis-posted PST", `bill:ca-pst-${suffix}`, [
    { accountId: expense, debitCents: 10_000 },
    { accountId: pstAccount.id, debitCents: 700 },
    { accountId: bank, creditCents: 10_700 },
  ]);

  const after = await caReturnsFor(orgId);
  const bc = after.pst.find((p) => p.jurisdiction === "CA-BC");
  expect(bc?.collectedCents).toBe(14_000);
  expect(bc?.dueCents).toBe(14_000);
  expect(bc?.taxes[0]?.paidOnPurchasesCents).toBe(0);
  // And it is not an input tax credit anywhere else either.
  expect(after.gstHst?.line108ItcsCents).toBe(2_000);
});

test("a credit note takes each tax back off the return it went onto", async () => {
  // Credit $560 of the BC sale: GST $25 and PST $35 come back, each from
  // its own return, by exactly the banded share the sale put in.
  const [sale] = await db
    .select({ id: schema.invoices.id })
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.organizationId, orgId),
        eq(schema.invoices.totalCents, 224_000),
      ),
    )
    .limit(1);
  if (!sale) throw new Error("no BC sale to credit");

  const res = await app.request(
    `http://localhost/api/invoices/${sale.id}/credit`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ amountCents: 56_000 }),
    },
  );
  expect(res.status).toBe(201);
  const { creditNote } = (await res.json()) as {
    creditNote: typeof schema.invoices.$inferSelect;
  };
  expect(creditNote.taxCents).toBe(2_500 + 3_500);

  const out = await caReturnsFor(orgId);
  expect(out.gstHst?.line105CollectedCents).toBe(20_000 - 2_500);
  expect(out.gstHst?.line108ItcsCents).toBe(2_000);
  const bc = out.pst.find((p) => p.jurisdiction === "CA-BC");
  expect(bc?.collectedCents).toBe(14_000 - 3_500);
  expect(bc?.dueCents).toBe(10_500);
  expect(out.qst?.line205CollectedCents).toBe(9_975);
});

test("the ledger figures reconcile with the documents' frozen bands, tax by tax", async () => {
  const out = await caReturnsFor(orgId);
  for (const line of [
    ...(out.gstHst?.taxes ?? []),
    ...(out.qst?.taxes ?? []),
    ...out.pst.flatMap((p) => p.taxes),
  ]) {
    // Collected must equal what the documents said, to the cent — the
    // manual ITC postings above touched the purchases side, never this.
    expect(line.collectedCents).toBe(line.documentTaxCents);
  }
  // And the taxable bases are the sales the tax was charged on.
  const gstLine = out.gstHst?.taxes.find((t) => t.definitionId === gstId);
  expect(gstLine?.documentTaxableCents).toBe(
    100_000 + 200_000 + 100_000 - 50_000,
  );
});

test("another organization's Canadian figures are its own, and never leak", async () => {
  const otherGst = await makeTax(
    { name: "GST 5%", ratePpm: 50_000, jurisdiction: "CA" },
    otherHeaders,
  );
  const [otherContact] = await db
    .insert(schema.contacts)
    .values({
      organizationId: otherOrgId,
      name: "Other Buyer",
      email: "other@buyer.test",
    })
    .returning();
  if (!otherContact) throw new Error("could not create other contact");
  await invoiceOf(
    [
      {
        description: "Elsewhere",
        quantity: 1,
        unitPrice: 77_000,
        taxDefinitionIds: [otherGst.id],
      },
    ],
    otherHeaders,
    otherContact.id,
  );

  const theirs = await caReturnsFor(otherOrgId);
  expect(theirs.gstHst?.line105CollectedCents).toBe(3_850);
  expect(theirs.pst).toHaveLength(0);
  expect(theirs.qst).toBeNull();

  // Nothing of theirs moved ours.
  const ours = await caReturnsFor(orgId);
  expect(ours.gstHst?.line105CollectedCents).toBe(17_500);
  expect(ours.gstHst?.line101SalesCents).toBe(
    100_000 + 200_000 + 100_000 - 50_000,
  );
});

test("a period bounds the return: last year's sale is not on this quarter's form", async () => {
  const out = await caReturnsFor(orgId, {
    from: new Date("2020-01-01"),
    to: new Date("2020-03-31"),
  });
  expect(out.gstHst?.line105CollectedCents).toBe(0);
  expect(out.gstHst?.line101SalesCents).toBe(0);
});
