import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import { storeAttachment } from "@sentrello/module-sdk";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { parseCsv } from "./csv";
import accounting from "./index";
import { packKey } from "./receipts";
import { runRecurringBills } from "./recurring-bills";
import { taxOn } from "./taxes";

/**
 * The Pro half: bills, banking, budgets and the rest of the reports.
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
  const budgets = await db
    .select({ id: schema.budgets.id })
    .from(schema.budgets)
    .where(eq(schema.budgets.organizationId, orgId));
  if (budgets.length > 0) {
    await db.delete(schema.budgetLines).where(
      inArray(
        schema.budgetLines.budgetId,
        budgets.map((b) => b.id),
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
    [schema.budgets, schema.budgets.organizationId],
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
    "/api/bills",
    "/api/bills/vendors",
    "/api/budgets",
    "/api/reports/trial-balance",
    "/api/reports/cash-flow",
    "/api/reports/tax-summary",
    "/api/reports/accounts-receivable",
    "/api/reports/accounts-payable",
    "/api/reports/by-category",
    "/api/accounting/taxes/presets",
    // A bill's receipt is a Pro concern end to end — see purchases.ts. A Free
    // instance has never registered this path at all, the same as every
    // other bill route above; there is no id for which it would answer.
    "/api/bills/00000000-0000-0000-0000-000000000000/receipt",
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
// Bills
// ---------------------------------------------------------------------------

test("a draft bill is not in the books until it is approved", async () => {
  await post("/api/accounts/standard", {});
  const rent = await accountId("6100");

  const created = await post("/api/bills", {
    number: "SUP-1",
    billDate: "2024-02-01",
    lines: [
      {
        description: "February rent",
        unitPriceCents: 120_000,
        accountId: rent,
      },
    ],
  });
  expect(created.status).toBe(201);
  const { bill } = (await created.json()) as {
    bill: { id: string; totalCents: number; status: string };
  };
  expect(bill.totalCents).toBe(120_000);
  expect(bill.status).toBe("draft");

  expect((await journal()).some((l) => l.source === `bill:${bill.id}`)).toBe(
    false,
  );

  const approved = await post(`/api/bills/${bill.id}/approve`, {});
  expect(approved.status).toBe(200);

  const lines = (await journal()).filter((l) => l.source === `bill:${bill.id}`);
  expect(lines.some((l) => l.code === "6100" && l.debitCents === 120_000)).toBe(
    true,
  );
  expect(
    lines.some((l) => l.code === "2000" && l.creditCents === 120_000),
  ).toBe(true);
  expect(lines.reduce((s, l) => s + l.debitCents, 0)).toBe(
    lines.reduce((s, l) => s + l.creditCents, 0),
  );
});

test("approving twice is refused", async () => {
  const created = await post("/api/bills", {
    lines: [{ description: "Once", unitPriceCents: 1000 }],
  });
  const { bill } = (await created.json()) as { bill: { id: string } };
  expect((await post(`/api/bills/${bill.id}/approve`, {})).status).toBe(200);
  expect((await post(`/api/bills/${bill.id}/approve`, {})).status).toBe(409);
});

/**
 * Tax that comes back is not a cost.
 *
 * VAT and GST are reclaimed, so they are a debit against what the business owes
 * the authority. US sales tax is not, so it is part of what the thing cost.
 * Posting the second as the first would overstate both the expense claim and
 * the refund.
 */
test("recoverable tax goes to the tax account and sales tax goes to the cost", async () => {
  const [vat] = await db
    .insert(schema.taxDefinitions)
    .values({
      organizationId: orgId,
      name: `VAT ${suffix}`,
      rateBp: 2000,
      recoverable: true,
    })
    .returning();
  const [salesTax] = await db
    .insert(schema.taxDefinitions)
    .values({
      organizationId: orgId,
      name: `Sales Tax ${suffix}`,
      rateBp: 1000,
      recoverable: false,
    })
    .returning();
  const software = await accountId("6500");

  const withVat = await post("/api/bills", {
    lines: [
      {
        description: "Hosting",
        unitPriceCents: 10_000,
        accountId: software,
        taxRateBp: 2000,
        taxDefinitionId: vat?.id,
      },
    ],
  });
  const first = (await withVat.json()) as { bill: { id: string } };
  await post(`/api/bills/${first.bill.id}/approve`, {});
  const vatLines = (await journal()).filter(
    (l) => l.source === `bill:${first.bill.id}`,
  );
  expect(
    vatLines.some((l) => l.code === "2200" && l.debitCents === 2_000),
  ).toBe(true);
  expect(
    vatLines.some((l) => l.code === "6500" && l.debitCents === 10_000),
  ).toBe(true);

  const withSalesTax = await post("/api/bills", {
    lines: [
      {
        description: "Desk",
        unitPriceCents: 10_000,
        accountId: software,
        taxRateBp: 1000,
        taxDefinitionId: salesTax?.id,
      },
    ],
  });
  const second = (await withSalesTax.json()) as { bill: { id: string } };
  await post(`/api/bills/${second.bill.id}/approve`, {});
  const sunkLines = (await journal()).filter(
    (l) => l.source === `bill:${second.bill.id}`,
  );
  // the whole 11,000 lands on the expense, and nothing on the tax account
  expect(
    sunkLines.some((l) => l.code === "6500" && l.debitCents === 11_000),
  ).toBe(true);
  expect(sunkLines.some((l) => l.code === "2200")).toBe(false);
  expect(sunkLines.reduce((s, l) => s + l.debitCents, 0)).toBe(
    sunkLines.reduce((s, l) => s + l.creditCents, 0),
  );
});

test("paying a bill clears the payable and takes the money from cash", async () => {
  const created = await post("/api/bills", {
    lines: [{ description: "Parts", unitPriceCents: 5_000 }],
  });
  const { bill } = (await created.json()) as { bill: { id: string } };
  await post(`/api/bills/${bill.id}/approve`, {});

  const paid = await post(`/api/bills/${bill.id}/payments`, {
    amountCents: 2_000,
  });
  expect(paid.status).toBe(201);
  expect(((await paid.json()) as { status: string }).status).toBe("partial");

  const rest = await post(`/api/bills/${bill.id}/payments`, {
    amountCents: 3_000,
  });
  expect(((await rest.json()) as { status: string }).status).toBe("paid");

  const lines = (await journal()).filter((l) =>
    l.source?.startsWith("bill-payment:"),
  );
  expect(lines.filter((l) => l.code === "2000").length).toBeGreaterThan(0);
  expect(lines.reduce((s, l) => s + l.debitCents, 0)).toBe(
    lines.reduce((s, l) => s + l.creditCents, 0),
  );
});

test("paying more than is owed is refused", async () => {
  const created = await post("/api/bills", {
    lines: [{ description: "Small", unitPriceCents: 1_000 }],
  });
  const { bill } = (await created.json()) as { bill: { id: string } };
  await post(`/api/bills/${bill.id}/approve`, {});
  const res = await post(`/api/bills/${bill.id}/payments`, {
    amountCents: 1_500,
  });
  expect(res.status).toBe(400);
});

/**
 * Withheld tax is owed to the authority, not to the supplier.
 *
 * The debt is settled in full either way, which is why Accounts Payable is
 * debited with the whole amount while the bank only pays the difference.
 */
test("tax withheld from a payment is credited to the tax account", async () => {
  const created = await post("/api/bills", {
    lines: [{ description: "Contractor", unitPriceCents: 100_000 }],
  });
  const { bill } = (await created.json()) as { bill: { id: string } };
  await post(`/api/bills/${bill.id}/approve`, {});

  const paid = await post(`/api/bills/${bill.id}/payments`, {
    amountCents: 100_000,
    withheldCents: 20_000,
  });
  const { payment } = (await paid.json()) as { payment: { id: string } };
  const lines = (await journal()).filter(
    (l) => l.source === `bill-payment:${payment.id}`,
  );
  expect(lines.some((l) => l.code === "2000" && l.debitCents === 100_000)).toBe(
    true,
  );
  expect(lines.some((l) => l.code === "1000" && l.creditCents === 80_000)).toBe(
    true,
  );
  expect(lines.some((l) => l.code === "2200" && l.creditCents === 20_000)).toBe(
    true,
  );
});

test("voiding an approved bill reverses what it posted", async () => {
  const created = await post("/api/bills", {
    lines: [{ description: "Mistake", unitPriceCents: 7_000 }],
  });
  const { bill } = (await created.json()) as { bill: { id: string } };
  await post(`/api/bills/${bill.id}/approve`, {});

  const payableBefore = (await journal())
    .filter((l) => l.code === "2000")
    .reduce((sum, l) => sum + l.creditCents - l.debitCents, 0);

  const voided = await post(`/api/bills/${bill.id}/void`, {});
  expect(voided.status).toBe(200);

  const payableAfter = (await journal())
    .filter((l) => l.code === "2000")
    .reduce((sum, l) => sum + l.creditCents - l.debitCents, 0);
  expect(payableAfter).toBe(payableBefore - 7_000);
});

test("a bill that has been paid cannot simply be voided", async () => {
  const created = await post("/api/bills", {
    lines: [{ description: "Settled", unitPriceCents: 4_000 }],
  });
  const { bill } = (await created.json()) as { bill: { id: string } };
  await post(`/api/bills/${bill.id}/approve`, {});
  await post(`/api/bills/${bill.id}/payments`, { amountCents: 4_000 });
  expect((await post(`/api/bills/${bill.id}/void`, {})).status).toBe(409);
});

test("a line priced in fractions of a cent is refused", async () => {
  const res = await post("/api/bills", {
    lines: [{ description: "Rounding", unitPriceCents: 12.5 }],
  });
  expect(res.status).toBe(400);
});

test("the Free half's receipts file no longer names the Pro-only bills table", () => {
  const source = readFileSync(join(import.meta.dir, "receipts.ts"), "utf8");
  expect(source).not.toContain("schema.bills");
});

/**
 * The scan of what the supplier actually sent, attached to the bill it
 * belongs to and read back the way `receipts.ts` proves for a transaction —
 * now against `purchases.ts`, the file that has owned `bills` since this
 * route moved out of the Free half.
 */
test("a receipt can be attached to a bill and read back", async () => {
  process.env.SENTRELLO_DATA_DIR = `/tmp/sentrello-test-${suffix}`;

  const created = await post("/api/bills", {
    lines: [{ description: "Paper towels", unitPriceCents: 500 }],
  });
  const { bill } = (await created.json()) as { bill: { id: string } };

  const form = new FormData();
  form.append(
    "file",
    new File(["<script>alert(1)</script>"], "receipt.html", {
      type: "text/html",
    }),
  );
  const uploaded = await pro.request(
    `http://localhost/api/bills/${bill.id}/receipt`,
    {
      method: "POST",
      headers: { cookie: headers.get("cookie") ?? "" },
      body: form,
    },
  );
  expect(uploaded.status).toBe(201);

  const got = await pro.request(
    `http://localhost/api/bills/${bill.id}/receipt`,
    { headers },
  );
  expect(got.status).toBe(200);
  // Never text/html: an uploaded page served as one runs as this origin, with
  // the reader's session.
  expect(got.headers.get("content-type")).toBe("application/octet-stream");
  expect(got.headers.get("content-disposition")).toContain("attachment");

  const detached = await pro.request(
    `http://localhost/api/bills/${bill.id}/receipt`,
    { method: "DELETE", headers },
  );
  expect(detached.status).toBe(200);
  expect(
    (
      await pro.request(`http://localhost/api/bills/${bill.id}/receipt`, {
        headers,
      })
    ).status,
  ).toBe(404);
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
// Budgets and reports
// ---------------------------------------------------------------------------

test("a budget reads against what the ledger says happened", async () => {
  const rent = await accountId("6100");
  const created = await post("/api/budgets", { name: "2024", year: 2024 });
  const { budget } = (await created.json()) as { budget: { id: string } };

  const set = await pro.request(
    `http://localhost/api/budgets/${budget.id}/lines`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        lines: [{ accountId: rent, month: 0, amountCents: 1_500_000 }],
      }),
    },
  );
  expect(set.status).toBe(200);

  const actuals = await get<{
    rows: {
      accountId: string;
      budgetedCents: number;
      actualCents: number;
      varianceCents: number;
    }[];
  }>(`/api/budgets/${budget.id}/actuals`);
  const line = actuals.rows.find((row) => row.accountId === rent);
  // the February rent bill, approved above, is the only 2024 spend on it
  expect(line?.budgetedCents).toBe(1_500_000);
  expect(line?.actualCents).toBe(120_000);
  expect(line?.varianceCents).toBe(1_380_000);
});

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

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

test("another business's bills are invisible from here", async () => {
  const theirs = `other-org-${crypto.randomUUID().slice(0, 8)}`;
  const [bill] = await db
    .insert(schema.bills)
    .values({
      organizationId: theirs,
      number: "THEIR-SECRET-BILL",
      status: "open",
      totalCents: 987_654,
    })
    .returning();

  for (const path of [
    "/api/bills",
    "/api/reports/accounts-payable",
    "/api/bank-transactions",
  ]) {
    const body = await (
      await pro.request(`http://localhost${path}`, { headers })
    ).text();
    expect(body).not.toContain("THEIR-SECRET-BILL");
    expect(body).not.toContain("987654");
  }

  const stolen = await pro.request(`http://localhost/api/bills/${bill?.id}`, {
    headers,
  });
  expect(stolen.status).toBe(404);

  await db.delete(schema.bills).where(eq(schema.bills.organizationId, theirs));
});

test("a receipt on another business's bill is not readable", async () => {
  process.env.SENTRELLO_DATA_DIR = `/tmp/sentrello-test-${suffix}`;
  const theirs = `other-org-${crypto.randomUUID().slice(0, 8)}`;

  // A file that really is on disk, not a made-up path — see the same note on
  // the equivalent transaction test in index.test.ts.
  const stored = await storeAttachment(
    theirs,
    new File(["their private invoice"], "theirs.pdf"),
    "receipts",
  );
  const [bill] = await db
    .insert(schema.bills)
    .values({
      organizationId: theirs,
      number: "THEIR-RECEIPT-BILL",
      status: "open",
      totalCents: 500,
      receiptFileKey: packKey(stored.path, stored.name),
    })
    .returning();

  const res = await pro.request(
    `http://localhost/api/bills/${bill?.id}/receipt`,
    { headers },
  );
  expect(res.status).toBe(404);
  expect(await res.text()).not.toContain("their private invoice");

  await db.delete(schema.bills).where(eq(schema.bills.organizationId, theirs));
});

// ---------------------------------------------------------------------------
// More than one currency
// ---------------------------------------------------------------------------

/**
 * A bill in euros is a debt of euros, and the books are kept in dollars.
 *
 * Everything about this is the arithmetic: the liability is recorded at the
 * rate on the day of the bill, the money leaves at the rate on the day it is
 * paid, and the difference is neither a cost the business chose nor income it
 * earned. Without somewhere for that difference to go, the payment entry
 * simply would not balance.
 */
test("a foreign bill is refused until there is a rate for it", async () => {
  const created = await post("/api/bills", {
    currency: "EUR",
    lines: [{ description: "Translation", unitPriceCents: 50_000 }],
  });
  const { bill } = (await created.json()) as { bill: { id: string } };
  const refused = await post(`/api/bills/${bill.id}/approve`, {});
  expect(refused.status).toBe(400);

  const rate = await post("/api/accounting/currencies", {
    code: "EUR",
    rateMicro: 1_100_000,
    asOf: "2024-01-01",
  });
  expect(rate.status).toBe(201);

  const approved = await post(`/api/bills/${bill.id}/approve`, {});
  expect(approved.status).toBe(200);

  const lines = (await journal()).filter((l) => l.source === `bill:${bill.id}`);
  // 500.00 EUR at 1.1 is 550.00 in the books
  expect(lines.some((l) => l.code === "2000" && l.creditCents === 55_000)).toBe(
    true,
  );
  expect(lines.reduce((s, l) => s + l.debitCents, 0)).toBe(
    lines.reduce((s, l) => s + l.creditCents, 0),
  );
});

test("the rate moving between the bill and the payment is an exchange difference", async () => {
  const created = await post("/api/bills", {
    currency: "EUR",
    billDate: "2024-02-01",
    lines: [{ description: "Filing agent", unitPriceCents: 100_000 }],
  });
  const { bill } = (await created.json()) as { bill: { id: string } };
  await post(`/api/bills/${bill.id}/approve`, {});

  // the euro is dearer by the time it is paid
  await post("/api/accounting/currencies", {
    code: "EUR",
    rateMicro: 1_200_000,
    asOf: "2024-03-01",
  });

  const paid = await post(`/api/bills/${bill.id}/payments`, {
    amountCents: 100_000,
    paidAt: "2024-03-05",
  });
  expect(paid.status).toBe(201);
  const { payment } = (await paid.json()) as { payment: { id: string } };

  const lines = (await journal()).filter(
    (l) => l.source === `bill-payment:${payment.id}`,
  );
  // the debt was 1,100.00; 1,200.00 left the bank; the 100.00 is the rate
  expect(lines.some((l) => l.code === "2000" && l.debitCents === 110_000)).toBe(
    true,
  );
  expect(
    lines.some((l) => l.code === "1000" && l.creditCents === 120_000),
  ).toBe(true);
  expect(lines.some((l) => l.code === "7000" && l.debitCents === 10_000)).toBe(
    true,
  );
  expect(lines.reduce((s, l) => s + l.debitCents, 0)).toBe(
    lines.reduce((s, l) => s + l.creditCents, 0),
  );
});

test("the currency the books are kept in cannot be changed once they have entries", async () => {
  const res = await pro.request(
    "http://localhost/api/accounting/currencies/base",
    { method: "PUT", headers, body: JSON.stringify({ code: "GBP" }) },
  );
  expect(res.status).toBe(409);
});

// ---------------------------------------------------------------------------
// Bills that arrive on a schedule
// ---------------------------------------------------------------------------

/**
 * A recurring bill produces a draft, never a posting.
 *
 * A bill is somebody else's claim: the figure often differs from last month's,
 * and posting a liability nobody has looked at is how a set of books fills up
 * with amounts the business never agreed to.
 */
test("a schedule copies its template into a draft and moves on", async () => {
  const created = await post("/api/bills", {
    number: "RENT-TEMPLATE",
    billDate: "2026-01-01",
    dueDate: "2026-01-15",
    lines: [{ description: "Monthly rent", unitPriceCents: 92_000 }],
  });
  const { bill } = (await created.json()) as { bill: { id: string } };

  const scheduled = await post("/api/recurring-bills", {
    templateBillId: bill.id,
    interval: "monthly",
    nextRunAt: "2026-02-01",
    name: "Rent",
  });
  expect(scheduled.status).toBe(201);

  const before = (await get<{ bills: { id: string }[] }>("/api/bills")).bills
    .length;
  expect(await runRecurringBills(new Date("2026-02-02"))).toBe(1);

  const after = await get<{
    bills: {
      id: string;
      status: string;
      totalCents: number;
      dueDate: string | null;
    }[];
  }>("/api/bills");
  expect(after.bills.length).toBe(before + 1);

  const drafts = after.bills.filter((b) => b.status === "draft");
  expect(drafts.some((b) => b.totalCents === 92_000)).toBe(true);

  // nothing was posted for it
  const posted = (await journal()).filter((l) =>
    drafts.some((draft) => l.source === `bill:${draft.id}`),
  );
  expect(posted).toHaveLength(0);

  // and the schedule has moved to March, not February again
  const schedules = await get<{
    schedules: { nextRunAt: string; generatedCount: number }[];
  }>("/api/recurring-bills");
  const rent = schedules.schedules[0];
  expect(rent?.generatedCount).toBe(1);
  expect(new Date(rent?.nextRunAt as string).getUTCMonth()).toBe(2);

  // running again the same day produces nothing
  expect(await runRecurringBills(new Date("2026-02-02"))).toBe(0);
});

test("the due date keeps its distance rather than being copied", async () => {
  const bills = await get<{
    bills: {
      number: string | null;
      billDate: string;
      dueDate: string | null;
    }[];
  }>("/api/bills");
  const copy = bills.bills.find(
    (b) => b.number === "RENT-TEMPLATE" && b.billDate.startsWith("2026-02"),
  );
  // fourteen days after its own date, not the template's January date
  expect(copy?.dueDate?.startsWith("2026-02-15")).toBe(true);
});

test("a schedule past its end date stops rather than running for ever", async () => {
  const created = await post("/api/bills", {
    number: "ENDS",
    lines: [{ description: "Short-lived", unitPriceCents: 1_000 }],
  });
  const { bill } = (await created.json()) as { bill: { id: string } };
  await post("/api/recurring-bills", {
    templateBillId: bill.id,
    interval: "monthly",
    nextRunAt: "2026-01-01",
    endsOn: "2026-01-15",
  });

  await runRecurringBills(new Date("2026-03-01"));
  const schedules = await get<{ schedules: { active: boolean }[] }>(
    "/api/recurring-bills",
  );
  expect(schedules.schedules.some((s) => s.active === false)).toBe(true);
});

/**
 * A month of a budget, against that month of the ledger.
 *
 * A yearly figure is spread evenly when a single month is asked for: a
 * business that budgets 12,000 for rent has budgeted 1,000 for March whether
 * or not it said so. A figure set for March itself wins over the spread.
 */
test("a budget reads by month as well as by year", async () => {
  const rent = await accountId("6100");
  const created = await post("/api/budgets", { name: "Monthly", year: 2024 });
  const { budget } = (await created.json()) as { budget: { id: string } };

  await pro.request(`http://localhost/api/budgets/${budget.id}/lines`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      lines: [
        { accountId: rent, month: 0, amountCents: 1_200_000 },
        { accountId: rent, month: 2, amountCents: 150_000 },
      ],
    }),
  });

  const year = await get<{
    month: number | null;
    rows: { accountId: string; budgetedCents: number; actualCents: number }[];
  }>(`/api/budgets/${budget.id}/actuals`);
  expect(year.month).toBeNull();
  expect(year.rows.find((r) => r.accountId === rent)?.budgetedCents).toBe(
    1_350_000,
  );

  // February: the month's own figure plus a twelfth of the year's
  const february = await get<{
    month: number | null;
    rows: { accountId: string; budgetedCents: number; actualCents: number }[];
  }>(`/api/budgets/${budget.id}/actuals?month=2`);
  expect(february.month).toBe(2);
  const line = february.rows.find((r) => r.accountId === rent);
  expect(line?.budgetedCents).toBe(150_000 + 100_000);
  // and only February's spending — the rent bill approved earlier is dated
  // the 1st of February
  expect(line?.actualCents).toBe(120_000);

  const march = await get<{
    rows: { accountId: string; actualCents: number }[];
  }>(`/api/budgets/${budget.id}/actuals?month=3`);
  expect(march.rows.find((r) => r.accountId === rent)?.actualCents ?? 0).toBe(
    0,
  );
});
