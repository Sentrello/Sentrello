import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import { ledgerRows } from "@sentrello/db/ledger";
import { flatRateVatReturn, vatReturn } from "@sentrello/db/tax";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import invoicing from "./index";
import { usFilingReport } from "./us-filing";

/**
 * A credit note that credits a taxed sale must give the tax back too.
 *
 * The sale posted Dr Receivable / Cr Income / Cr Tax Payable, band by band.
 * The credit is that entry with its sides swapped, in proportion to what is
 * being credited — because the filing figures for every regime this product
 * sells into are read off those tax accounts, and a credit that debits income
 * for the gross amount leaves the tax in the return for ever. A business that
 * refunded a taxed sale would over-report and over-pay, to HMRC, to a US
 * state, to the CRA alike.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const email = `credit-notes-${suffix}@example.test`;
const app = new Hono<SentrelloEnv>();

let orgId: string;
let headers: Headers;
let contactId: string;

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

  const signUp = await signUpAsOwner({
    email,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Credit Notes ${suffix}`, slug: `credit-notes-${suffix}` },
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
    .values({ organizationId: orgId, name: "Byrne & Co", email: "x@b.test" })
    .returning();
  if (!contact) throw new Error("could not create test contact");
  contactId = contact.id;
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

async function invoiceOf(lines: unknown[]) {
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({ contactId, currency: "USD", lines }),
  });
  expect(res.status).toBe(201);
  return (
    (await res.json()) as { invoice: typeof schema.invoices.$inferSelect }
  ).invoice;
}

async function creditOf(invoiceId: string, amountCents?: number) {
  const res = await app.request(
    `http://localhost/api/invoices/${invoiceId}/credit`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(amountCents === undefined ? {} : { amountCents }),
    },
  );
  expect(res.status).toBe(201);
  return (
    (await res.json()) as {
      creditNote: typeof schema.invoices.$inferSelect;
    }
  ).creditNote;
}

/** The journal lines behind one source, with their account codes. */
async function linesFor(source: string) {
  const [entry] = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(
      and(
        eq(schema.journalEntries.organizationId, orgId),
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

const debitOn = (lines: { code: string; debitCents: number }[], code: string) =>
  lines
    .filter((l) => l.code === code)
    .reduce((sum, l) => sum + l.debitCents, 0);
const balanced = (lines: { debitCents: number; creditCents: number }[]) => {
  const debits = lines.reduce((s, l) => s + l.debitCents, 0);
  const credits = lines.reduce((s, l) => s + l.creditCents, 0);
  expect(debits).toBe(credits);
  return debits;
};

async function makeTax(body: Record<string, unknown>) {
  const res = await app.request("http://localhost/api/invoicing/taxes", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { tax: { id: string } }).tax.id;
}

test("a full credit of a taxed invoice reverses net and tax, to the cent", async () => {
  // £100 + 20% VAT. A bare rate posts its tax to 2200, as UK VAT always has.
  const invoice = await invoiceOf([
    {
      description: "Design",
      quantity: 1,
      unitPrice: 10_000,
      taxRatePpm: 200_000,
    },
  ]);
  expect(invoice.taxCents).toBe(2000);

  const note = await creditOf(invoice.id);

  // The document itself carries the split, not just the ledger.
  expect(note.subtotalCents).toBe(10_000);
  expect(note.taxCents).toBe(2000);
  expect(note.totalCents).toBe(12_000);

  // The sale's entry with its sides swapped: Dr Income, Dr VAT, Cr AR.
  const lines = await linesFor(`credit-note:${note.id}`);
  expect(balanced(lines)).toBe(12_000);
  expect(debitOn(lines, "4000")).toBe(10_000);
  expect(debitOn(lines, "2200")).toBe(2000);
  expect(lines.find((l) => l.code === "1100")?.creditCents).toBe(12_000);

  // And the note freezes its own tax band, the way the sale did — the US
  // filing and the tax summary both read documents band by band.
  const bands = await db
    .select()
    .from(schema.documentTaxes)
    .where(
      and(
        eq(schema.documentTaxes.organizationId, orgId),
        eq(schema.documentTaxes.documentType, "invoice"),
        eq(schema.documentTaxes.documentId, note.id),
      ),
    );
  expect(bands).toHaveLength(1);
  expect(bands[0]?.taxCents).toBe(2000);
  expect(bands[0]?.taxableCents).toBe(10_000);
});

test("a partial credit reverses a proportionate share and still balances", async () => {
  // $100 at 8.75%: tax 875, total 10875. Crediting 5000 of it is a share
  // that does not divide evenly — the band rounds on its own and the net
  // takes the remainder, so the document still credits exactly 5000.
  const invoice = await invoiceOf([
    {
      description: "Fittings",
      quantity: 1,
      unitPrice: 10_000,
      taxRatePpm: 87_500,
    },
  ]);
  expect(invoice.totalCents).toBe(10_875);

  const first = await creditOf(invoice.id, 5000);
  // round(875 × 5000 / 10875) = 402
  expect(first.taxCents).toBe(402);
  expect(first.subtotalCents).toBe(4598);
  const firstLines = await linesFor(`credit-note:${first.id}`);
  expect(balanced(firstLines)).toBe(5000);
  expect(debitOn(firstLines, "2200")).toBe(402);
  expect(debitOn(firstLines, "4000")).toBe(4598);

  // Crediting the rest gives back the rest: over both notes the whole of
  // the tax has come back out, not a cent more or less.
  const second = await creditOf(invoice.id, 5875);
  expect(second.taxCents).toBe(875 - 402);
  const secondLines = await linesFor(`credit-note:${second.id}`);
  expect(balanced(secondLines)).toBe(5875);
  expect(first.taxCents + second.taxCents).toBe(875);
});

test("a credit against a GST+PST sale unwinds both taxes to their own accounts", async () => {
  const gstId = await makeTax({ name: "GST 5%", ratePpm: 50_000 });
  const pstId = await makeTax({ name: "PST 7%", ratePpm: 70_000 });

  const invoice = await invoiceOf([
    {
      description: "Cabinets",
      quantity: 1,
      unitPrice: 10_000,
      taxDefinitionIds: [gstId, pstId],
    },
  ]);
  expect(invoice.taxCents).toBe(500 + 700);

  // Half of it back: half of each tax, to the account each was collected on.
  const note = await creditOf(invoice.id, 5600);
  expect(note.taxCents).toBe(250 + 350);
  const lines = await linesFor(`credit-note:${note.id}`);
  expect(balanced(lines)).toBe(5600);
  expect(debitOn(lines, `2200-${gstId.slice(0, 8)}`)).toBe(250);
  expect(debitOn(lines, `2200-${pstId.slice(0, 8)}`)).toBe(350);
  expect(debitOn(lines, "4000")).toBe(5000);
});

test("a credit against an untaxed sale invents no tax", async () => {
  const invoice = await invoiceOf([
    {
      description: "Zero-rated export",
      quantity: 1,
      unitPrice: 8000,
      taxRatePpm: 0,
    },
  ]);
  expect(invoice.taxCents).toBe(0);

  const note = await creditOf(invoice.id);
  expect(note.taxCents).toBe(0);
  const lines = await linesFor(`credit-note:${note.id}`);
  expect(balanced(lines)).toBe(8000);
  expect(debitOn(lines, "4000")).toBe(8000);
  expect(lines.some((l) => l.code.startsWith("2200"))).toBe(false);
});

test("an invoice cannot be credited past its total, however many notes it takes", async () => {
  // Each note alone stayed under the cap, so two full-value credits both
  // passed — an invoice credited for twice what it was ever worth.
  const invoice = await invoiceOf([
    { description: "Signage", quantity: 1, unitPrice: 5000, taxRatePpm: 0 },
  ]);
  await creditOf(invoice.id);

  const again = await app.request(
    `http://localhost/api/invoices/${invoice.id}/credit`,
    { method: "POST", headers, body: JSON.stringify({}) },
  );
  expect(again.status).toBe(400);
  expect(((await again.json()) as { error: string }).error).toContain("exceed");

  // And a partial history counts too: 3000 then 2500 is more than 5000.
  const second = await invoiceOf([
    { description: "Signage", quantity: 1, unitPrice: 5000, taxRatePpm: 0 },
  ]);
  await creditOf(second.id, 3000);
  const over = await app.request(
    `http://localhost/api/invoices/${second.id}/credit`,
    { method: "POST", headers, body: JSON.stringify({ amountCents: 2500 }) },
  );
  expect(over.status).toBe(400);
  // What is left of it can still be credited.
  await creditOf(second.id, 2000);
});

test("crediting settles the invoice the way a payment would", async () => {
  const invoice = await invoiceOf([
    { description: "Survey", quantity: 1, unitPrice: 10_000, taxRatePpm: 0 },
  ]);
  expect(invoice.status).toBe("open");

  await creditOf(invoice.id, 4000);
  const [partway] = await db
    .select({ status: schema.invoices.status })
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoice.id));
  expect(partway?.status).toBe("partial");

  await creditOf(invoice.id, 6000);
  const [settled] = await db
    .select({ status: schema.invoices.status })
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoice.id));
  // Fully credited is fully settled: nobody owes anything, and the
  // reminder job must stop chasing the customer for it.
  expect(settled?.status).toBe("paid");
});

test("a payment and a credit agree about what is still owed", async () => {
  const invoice = await invoiceOf([
    { description: "Callout", quantity: 1, unitPrice: 10_000, taxRatePpm: 0 },
  ]);
  await creditOf(invoice.id, 5000);

  // Paying the uncredited remainder settles it — the payments route counts
  // the credit, rather than keeping its own idea of what was owed.
  const res = await app.request(
    `http://localhost/api/invoices/${invoice.id}/payments`,
    { method: "POST", headers, body: JSON.stringify({ amountCents: 5000 }) },
  );
  expect(res.status).toBe(201);
  const paid = (await res.json()) as { status: string; balanceDue: number };
  expect(paid.status).toBe("paid");
  expect(paid.balanceDue).toBe(0);
});

test("a credited sale falls out of the US filing figures, for its jurisdiction", async () => {
  const ksId = await makeTax({
    name: "Kansas state tax",
    ratePpm: 65_000,
    jurisdiction: "US-KS",
  });
  const invoice = await invoiceOf([
    {
      description: "Shelving",
      quantity: 1,
      unitPrice: 10_000,
      taxDefinitionIds: [ksId],
    },
  ]);
  expect(invoice.taxCents).toBe(650);

  const year = new Date().getUTCFullYear();
  const from = new Date(`${year}-01-01T00:00:00Z`);
  const to = new Date(`${year}-12-31T23:59:59Z`);
  const before = await usFilingReport(orgId, from, to);
  const ksBefore = before.jurisdictions.find((j) => j.jurisdiction === "US-KS");
  if (!ksBefore) throw new Error("no US-KS figures before the credit");

  const note = await creditOf(invoice.id);
  expect(note.taxCents).toBe(650);

  // Both columns of the filing fall — the documents and the books — and
  // they still agree, which is the check an accountant runs before filing.
  const after = await usFilingReport(orgId, from, to);
  const ks = after.jurisdictions.find((j) => j.jurisdiction === "US-KS");
  if (!ks) throw new Error("no US-KS figures after the credit");
  expect(ks.taxCents).toBe(ksBefore.taxCents - 650);
  expect(ks.taxableCents).toBe(ksBefore.taxableCents - 10_000);
  expect(ks.ledgerTaxCents).toBe(ksBefore.ledgerTaxCents - 650);
  expect(ks.ledgerTaxCents).toBe(ks.taxCents);
});

test("a credited sale reduces the UK VAT return boxes, standard and flat rate", async () => {
  const invoice = await invoiceOf([
    {
      description: "Fit-out",
      quantity: 1,
      unitPrice: 20_000,
      taxRatePpm: 200_000,
    },
  ]);
  expect(invoice.totalCents).toBe(24_000);

  const before = vatReturn(await ledgerRows(orgId, {}));
  const flatBefore = flatRateVatReturn(await ledgerRows(orgId, {}), 145_000);

  // A partial credit: half the invoice. Box 1 falls by the tax share alone,
  // box 6 by the net alone — a credit that pulled the gross out of income
  // would understate turnover by its own tax.
  const note = await creditOf(invoice.id, 12_000);
  expect(note.taxCents).toBe(2000);

  const rows = await ledgerRows(orgId, {});
  const after = vatReturn(rows);
  expect(after.vatDueSales).toBe(before.vatDueSales - 2000);
  expect(after.totalValueSalesExVAT).toBe(before.totalValueSalesExVAT - 10_000);

  // Flat rate reads gross turnover: the whole 12,000 comes off box 6, and
  // box 1 is the sector percentage of what is left.
  const flat = flatRateVatReturn(rows, 145_000);
  expect(flat.totalValueSalesExVAT).toBe(
    flatBefore.totalValueSalesExVAT - 12_000,
  );
  expect(flat.vatDueSales).toBe(
    Math.round((flat.totalValueSalesExVAT * 145_000) / 1_000_000),
  );
});
