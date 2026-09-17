import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import invoicing from "./index";
import { usNexusPosition } from "./us-nexus";
import { US_NEXUS_THRESHOLDS, usStateCode } from "./us-nexus-thresholds";

const suffix = crypto.randomUUID().slice(0, 8);
const email = `us-tax-${suffix}@example.test`;
const app = new Hono<SentrelloEnv>();

let orgId: string;
let headers: Headers;
let companyId: string;
let contactId: string;

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
    body: { name: `US Tax ${suffix}`, slug: `us-tax-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  const [company] = await db
    .insert(schema.companies)
    .values({
      organizationId: orgId,
      name: "Prairie Supply Co",
      country: "US",
      state: "Kansas",
      city: "Wichita",
    })
    .returning();
  if (!company) throw new Error("could not create test company");
  companyId = company.id;

  const [contact] = await db
    .insert(schema.contacts)
    .values({
      organizationId: orgId,
      name: "Dana Buyer",
      email: "dana@prairie.test",
      companyId,
    })
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
    [schema.exemptionCertificates, schema.exemptionCertificates.organizationId],
    [schema.taxDefinitions, schema.taxDefinitions.organizationId],
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

/* ------------------------------------------------------------------ */
/* The thresholds table itself: reference data has to stay coherent.  */
/* ------------------------------------------------------------------ */

test("every state, DC and Puerto Rico appear in the thresholds table", () => {
  // 50 states + DC + PR.
  expect(Object.keys(US_NEXUS_THRESHOLDS)).toHaveLength(52);
  // The five with no general sales tax, and only those, carry null.
  const none = Object.entries(US_NEXUS_THRESHOLDS)
    .filter(([, t]) => t === null)
    .map(([s]) => s)
    .sort();
  expect(none).toEqual(["DE", "MT", "NH", "OR"]);
  for (const t of Object.values(US_NEXUS_THRESHOLDS)) {
    if (!t) continue;
    expect(t.salesCents).toBeGreaterThanOrEqual(10_000_000);
    if (t.transactions !== null) {
      expect(t.transactions).toBeGreaterThan(0);
    }
  }
});

test("state names and codes both resolve, garbage does not", () => {
  expect(usStateCode("TX")).toBe("TX");
  expect(usStateCode(" tx ")).toBe("TX");
  expect(usStateCode("Texas")).toBe("TX");
  expect(usStateCode("district of columbia")).toBe("DC");
  expect(usStateCode("Ontario")).toBeNull();
  expect(usStateCode("")).toBeNull();
  expect(usStateCode(null)).toBeNull();
});

/* ------------------------------------------------------------------ */
/* Rates by jurisdiction: the manual path, and the stacked posting.   */
/* ------------------------------------------------------------------ */

let stateTaxId: string;
let cityTaxId: string;

test("a tax rate can carry its jurisdiction, and becomes US sales tax", async () => {
  const res = await app.request("http://localhost/api/invoicing/taxes", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Kansas state tax",
      ratePpm: 65_000, // 6.5%
      jurisdiction: "us-ks",
    }),
  });
  expect(res.status).toBe(201);
  const { tax } = (await res.json()) as {
    tax: typeof schema.taxDefinitions.$inferSelect;
  };
  expect(tax.jurisdiction).toBe("US-KS");
  expect(tax.regime).toBe("us");
  // Sales tax is never reclaimed on a purchase; it is part of the cost.
  expect(tax.recoverable).toBe(false);
  stateTaxId = tax.id;

  const city = await app.request("http://localhost/api/invoicing/taxes", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Wichita city tax",
      ratePpm: 10_000, // 1%
      jurisdiction: "US-KS-WICHITA",
    }),
  });
  expect(city.status).toBe(201);
  cityTaxId = ((await city.json()) as { tax: { id: string } }).tax.id;
});

test("the manual lookup stacks the state rate with the city's", async () => {
  const res = await app.request(
    "http://localhost/api/invoicing/us-taxes?state=Kansas&city=Wichita",
    { headers },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    source: string;
    taxes: { id: string; jurisdiction: string; ratePpm: number }[];
  };
  expect(body.source).toBe("manual");
  expect(body.taxes.map((t) => t.jurisdiction).sort()).toEqual([
    "US-KS",
    "US-KS-WICHITA",
  ]);

  // A sale elsewhere in the state gets the state rate alone — the city's
  // rate must never follow a customer out of the city.
  const elsewhere = await app.request(
    "http://localhost/api/invoicing/us-taxes?state=KS&city=Topeka",
    { headers },
  );
  const other = (await elsewhere.json()) as {
    taxes: { jurisdiction: string }[];
  };
  expect(other.taxes.map((t) => t.jurisdiction)).toEqual(["US-KS"]);
});

test("stacked jurisdiction taxes total to the cent and post to separate liability accounts", async () => {
  // $1,234.56 at 6.5% + 1%: each tax rounds on its own, per line.
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "USD",
      lines: [
        {
          description: "Shop fittings",
          quantity: 1,
          unitPrice: 123_456,
          taxDefinitionIds: [stateTaxId, cityTaxId],
        },
      ],
    }),
  });
  expect(res.status).toBe(201);
  const { invoice } = (await res.json()) as {
    invoice: typeof schema.invoices.$inferSelect;
  };
  // 123456 × 6.5% = 8024.64 → 8025; × 1% = 1234.56 → 1235.
  expect(invoice.taxCents).toBe(8025 + 1235);
  expect(invoice.totalCents).toBe(123_456 + 8025 + 1235);

  // The entry is balanced and each jurisdiction has its own account.
  const [entry] = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(
      and(
        eq(schema.journalEntries.organizationId, orgId),
        eq(schema.journalEntries.source, `invoice:${invoice.id}`),
      ),
    );
  if (!entry) throw new Error("no journal entry for the invoice");
  const lines = await db
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

  const debits = lines.reduce((sum, l) => sum + l.debitCents, 0);
  const credits = lines.reduce((sum, l) => sum + l.creditCents, 0);
  expect(debits).toBe(credits);

  const stateAccount = lines.find(
    (l) => l.code === `2200-${stateTaxId.slice(0, 8)}`,
  );
  const cityAccount = lines.find(
    (l) => l.code === `2200-${cityTaxId.slice(0, 8)}`,
  );
  expect(stateAccount?.creditCents).toBe(8025);
  expect(cityAccount?.creditCents).toBe(1235);
});

test("a lone US tax still gets its own liability account, not the shared one", async () => {
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "USD",
      lines: [
        {
          description: "Consulting",
          quantity: 1,
          unitPrice: 10_000,
          taxDefinitionIds: [stateTaxId],
        },
      ],
    }),
  });
  expect(res.status).toBe(201);
  const { invoice } = (await res.json()) as { invoice: { id: string } };

  const [entry] = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(
      and(
        eq(schema.journalEntries.organizationId, orgId),
        eq(schema.journalEntries.source, `invoice:${invoice.id}`),
      ),
    );
  if (!entry) throw new Error("no journal entry for the invoice");
  const lines = await db
    .select({
      code: schema.accounts.code,
      credit: schema.journalLines.creditCents,
    })
    .from(schema.journalLines)
    .innerJoin(
      schema.accounts,
      eq(schema.journalLines.accountId, schema.accounts.id),
    )
    .where(eq(schema.journalLines.entryId, entry.id));
  expect(
    lines.find((l) => l.code === `2200-${stateTaxId.slice(0, 8)}`)?.credit,
  ).toBe(650);
  expect(lines.find((l) => l.code === "2200")).toBeUndefined();
});

/* ------------------------------------------------------------------ */
/* Nexus: warned before the threshold, not after.                     */
/* ------------------------------------------------------------------ */

test("a business approaching a state's threshold is warned before crossing it", async () => {
  // Kansas: $100,000. The two invoices above put ~$1,345 into KS; add a
  // large one to reach ~85% of the threshold.
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "USD",
      lines: [
        {
          description: "Annual supply contract",
          quantity: 1,
          unitPrice: 8_365_000, // $83,650
          taxDefinitionIds: [stateTaxId],
        },
      ],
    }),
  });
  expect(res.status).toBe(201);

  const position = await usNexusPosition(orgId);
  const ks = position.states.find((s) => s.state === "KS");
  if (!ks) throw new Error("Kansas missing from the nexus position");
  // 123456 + 10000 + 8365000 = 8498456 ≈ 85% of 10,000,000.
  expect(ks.yearCents).toBe(123_456 + 10_000 + 8_365_000);
  expect(ks.status).toBe("approaching");
  expect(ks.collecting).toBe(true); // the US-KS rate exists

  const route = await app.request("http://localhost/api/invoicing/us-nexus", {
    headers,
  });
  expect(route.status).toBe(200);
  const body = (await route.json()) as {
    states: { state: string; status: string; advice: string }[];
  };
  const row = body.states.find((s) => s.state === "KS");
  expect(row?.status).toBe("approaching");
  expect(row?.advice).toContain("approaching");
});

test("crossing the threshold turns the warning into 'over'", async () => {
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "USD",
      lines: [
        {
          description: "Second supply contract",
          quantity: 1,
          unitPrice: 2_000_000, // $20,000 — over $100k cumulative
          taxDefinitionIds: [stateTaxId],
        },
      ],
    }),
  });
  expect(res.status).toBe(201);

  const position = await usNexusPosition(orgId);
  const ks = position.states.find((s) => s.state === "KS");
  expect(ks?.status).toBe("over");
});

/* ------------------------------------------------------------------ */
/* Exemption certificates: evidence recorded, expiry enforced.        */
/* ------------------------------------------------------------------ */

let certificateId: string;

test("an exempt sale with a valid certificate charges no tax and records the evidence", async () => {
  const cert = await app.request("http://localhost/api/invoicing/exemptions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      companyId,
      number: "KS-EX-004521",
      state: "Kansas",
      reason: "resale",
      expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
    }),
  });
  expect(cert.status).toBe(201);
  const created = (await cert.json()) as {
    certificate: { id: string; state: string; status: string };
  };
  expect(created.certificate.state).toBe("KS");
  expect(created.certificate.status).toBe("valid");
  certificateId = created.certificate.id;

  // The browser sends taxed lines; the certificate overrides them all.
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "USD",
      exemptionCertificateId: certificateId,
      lines: [
        {
          description: "Wholesale stock",
          quantity: 10,
          unitPrice: 5_000,
          taxDefinitionIds: [stateTaxId, cityTaxId],
        },
      ],
    }),
  });
  expect(res.status).toBe(201);
  const { invoice } = (await res.json()) as {
    invoice: typeof schema.invoices.$inferSelect;
  };
  expect(invoice.taxCents).toBe(0);
  expect(invoice.totalCents).toBe(50_000);
  expect(invoice.exemptionCertificateId).toBe(certificateId);

  // The document's tax band says exempt — the figure a return asks for.
  const bands = await db
    .select()
    .from(schema.documentTaxes)
    .where(
      and(
        eq(schema.documentTaxes.documentType, "invoice"),
        eq(schema.documentTaxes.documentId, invoice.id),
      ),
    );
  expect(bands).toHaveLength(1);
  expect(bands[0]?.categoryCode).toBe("E");
  expect(bands[0]?.taxCents).toBe(0);
  expect(bands[0]?.taxableCents).toBe(50_000);
});

test("an expired certificate does not silently keep exempting", async () => {
  // The certificate dies.
  await db
    .update(schema.exemptionCertificates)
    .set({ expiresAt: new Date(Date.now() - 86_400_000) })
    .where(eq(schema.exemptionCertificates.id, certificateId));

  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "USD",
      exemptionCertificateId: certificateId,
      lines: [{ description: "More stock", quantity: 1, unitPrice: 5_000 }],
    }),
  });
  expect(res.status).toBe(422);
  const body = (await res.json()) as { error: string };
  expect(body.error).toContain("expired");

  // And the list says so, rather than leaving it to be discovered.
  const list = await app.request("http://localhost/api/invoicing/exemptions", {
    headers,
  });
  const { certificates } = (await list.json()) as {
    certificates: { id: string; status: string }[];
  };
  expect(certificates.find((c) => c.id === certificateId)?.status).toBe(
    "expired",
  );
});

test("a draft written under a certificate is re-checked on the day it is issued", async () => {
  // Bring the certificate back to life, draft under it, kill it, issue.
  await db
    .update(schema.exemptionCertificates)
    .set({ expiresAt: new Date(Date.now() + 30 * 86_400_000) })
    .where(eq(schema.exemptionCertificates.id, certificateId));

  const draft = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "USD",
      status: "draft",
      exemptionCertificateId: certificateId,
      lines: [{ description: "Held order", quantity: 1, unitPrice: 7_500 }],
    }),
  });
  expect(draft.status).toBe(201);
  const { invoice } = (await draft.json()) as { invoice: { id: string } };

  await db
    .update(schema.exemptionCertificates)
    .set({ expiresAt: new Date(Date.now() - 86_400_000) })
    .where(eq(schema.exemptionCertificates.id, certificateId));

  const issue = await app.request(
    `http://localhost/api/invoices/${invoice.id}/issue`,
    { method: "POST", headers, body: JSON.stringify({}) },
  );
  expect(issue.status).toBe(422);
  expect(((await issue.json()) as { error: string }).error).toContain(
    "expired",
  );
});

test("a revoked certificate refuses too", async () => {
  await db
    .update(schema.exemptionCertificates)
    .set({ expiresAt: new Date(Date.now() + 30 * 86_400_000) })
    .where(eq(schema.exemptionCertificates.id, certificateId));
  const revoke = await app.request(
    `http://localhost/api/invoicing/exemptions/${certificateId}/revoke`,
    { method: "POST", headers },
  );
  expect(revoke.status).toBe(200);

  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "USD",
      exemptionCertificateId: certificateId,
      lines: [{ description: "Stock", quantity: 1, unitPrice: 5_000 }],
    }),
  });
  expect(res.status).toBe(422);
  expect(((await res.json()) as { error: string }).error).toContain("revoked");
});

/* ------------------------------------------------------------------ */
/* Filing figures: per jurisdiction, reconciled to the ledger.        */
/* ------------------------------------------------------------------ */

test("filing figures for the period reconcile to the ledger, jurisdiction by jurisdiction", async () => {
  const year = new Date().getUTCFullYear();
  const res = await app.request(
    `http://localhost/api/invoicing/us-filing?from=${year}-01-01&to=${year}-12-31`,
    { headers },
  );
  expect(res.status).toBe(200);
  const report = (await res.json()) as {
    jurisdictions: {
      jurisdiction: string;
      taxableCents: number;
      taxCents: number;
      ledgerTaxCents: number;
    }[];
    exempt: { state: string; exemptCents: number; invoices: number }[];
  };

  const ks = report.jurisdictions.find((j) => j.jurisdiction === "US-KS");
  const wichita = report.jurisdictions.find(
    (j) => j.jurisdiction === "US-KS-WICHITA",
  );
  if (!ks || !wichita) throw new Error("jurisdictions missing from filing");

  // Every taxed invoice above: 123456 + 10000 + 8365000 + 2000000 to the
  // state; the city taxed only the first.
  expect(ks.taxableCents).toBe(123_456 + 10_000 + 8_365_000 + 2_000_000);
  expect(wichita.taxableCents).toBe(123_456);
  expect(wichita.taxCents).toBe(1235);

  // The check an accountant runs before filing: documents and books agree.
  expect(ks.ledgerTaxCents).toBe(ks.taxCents);
  expect(wichita.ledgerTaxCents).toBe(wichita.taxCents);

  // The exempt sale is accounted for, under its certificate's state.
  const exemptKs = report.exempt.find((e) => e.state === "KS");
  expect(exemptKs?.exemptCents).toBe(50_000);
  expect(exemptKs?.invoices).toBe(1);
});
