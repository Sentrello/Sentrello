import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import { ledgerRows, postJournalEntry } from "@sentrello/db/ledger";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import accounting from "./index";
import { vatReturn } from "./vat-return";

/**
 * The VAT scheme election, end to end: stored as a setting, applied by the
 * return, refused when incomplete.
 *
 * What matters most here is the one thing that must not move: a business that
 * has elected nothing gets the standard accrual return, bit for bit the same
 * arithmetic every instance has always produced. The schemes are additions
 * beside it, never changes to it.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const email = `vat-scheme-${suffix}@example.test`;
const app = new Hono<SentrelloEnv>();

let orgId: string;
let headers: Headers;
const accounts = new Map<string, string>();

async function account(code: string, name: string, type: string) {
  const [row] = await db
    .insert(schema.accounts)
    .values({ organizationId: orgId, code, name, type })
    .returning();
  if (!row) throw new Error(`could not create account ${code}`);
  accounts.set(code, row.id);
  return row.id;
}

const id = (code: string) => {
  const found = accounts.get(code);
  if (!found) throw new Error(`no account ${code}`);
  return found;
};

beforeAll(async () => {
  accounting.register({
    app,
    entitled: () => true,
    registerNav: () => {},
    registerPermission: () => {},
    registerSummary: () => {},
    registerWidget: () => {},
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
    body: { name: `VAT Scheme ${suffix}`, slug: `vat-scheme-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  await account("1000", "Cash", "asset");
  await account("1100", "Accounts Receivable", "asset");
  await account("2200", "Tax Payable", "liability");
  await account("4000", "Sales Income", "income");

  // An invoice: £1,000 of income and £200 of VAT, unpaid for now.
  await postJournalEntry(
    orgId,
    "Invoice",
    "test:invoice",
    [
      { accountId: id("1100"), debitCents: 120_000 },
      { accountId: id("4000"), creditCents: 100_000 },
      { accountId: id("2200"), creditCents: 20_000 },
    ],
    new Date("2026-03-10T00:00:00Z"),
  );
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
  for (const [table, column] of [
    [schema.journalEntries, schema.journalEntries.organizationId],
    [schema.accounts, schema.accounts.organizationId],
    [schema.ledgerSettings, schema.ledgerSettings.organizationId],
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

const get = (path: string) =>
  app.request(`http://localhost${path}`, { headers });
const put = (path: string, body: unknown) =>
  app.request(`http://localhost${path}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });

test("a business that has elected nothing is on the standard accrual scheme", async () => {
  const res = await get("/api/accounting/vat-scheme");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.scheme).toBe("standard");
  expect(body.basis).toBe("accrual");
  expect(body.flatRatePpm).toBeNull();
  // The eligibility figures carry the date they were checked, because they
  // change and an undated threshold is a trap.
  expect(body.reference.checked).toBe("2026-09-15");
});

test("the default return is the standard computation, bit for bit", async () => {
  const res = await get("/api/accounting/vat-return");
  expect(res.status).toBe(200);
  const body = await res.json();
  // The route and the pure function must be the same arithmetic — the route
  // is the pure function, over the same rows.
  expect(body.boxes).toEqual({ ...vatReturn(await ledgerRows(orgId, {})) });
  expect(body.boxes.vatDueSales).toBe(20_000);
  expect(body.boxes.totalValueSalesExVAT).toBe(100_000);
});

test("the flat rate scheme cannot be elected without its sector percentage", async () => {
  const res = await put("/api/accounting/vat-scheme", { scheme: "flat-rate" });
  expect(res.status).toBe(400);

  // And a typo'd percentage is refused at the door: 145% is nobody's sector.
  const typo = await put("/api/accounting/vat-scheme", {
    scheme: "flat-rate",
    flatRatePpm: 1_450_000,
  });
  expect(typo.status).toBe(400);
});

test("the flat rate return is the sector percentage of gross turnover", async () => {
  const set = await put("/api/accounting/vat-scheme", {
    scheme: "flat-rate",
    flatRatePpm: 145_000,
  });
  expect(set.status).toBe(200);

  const res = await get("/api/accounting/vat-return");
  const body = await res.json();
  // £1,200 gross at 14.5% = £174; no box 4 reclaim; box 6 is the gross.
  expect(body.boxes.vatDueSales).toBe(17_400);
  expect(body.boxes.vatReclaimedCurrPeriod).toBe(0);
  expect(body.boxes.totalValueSalesExVAT).toBe(120_000);

  // The limited cost figures are surfaced with the rule — and no verdict.
  expect(body.limitedCost).toEqual({
    grossTurnoverCents: 120_000,
    twoPercentOfTurnoverCents: 2_400,
    spendingCents: 0,
  });
  const note = (body.notCovered as string[]).find((n) =>
    n.includes("Limited cost"),
  );
  expect(note).toContain("yours or your accountant's");
  expect(note).toContain("checked 15 September 2026");
});

test("on the cash basis the unpaid invoice owes nothing until it is paid", async () => {
  const set = await put("/api/accounting/vat-scheme", {
    scheme: "flat-rate",
    flatRatePpm: 145_000,
    basis: "cash",
  });
  expect(set.status).toBe(200);

  const before = await (await get("/api/accounting/vat-return")).json();
  expect(before.boxes.vatDueSales).toBe(0);
  expect(before.boxes.totalValueSalesExVAT).toBe(0);

  await postJournalEntry(
    orgId,
    "Receipt",
    "test:receipt",
    [
      { accountId: id("1000"), debitCents: 120_000 },
      { accountId: id("1100"), creditCents: 120_000 },
    ],
    new Date("2026-05-02T00:00:00Z"),
  );

  const after = await (await get("/api/accounting/vat-return")).json();
  expect(after.boxes.vatDueSales).toBe(17_400);
  expect(after.boxes.totalValueSalesExVAT).toBe(120_000);
});

test("standard on the cash basis matches accrual once everything is paid", async () => {
  const set = await put("/api/accounting/vat-scheme", {
    scheme: "standard",
    basis: "cash",
  });
  expect(set.status).toBe(200);

  const cash = await (await get("/api/accounting/vat-return")).json();
  const accrual = vatReturn(await ledgerRows(orgId, {}));
  expect(cash.boxes.vatDueSales).toBe(accrual.vatDueSales);
  expect(cash.boxes.totalValueSalesExVAT).toBe(accrual.totalValueSalesExVAT);
});

test("a credit note reduces the return under every scheme", async () => {
  /**
   * The entry a tax-aware credit note posts — the sale's entry with its
   * sides swapped: Dr Income for the net, Dr VAT for the tax, Cr Receivable
   * for the whole. £100 + £20 credited back out of the £1,000 + £200 sale,
   * after the invoice was paid, so on the cash basis it is a real reduction
   * on its own date rather than something to unwind from the pool.
   */
  await postJournalEntry(
    orgId,
    "Credit note",
    "test:credit-note",
    [
      { accountId: id("4000"), debitCents: 10_000 },
      { accountId: id("2200"), debitCents: 2_000 },
      { accountId: id("1100"), creditCents: 12_000 },
    ],
    new Date("2026-05-10T00:00:00Z"),
  );

  // Standard, accrual: box 1 falls by the tax alone, box 6 by the net alone.
  await put("/api/accounting/vat-scheme", { scheme: "standard" });
  const standard = await (await get("/api/accounting/vat-return")).json();
  expect(standard.boxes.vatDueSales).toBe(18_000);
  expect(standard.boxes.totalValueSalesExVAT).toBe(90_000);

  // Standard, cash: the invoice is paid, so the credit lands on its own
  // date and the figures match accrual to the penny.
  await put("/api/accounting/vat-scheme", {
    scheme: "standard",
    basis: "cash",
  });
  const cash = await (await get("/api/accounting/vat-return")).json();
  expect(cash.boxes.vatDueSales).toBe(18_000);
  expect(cash.boxes.totalValueSalesExVAT).toBe(90_000);

  // Flat rate: the whole gross of the credit comes off the turnover, and
  // box 1 is the sector percentage of what is left — £1,080 at 14.5%.
  await put("/api/accounting/vat-scheme", {
    scheme: "flat-rate",
    flatRatePpm: 145_000,
  });
  const flat = await (await get("/api/accounting/vat-return")).json();
  expect(flat.boxes.totalValueSalesExVAT).toBe(108_000);
  expect(flat.boxes.vatDueSales).toBe(15_660);

  // Flat rate on the cash basis agrees, for the same reason as standard.
  await put("/api/accounting/vat-scheme", {
    scheme: "flat-rate",
    flatRatePpm: 145_000,
    basis: "cash",
  });
  const flatCash = await (await get("/api/accounting/vat-return")).json();
  expect(flatCash.boxes.totalValueSalesExVAT).toBe(108_000);
  expect(flatCash.boxes.vatDueSales).toBe(15_660);
});

test("a flat-rate election missing its percentage refuses to compute, not files zero", async () => {
  // Belt and braces: the PUT refuses this state, so put it there directly —
  // an older row, a hand edit — and make sure the return says why rather
  // than computing something.
  await db
    .update(schema.ledgerSettings)
    .set({ vatScheme: "flat-rate", vatFlatRatePpm: null })
    .where(eq(schema.ledgerSettings.organizationId, orgId));

  const res = await get("/api/accounting/vat-return");
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toContain("sector percentage");
});
