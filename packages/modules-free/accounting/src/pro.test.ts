import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { parseCsv } from "./csv";
import accounting from "./index";
import { taxOn } from "./taxes";

/**
 * The Pro half that has not moved yet: taxes, currency, dimensions, custom
 * fields, journal entries and the reports.
 *
 * Two apps, because the gate is the point — `pro` is an entitled instance and
 * `free` is not, and every one of these endpoints has to be missing entirely
 * from the second.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const email = `accounting-pro-${suffix}@example.test`;
const pro = new Hono<SentrelloEnv>();
const free = new Hono<SentrelloEnv>();

let orgId: string;
let headers: Headers;

beforeAll(async () => {
  const context = (entitled: boolean, app: Hono<SentrelloEnv>) => ({
    app,
    entitled: () => entitled,
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
  accounting.register(context(true, pro));
  accounting.register(context(false, free));

  const signUp = await signUpAsOwner({
    email,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Accounting Pro ${suffix}`, slug: `acc-pro-${suffix}` },
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
  const bills = await db
    .select({ id: schema.bills.id })
    .from(schema.bills)
    .where(eq(schema.bills.organizationId, orgId));
  if (bills.length > 0) {
    await db.delete(schema.billLines).where(
      inArray(
        schema.billLines.billId,
        bills.map((b) => b.id),
      ),
    );
  }
  const entries = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));
  if (entries.length > 0) {
    await db.delete(schema.journalLines).where(
      inArray(
        schema.journalLines.entryId,
        entries.map((e) => e.id),
      ),
    );
  }
  for (const [table, column] of [
    [schema.journalEntries, schema.journalEntries.organizationId],
    [schema.billPayments, schema.billPayments.organizationId],
    [schema.recurringBills, schema.recurringBills.organizationId],
    [schema.bills, schema.bills.organizationId],
    [schema.bankTransactions, schema.bankTransactions.organizationId],
    [schema.bankImports, schema.bankImports.organizationId],
    [schema.payments, schema.payments.organizationId],
    [schema.invoices, schema.invoices.organizationId],
    [schema.transactions, schema.transactions.organizationId],
    [schema.taxDefinitions, schema.taxDefinitions.organizationId],
    [schema.contacts, schema.contacts.organizationId],
    [schema.accounts, schema.accounts.organizationId],
  ] as const) {
    await db.delete(table).where(eq(column, orgId));
  }
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  const [user] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email));
  if (user) {
    await db.delete(schema.session).where(eq(schema.session.userId, user.id));
    await db.delete(schema.account).where(eq(schema.account.userId, user.id));
    await db.delete(schema.user).where(eq(schema.user.id, user.id));
  }
});

const post = (path: string, body: unknown, app = pro) =>
  app.request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

const get = async <T>(path: string, app = pro): Promise<T> => {
  const res = await app.request(`http://localhost${path}`, { headers });
  return (await res.json()) as T;
};

/** Every posted line for this business, with the account code beside it. */
const journal = () =>
  db
    .select({
      code: schema.accounts.code,
      debitCents: schema.journalLines.debitCents,
      creditCents: schema.journalLines.creditCents,
      source: schema.journalEntries.source,
    })
    .from(schema.journalLines)
    .innerJoin(
      schema.journalEntries,
      eq(schema.journalLines.entryId, schema.journalEntries.id),
    )
    .innerJoin(
      schema.accounts,
      eq(schema.journalLines.accountId, schema.accounts.id),
    )
    .where(eq(schema.journalEntries.organizationId, orgId));

/**
 * One of this business's accounts, by code.
 *
 * Filtered by organization as well as by code, which is not fussiness: the
 * suites share a process, and a helper that matched on code alone handed this
 * file another organization's cash account — after which every posting it made
 * was refused, correctly, and the test read as a bug in the transfer route.
 */
const accountId = async (code: string) => {
  const [found] = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.organizationId, orgId),
        eq(schema.accounts.code, code),
      ),
    )
    .limit(1);
  if (!found) throw new Error(`no account ${code} in this organization`);
  return found.id;
};

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test("none of this exists on a Free instance", async () => {
  for (const path of [
    "/api/reports/trial-balance",
    "/api/reports/cash-flow",
    "/api/reports/tax-summary",
    "/api/reports/accounts-receivable",
    "/api/reports/accounts-payable",
    "/api/reports/by-category",
    "/api/accounting/taxes/presets",
  ]) {
    const res = await free.request(`http://localhost${path}`, { headers });
    expect(res.status).toBe(404);
  }
});

test("the Free half still answers on a Free instance", async () => {
  // The point of the split: what a business had before a licence, it keeps.
  for (const path of [
    "/api/accounts",
    "/api/transactions",
    "/api/journal",
    "/api/reports/profit-and-loss",
    "/api/reports/balance-sheet",
  ]) {
    const res = await free.request(`http://localhost${path}`, { headers });
    expect(res.status).toBe(200);
  }
});

// ---------------------------------------------------------------------------
// Boundary
// ---------------------------------------------------------------------------

test("the Free half's receipts file no longer names the Pro-only bills table", () => {
  const source = readFileSync(join(import.meta.dir, "receipts.ts"), "utf8");
  expect(source).not.toContain("schema.bills");
});

// ---------------------------------------------------------------------------
// Tax
// ---------------------------------------------------------------------------

test("a compound rate is charged on the tax as well as the net", async () => {
  // 100.00 at 5% simple is 5.00; a 9.975% compound rate is charged on 105.00.
  expect(taxOn(10_000, [{ rateBp: 500 }])).toBe(500);
  expect(
    taxOn(10_000, [{ rateBp: 500 }, { rateBp: 998, compound: true }]),
  ).toBe(500 + Math.round((10_500 * 998) / 10000));
});

test("a regime's rates install once", async () => {
  const first = await post("/api/accounting/taxes/presets", { regime: "uk" });
  expect(((await first.json()) as { added: number }).added).toBeGreaterThan(0);
  const second = await post("/api/accounting/taxes/presets", { regime: "uk" });
  expect(((await second.json()) as { added: number }).added).toBe(0);

  const rows = await db
    .select({ name: schema.taxDefinitions.name })
    .from(schema.taxDefinitions)
    .where(eq(schema.taxDefinitions.organizationId, orgId));
  expect(rows.filter((row) => row.name === "VAT 20%")).toHaveLength(1);
});

test("a regime we do not sell into is refused", async () => {
  const res = await post("/api/accounting/taxes/presets", { regime: "au" });
  expect(res.status).toBe(400);
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

test("the trial balance balances, and the aged reports add up", async () => {
  const trial = await get<{
    debitCents: number;
    creditCents: number;
    balanced: boolean;
    accounts: { code: string }[];
  }>("/api/reports/trial-balance");
  expect(trial.balanced).toBe(true);
  expect(trial.debitCents).toBe(trial.creditCents);

  const payable = await get<{
    bills: { balanceDue: number }[];
    aging: {
      current: number;
      days30: number;
      days60: number;
      days90plus: number;
    };
    totalCents: number;
  }>("/api/reports/accounts-payable");
  const bucketed =
    payable.aging.current +
    payable.aging.days30 +
    payable.aging.days60 +
    payable.aging.days90plus;
  expect(bucketed).toBe(payable.totalCents);
});

test("the ledger exports as a file an accountant can open", async () => {
  // A manual entry, so there is at least one line for the export to carry.
  // The tests that used to leave entries behind here — bills, currency — left
  // for the paid bundle with purchases; this file now posts its own through
  // the manual-entry route, which is Group D's and stays.
  await post("/api/accounts/standard", {});
  const cash = await accountId("1000");
  const income = await accountId("4000");
  await post("/api/journal/entries", {
    memo: "Export fixture",
    lines: [
      { accountId: cash, debitCents: 100 },
      { accountId: income, creditCents: 100 },
    ],
  });

  const res = await pro.request("http://localhost/api/reports/export.csv", {
    headers,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/csv");
  const rows = parseCsv(await res.text());
  expect(rows[0]).toEqual([
    "posted_at",
    "account_code",
    "account_name",
    "type",
    "debit_cents",
    "credit_cents",
  ]);
  expect(rows.length).toBeGreaterThan(1);
});

// ---------------------------------------------------------------------------
// Reading what a bank gives you
// ---------------------------------------------------------------------------

test("a quoted field keeps its commas", () => {
  const rows = parseCsv('a,"b,c",d\n1,2,3');
  expect(rows[0]).toEqual(["a", "b,c", "d"]);
  expect(rows[1]).toEqual(["1", "2", "3"]);
});
