import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, schema } from "@sentrello/db";
import { registerForTest } from "@sentrello/module-sdk";
import accounting from "./index";

/**
 * An expense has to land somewhere a profit and loss can see it.
 *
 * Every ownership check in this module answers "is this account yours", which
 * `1000 Cash` passes. Categorising a courier fee to it posts a journal entry
 * that balances — debit Cash, credit Cash — and then reports nothing, because
 * a profit and loss is built from income and expense accounts and Cash is
 * neither. The money is gone from the bank and the business shows no expense.
 *
 * That is not hypothetical. The demo instance ran this way for months: eight
 * overheads on the ledger, and `Expenses $0.00` on the summary screen directly
 * above them. It was found by looking at the screen, not by the suite, which
 * is why these tests exist at the route rather than at the arithmetic.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const app = registerForTest(accounting);

let headers: Headers;
let orgId: string;
let overheads = "";
let sales = "";
let cash = "";

const req = (path: string, init?: RequestInit) =>
  app.request(`http://localhost${path}`, { headers, ...init });
const post = (path: string, body: unknown) =>
  req(path, { method: "POST", body: JSON.stringify(body) });

async function account(code: string, name: string, type: string) {
  const res = await post("/api/accounts", { code, name, type });
  const { account: made } = (await res.json()) as { account: { id: string } };
  return made.id;
}

/** What the profit and loss says, which is the figure that matters here. */
async function profitAndLoss() {
  const res = await req("/api/reports/profit-and-loss");
  return (await res.json()) as { incomeCents: number; expenseCents: number };
}

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email: `cat-${suffix}@x.test`,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Cat ${suffix}`, slug: `cat-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  overheads = await account("6000", "General Expenses", "expense");
  sales = await account("4000", "Sales Income", "income");
  cash = await account("1000", "Cash", "asset");
});

afterAll(async () => {
  const entries = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));
  for (const entry of entries) {
    await db
      .delete(schema.journalLines)
      .where(eq(schema.journalLines.entryId, entry.id));
  }
  for (const t of [
    schema.transactions,
    schema.journalEntries,
    schema.accounts,
    schema.securityEvents,
    schema.ledgerSettings,
  ]) {
    await db.delete(t).where(eq(t.organizationId, orgId));
  }
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
});

test("money out categorised to an asset account is refused, not posted", async () => {
  const res = await post("/api/expenses", {
    amountCents: 3_900,
    accountId: cash,
    paidThroughAccountId: cash,
    vendor: "Courier — Sable Same-Day",
  });

  expect(res.status).toBe(400);
  expect((await res.json()) as { error: string }).toEqual({
    error: "money out must be categorised to an expense account",
  });

  // Refused all the way down: nothing on the screen and nothing in the books.
  const rows = await db
    .select()
    .from(schema.transactions)
    .where(eq(schema.transactions.organizationId, orgId));
  expect(rows).toHaveLength(0);
});

test("money in categorised to an expense account is refused", async () => {
  const res = await post("/api/transactions", {
    kind: "income",
    amountCents: 50_000,
    accountId: overheads,
    paidThroughAccountId: cash,
    description: "Retainer",
  });

  expect(res.status).toBe(400);
  expect((await res.json()) as { error: string }).toEqual({
    error: "money in must be categorised to an income account",
  });

  // And the same amount against the income account is accepted, so the guard
  // is refusing the wrong kind rather than refusing the field.
  const ok = await post("/api/transactions", {
    kind: "income",
    amountCents: 50_000,
    accountId: sales,
    paidThroughAccountId: cash,
    description: "Retainer",
  });
  expect(ok.status).toBe(201);
  expect((await profitAndLoss()).incomeCents).toBe(50_000);
});

/**
 * The whole reason the guard is worth having.
 *
 * Not "the route returned 400" but "the figure a business reads is right":
 * eight overheads recorded correctly are eight overheads on the profit and
 * loss. Delete the type check in `createTransaction` and this is the test that
 * fails, with `expenseCents` back at zero.
 */
test("an expense categorised properly reaches the profit and loss", async () => {
  const before = await profitAndLoss();

  const res = await post("/api/expenses", {
    amountCents: 92_000,
    accountId: overheads,
    paidThroughAccountId: cash,
    vendor: "Calder Yard — rent",
  });
  expect(res.status).toBe(201);

  const after = await profitAndLoss();
  expect(after.expenseCents - before.expenseCents).toBe(92_000);
});

test("recategorising onto an asset account is refused too", async () => {
  const made = await post("/api/expenses", {
    amountCents: 6_850,
    accountId: overheads,
    paidThroughAccountId: cash,
    vendor: "Ridgeline Stationers",
  });
  const { expense } = (await made.json()) as { expense: { id: string } };

  const res = await req(`/api/transactions/${expense.id}`, {
    method: "PATCH",
    body: JSON.stringify({ accountId: cash }),
  });
  expect(res.status).toBe(400);

  // And it is still where it was, rather than half-moved.
  const [row] = await db
    .select()
    .from(schema.transactions)
    .where(eq(schema.transactions.id, expense.id))
    .limit(1);
  expect(row?.accountId).toBe(overheads);
});

/**
 * An account that is not this business's still says "unknown account".
 *
 * The new message names a *kind*, and must not become the answer to a question
 * about a different tenant's chart — that would confirm the id exists.
 */
test("another business's account is still refused as unknown", async () => {
  const other = await auth.api.createOrganization({
    body: { name: `Other ${suffix}`, slug: `other-${suffix}` },
    headers,
  });
  if (!other) throw new Error("could not create the second organization");

  await auth.api.setActiveOrganization({
    body: { organizationId: other.id },
    headers,
  });
  const theirOverheads = await account("6000", "General Expenses", "expense");

  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  const res = await post("/api/expenses", {
    amountCents: 1_000,
    accountId: theirOverheads,
    paidThroughAccountId: cash,
    vendor: "Not ours",
  });
  expect(res.status).toBe(400);

  const entries = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, other.id));
  for (const entry of entries) {
    await db
      .delete(schema.journalLines)
      .where(eq(schema.journalLines.entryId, entry.id));
  }
  for (const t of [
    schema.transactions,
    schema.journalEntries,
    schema.accounts,
    schema.securityEvents,
    schema.ledgerSettings,
  ]) {
    await db.delete(t).where(eq(t.organizationId, other.id));
  }
  await db
    .delete(schema.member)
    .where(eq(schema.member.organizationId, other.id));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, other.id));
});
