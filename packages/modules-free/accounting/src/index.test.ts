import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import { postJournalEntry } from "@sentrello/db/ledger";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { storeAttachment } from "@sentrello/module-sdk";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import accounting from "./index";
import { packKey } from "./receipts";

const suffix = crypto.randomUUID().slice(0, 8);
const email = `accounting-${suffix}@example.test`;
const app = new Hono<SentrelloEnv>();

let orgId: string;
let headers: Headers;

beforeAll(async () => {
  accounting.register({
    app,
    entitled: () => true,
    registerNav: () => {},
    registerPermission: () => {},
    registerSummary: () => {},
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
    body: { name: `Accounting ${suffix}`, slug: `accounting-${suffix}` },
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
    [schema.transactions, schema.transactions.organizationId],
    [schema.expenses, schema.expenses.organizationId],
    [schema.accounts, schema.accounts.organizationId],
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

const post = (path: string, body: unknown) =>
  app.request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

const patch = (path: string, body: unknown) =>
  app.request(`http://localhost${path}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });

const del = (path: string) =>
  app.request(`http://localhost${path}`, { method: "DELETE", headers });

const get = async <T>(path: string): Promise<T> => {
  const res = await app.request(`http://localhost${path}`, { headers });
  return (await res.json()) as T;
};

interface Pnl {
  incomeCents: number;
  expenseCents: number;
  netCents: number;
  income: { code: string; balanceCents: number }[];
  expenses: { code: string; balanceCents: number }[];
}

const pnl = (query = "") => get<Pnl>(`/api/reports/profit-and-loss${query}`);

// ---------------------------------------------------------------------------
// Recording money
// ---------------------------------------------------------------------------

test("an expense reaches the profit and loss", async () => {
  // The report is read from the ledger, so an expense that is only a row in a
  // table is an expense the business never sees.
  const before = await pnl();

  const res = await post("/api/transactions", {
    kind: "expense",
    description: "Ink Co",
    amountCents: 4599,
  });
  expect(res.status).toBe(201);

  const after = await pnl();
  expect(after.expenseCents).toBe(before.expenseCents + 4599);
  expect(after.netCents).toBe(before.netCents - 4599);
});

test("the entry it posts is balanced, and hits cash", async () => {
  await post("/api/transactions", {
    kind: "expense",
    description: "Fuel",
    amountCents: 3000,
  });

  const rows = await db
    .select({
      debitCents: schema.journalLines.debitCents,
      creditCents: schema.journalLines.creditCents,
      code: schema.accounts.code,
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

  const fuel = rows.filter(
    (r) => r.debitCents === 3000 || r.creditCents === 3000,
  );
  expect(fuel.some((r) => r.code === "6000" && r.debitCents === 3000)).toBe(
    true,
  );
  expect(fuel.some((r) => r.code === "1000" && r.creditCents === 3000)).toBe(
    true,
  );

  const debits = rows.reduce((s, r) => s + r.debitCents, 0);
  const credits = rows.reduce((s, r) => s + r.creditCents, 0);
  expect(debits).toBe(credits);
});

/**
 * Money in is not money out with a different label.
 *
 * The sides are reversed — cash is debited and the income account credited —
 * and getting that backwards would show a business's takings as costs while
 * still balancing, which is the kind of wrong nothing else catches.
 */
test("income debits cash and credits the income account", async () => {
  const before = await pnl();

  const res = await post("/api/transactions", {
    kind: "income",
    description: "Market stall",
    amountCents: 7500,
  });
  expect(res.status).toBe(201);

  const after = await pnl();
  expect(after.incomeCents).toBe(before.incomeCents + 7500);
  expect(after.expenseCents).toBe(before.expenseCents);
  expect(after.netCents).toBe(before.netCents + 7500);

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
    .innerJoin(
      schema.journalEntries,
      eq(schema.journalLines.entryId, schema.journalEntries.id),
    )
    .where(eq(schema.journalEntries.organizationId, orgId));

  const takings = lines.filter(
    (l) => l.debitCents === 7500 || l.creditCents === 7500,
  );
  expect(takings.some((l) => l.code === "1000" && l.debitCents === 7500)).toBe(
    true,
  );
  expect(takings.some((l) => l.code === "4200" && l.creditCents === 7500)).toBe(
    true,
  );
});

/**
 * A receipt from last month belongs to last month.
 *
 * Without a date on the entry, every report for a period would change
 * depending on when somebody got round to typing the receipt in.
 */
test("a transaction is posted on the date it happened", async () => {
  await post("/api/transactions", {
    kind: "expense",
    description: "Last year's rent",
    amountCents: 90_000,
    occurredAt: "2020-03-15T00:00:00.000Z",
  });

  const thisPeriod = await pnl("?from=2024-01-01&to=2035-01-01");
  const backThen = await pnl("?from=2020-01-01&to=2020-12-31");

  expect(backThen.expenseCents).toBe(90_000);
  expect(thisPeriod.expenseCents).not.toBe(0);
  expect(thisPeriod.expenses.some((e) => e.balanceCents === 90_000)).toBe(
    false,
  );
});

test("an expense posts to the account it was given", async () => {
  const created = await post("/api/accounts", {
    code: "6210",
    name: "Software",
    type: "expense",
  });
  const { account } = (await created.json()) as { account: { id: string } };

  await post("/api/transactions", {
    kind: "expense",
    description: "Some SaaS",
    amountCents: 1200,
    accountId: account.id,
  });

  const [line] = await db
    .select({ debitCents: schema.journalLines.debitCents })
    .from(schema.journalLines)
    .where(eq(schema.journalLines.accountId, account.id));
  expect(line?.debitCents).toBe(1200);
});

test("an account belonging to someone else is refused", async () => {
  // The id comes from the caller, so it is the obvious way to try to write
  // into another tenant's ledger.
  const [foreign] = await db
    .insert(schema.accounts)
    .values({
      organizationId: `org_other_${suffix}`,
      code: "6300",
      name: "Not yours",
      type: "expense",
    })
    .returning();

  const res = await post("/api/transactions", {
    kind: "expense",
    description: "Nice try",
    amountCents: 500,
    accountId: foreign?.id,
  });
  expect(res.status).toBe(400);

  const lines = await db
    .select()
    .from(schema.journalLines)
    .where(eq(schema.journalLines.accountId, foreign?.id ?? ""));
  expect(lines).toHaveLength(0);

  await db
    .delete(schema.accounts)
    .where(eq(schema.accounts.id, foreign?.id ?? ""));
});

test("an amount that is not integer cents is refused", async () => {
  const res = await post("/api/transactions", {
    description: "Rounding",
    amountCents: 12.5,
  });
  expect(res.status).toBe(400);
});

test("the expenses endpoint the rest of the product calls still works", async () => {
  const created = await post("/api/expenses", {
    vendor: "Legacy Ltd",
    amountCents: 2500,
  });
  expect(created.status).toBe(201);

  const { expenses } = await get<{
    expenses: { id: string; vendor: string | null; amountCents: number }[];
  }>("/api/expenses");
  const found = expenses.find((e) => e.vendor === "Legacy Ltd");
  expect(found?.amountCents).toBe(2500);

  // and it is the same store the transactions screen reads
  const { transactions } = await get<{
    transactions: { id: string; description: string | null }[];
  }>("/api/transactions?kind=expense");
  expect(transactions.some((t) => t.id === found?.id)).toBe(true);
});

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

/**
 * Undoing is posting the opposite, not deleting the entry.
 *
 * A business that printed a report last week has to be able to explain the
 * figure on it, which it cannot do if the entry behind it was removed.
 */
test("undoing a transaction reverses it in the ledger and keeps the history", async () => {
  const before = await pnl();
  const created = await post("/api/transactions", {
    kind: "expense",
    description: "Bought in error",
    amountCents: 5000,
  });
  const { transaction } = (await created.json()) as {
    transaction: { id: string };
  };
  expect((await pnl()).expenseCents).toBe(before.expenseCents + 5000);

  const undone = await del(`/api/transactions/${transaction.id}`);
  expect(undone.status).toBe(200);

  expect((await pnl()).expenseCents).toBe(before.expenseCents);

  // the entry is still there, and so is its reversal
  const entries = await db
    .select({ source: schema.journalEntries.source })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));
  expect(entries.some((e) => e.source === `expense:${transaction.id}`)).toBe(
    true,
  );
  expect(entries.some((e) => e.source?.startsWith("reversal:"))).toBe(true);

  // and the row is kept, marked as undone
  const [row] = await db
    .select({ reversedAt: schema.transactions.reversedAt })
    .from(schema.transactions)
    .where(eq(schema.transactions.id, transaction.id));
  expect(row?.reversedAt).toBeTruthy();
});

test("undoing twice does not undo it twice", async () => {
  const created = await post("/api/transactions", {
    kind: "expense",
    description: "Double click",
    amountCents: 1500,
  });
  const { transaction } = (await created.json()) as {
    transaction: { id: string };
  };
  await del(`/api/transactions/${transaction.id}`);
  const after = await pnl();
  await del(`/api/transactions/${transaction.id}`);
  expect((await pnl()).expenseCents).toBe(after.expenseCents);
});

test("correcting an amount reverses the old figure and posts the new one", async () => {
  const before = await pnl();
  const created = await post("/api/transactions", {
    kind: "expense",
    description: "Typed wrong",
    amountCents: 10_000,
  });
  const { transaction } = (await created.json()) as {
    transaction: { id: string };
  };

  const res = await patch(`/api/transactions/${transaction.id}`, {
    amountCents: 2_500,
  });
  expect(res.status).toBe(200);

  const after = await pnl();
  expect(after.expenseCents).toBe(before.expenseCents + 2_500);

  // the books still balance after a correction
  const lines = await db
    .select({
      debitCents: schema.journalLines.debitCents,
      creditCents: schema.journalLines.creditCents,
    })
    .from(schema.journalLines)
    .innerJoin(
      schema.journalEntries,
      eq(schema.journalLines.entryId, schema.journalEntries.id),
    )
    .where(eq(schema.journalEntries.organizationId, orgId));
  expect(lines.reduce((s, l) => s + l.debitCents, 0)).toBe(
    lines.reduce((s, l) => s + l.creditCents, 0),
  );
});

test("wording can be corrected without touching the ledger", async () => {
  const created = await post("/api/transactions", {
    kind: "expense",
    description: "Stationary",
    amountCents: 800,
  });
  const { transaction } = (await created.json()) as {
    transaction: { id: string };
  };
  const entriesBefore = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));

  await patch(`/api/transactions/${transaction.id}`, {
    description: "Stationery",
  });

  const entriesAfter = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));
  expect(entriesAfter).toHaveLength(entriesBefore.length);
});

// ---------------------------------------------------------------------------
// The chart of accounts
// ---------------------------------------------------------------------------

test("the standard chart can be filled in twice without doubling", async () => {
  const first = await post("/api/accounts/standard", {});
  expect(first.status).toBe(200);
  const second = await post("/api/accounts/standard", {});
  expect(((await second.json()) as { added: number }).added).toBe(0);

  const { accounts } = await get<{ accounts: { code: string }[] }>(
    "/api/accounts",
  );
  const rents = accounts.filter((a) => a.code === "6100");
  expect(rents).toHaveLength(1);
});

test("a duplicate account code is refused", async () => {
  const res = await post("/api/accounts", {
    code: "6100",
    name: "Rent again",
    type: "expense",
  });
  expect(res.status).toBe(409);
});

test("an account with postings is archived, not deleted", async () => {
  const created = await post("/api/accounts", {
    code: "6910",
    name: "Sundries",
    type: "expense",
  });
  const { account } = (await created.json()) as { account: { id: string } };
  await post("/api/transactions", {
    kind: "expense",
    description: "Something",
    amountCents: 100,
    accountId: account.id,
  });

  const refused = await del(`/api/accounts/${account.id}`);
  expect(refused.status).toBe(409);

  const archived = await patch(`/api/accounts/${account.id}`, {
    archived: true,
  });
  expect(archived.status).toBe(200);

  const { accounts } = await get<{ accounts: { id: string }[] }>(
    "/api/accounts",
  );
  expect(accounts.some((a) => a.id === account.id)).toBe(false);

  const all = await get<{ accounts: { id: string }[] }>(
    "/api/accounts?archived=1",
  );
  expect(all.accounts.some((a) => a.id === account.id)).toBe(true);
});

test("an unused account can be deleted", async () => {
  const created = await post("/api/accounts", {
    code: "6920",
    name: "Never used",
    type: "expense",
  });
  const { account } = (await created.json()) as { account: { id: string } };
  const res = await del(`/api/accounts/${account.id}`);
  expect(res.status).toBe(200);
});

test("an account cannot be filed under itself, however far round", async () => {
  const a = (await (
    await post("/api/accounts", { code: "7010", name: "A", type: "expense" })
  ).json()) as { account: { id: string } };
  const b = (await (
    await post("/api/accounts", { code: "7020", name: "B", type: "expense" })
  ).json()) as { account: { id: string } };

  expect(
    (await patch(`/api/accounts/${b.account.id}`, { parentId: a.account.id }))
      .status,
  ).toBe(200);
  // A under B closes the loop A → B → A
  const loop = await patch(`/api/accounts/${a.account.id}`, {
    parentId: b.account.id,
  });
  expect(loop.status).toBe(400);

  const itself = await patch(`/api/accounts/${a.account.id}`, {
    parentId: a.account.id,
  });
  expect(itself.status).toBe(400);
});

test("an account's type is fixed once anything is posted to it", async () => {
  const created = await post("/api/accounts", {
    code: "7100",
    name: "Was an expense",
    type: "expense",
  });
  const { account } = (await created.json()) as { account: { id: string } };
  await post("/api/transactions", {
    kind: "expense",
    description: "One posting",
    amountCents: 100,
    accountId: account.id,
  });
  const res = await patch(`/api/accounts/${account.id}`, { type: "asset" });
  expect(res.status).toBe(409);
});

// ---------------------------------------------------------------------------
// The statements
// ---------------------------------------------------------------------------

/**
 * The balance sheet is the whole ledger seen from the other side.
 *
 * Assets less liabilities less equity less earnings is zero for any set of
 * balanced entries, so this failing means something reached the journal that
 * should not have.
 */
test("the balance sheet balances", async () => {
  const sheet = await get<{
    assetsCents: number;
    liabilitiesCents: number;
    equityCents: number;
    earningsCents: number;
    balanced: boolean;
  }>("/api/reports/balance-sheet");

  expect(sheet.balanced).toBe(true);
  expect(
    sheet.assetsCents -
      sheet.liabilitiesCents -
      sheet.equityCents -
      sheet.earningsCents,
  ).toBe(0);
});

test("a balance sheet as at a date ignores what happened after it", async () => {
  const asOf2021 = await get<{ assetsCents: number; earningsCents: number }>(
    "/api/reports/balance-sheet?asOf=2021-01-01",
  );
  // only the 2020 rent is on the books by then: cash is down 90,000 and the
  // earnings line carries the same loss
  expect(asOf2021.assetsCents).toBe(-90_000);
  expect(asOf2021.earningsCents).toBe(-90_000);
});

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

/**
 * The books are the most private thing in the instance.
 *
 * Every business query is supposed to be organizationId-scoped; this is the
 * test that says so out loud for the ledger, rather than trusting that every
 * `where` clause was written correctly. A missed filter here shows one
 * business another's accounts.
 */
test("another organization's books are invisible from here", async () => {
  const theirs = `other-org-${crypto.randomUUID().slice(0, 8)}`;

  const [account] = await db
    .insert(schema.accounts)
    .values({
      organizationId: theirs,
      code: "9999",
      name: "Their Secret Account",
      type: "expense",
    })
    .returning();

  await db.insert(schema.transactions).values({
    organizationId: theirs,
    kind: "expense",
    amountCents: 123_456,
    description: "Their Supplier",
  });

  const entry = await postJournalEntry(theirs, "Theirs", "test:theirs", [
    { accountId: account?.id as string, debitCents: 123_456 },
    { accountId: account?.id as string, creditCents: 123_456 },
  ]);
  expect(entry).toBeTruthy();

  for (const path of [
    "/api/accounts",
    "/api/accounts/balances",
    "/api/expenses",
    "/api/transactions",
    "/api/journal",
    "/api/reports/profit-and-loss",
    "/api/reports/balance-sheet",
  ]) {
    const res = await app.request(`http://localhost${path}`, { headers });
    const body = await res.text();
    expect(body).not.toContain("Their Secret Account");
    expect(body).not.toContain("Their Supplier");
    expect(body).not.toContain("123456");
  }

  // Clean up the other organization's rows.
  await db
    .delete(schema.journalLines)
    .where(eq(schema.journalLines.entryId, entry.id));
  await db
    .delete(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, theirs));
  await db
    .delete(schema.transactions)
    .where(eq(schema.transactions.organizationId, theirs));
  await db
    .delete(schema.accounts)
    .where(eq(schema.accounts.organizationId, theirs));
});

/**
 * The Pro reports bundle reads these names, and it is already on disk.
 *
 * It shipped before this module existed, so a rename here blanks a paying
 * customer's balance sheet on the day they update — which is exactly what an
 * earlier attempt at this compatibility did, silently, until the screen was
 * opened.
 */
test("the balance sheet keeps the field names the Pro screen reads", async () => {
  const sheet = await get<{
    earningsCents: number;
    retainedEarningsCents: number;
    balanced: boolean;
    balancedCents: number;
  }>("/api/reports/balance-sheet");

  expect(sheet.retainedEarningsCents).toBe(sheet.earningsCents);
  expect(sheet.balancedCents).toBe(0);
  expect(sheet.balanced).toBe(true);
});

/**
 * A period ending today has to include today.
 *
 * The screen sends the dates a person picked, and a person picking "to 23
 * August" means the end of the 23rd. Read as midnight, a report run in the
 * afternoon showed none of that morning's work — which reads as a broken
 * report rather than as a boundary.
 */
test("a period ending on a date includes that whole day", async () => {
  const created = await post("/api/transactions", {
    kind: "income",
    description: "Recorded this afternoon",
    amountCents: 4_242,
    occurredAt: new Date().toISOString(),
  });
  expect(created.status).toBe(201);

  const today = new Date().toISOString().slice(0, 10);
  const period = await pnl(`?from=${today}&to=${today}`);
  expect(period.incomeCents).toBeGreaterThanOrEqual(4_242);

  const sheet = await get<{ earningsCents: number }>(
    `/api/reports/balance-sheet?asOf=${today}`,
  );
  expect(sheet.earningsCents).not.toBe(0);
});

// ---------------------------------------------------------------------------
// The paper behind a figure
// ---------------------------------------------------------------------------

/**
 * Bookkeeping is half arithmetic and half evidence.
 *
 * An inspector asks for the receipt, not the entry. These check the three
 * things that make holding one safe: the file comes back only to somebody who
 * may read the record, it comes back as a download rather than as something
 * the browser will run, and detaching it does not destroy the bytes.
 */
test("a receipt can be attached to a transaction and read back", async () => {
  process.env.SENTRELLO_DATA_DIR = `/tmp/sentrello-test-${suffix}`;

  const created = await post("/api/transactions", {
    kind: "expense",
    description: "Fuel with a receipt",
    amountCents: 4_000,
  });
  const { transaction } = (await created.json()) as {
    transaction: { id: string };
  };

  const form = new FormData();
  form.append(
    "file",
    new File(["<script>alert(1)</script>"], "receipt.html", {
      type: "text/html",
    }),
  );
  const uploaded = await app.request(
    `http://localhost/api/transactions/${transaction.id}/receipt`,
    {
      method: "POST",
      headers: { cookie: headers.get("cookie") ?? "" },
      body: form,
    },
  );
  expect(uploaded.status).toBe(201);

  const got = await app.request(
    `http://localhost/api/transactions/${transaction.id}/receipt`,
    { headers },
  );
  expect(got.status).toBe(200);
  // Never text/html: an uploaded page served as one runs as this origin, with
  // the reader's session.
  expect(got.headers.get("content-type")).toBe("application/octet-stream");
  expect(got.headers.get("content-disposition")).toContain("attachment");

  const detached = await del(`/api/transactions/${transaction.id}/receipt`);
  expect(detached.status).toBe(200);
  expect(
    (
      await app.request(
        `http://localhost/api/transactions/${transaction.id}/receipt`,
        { headers },
      )
    ).status,
  ).toBe(404);
});

test("a receipt on another business's transaction is not readable", async () => {
  process.env.SENTRELLO_DATA_DIR = `/tmp/sentrello-test-${suffix}`;
  const theirs = `other-org-${crypto.randomUUID().slice(0, 8)}`;

  /**
   * A file that really is on disk, not a made-up path.
   *
   * With a made-up one this passes even without the organization filter — the
   * file simply is not there — and a test that passes for the wrong reason is
   * worse than none, because it is the reason nobody looks again.
   */
  const stored = await storeAttachment(
    theirs,
    new File(["their private invoice"], "theirs.pdf"),
    "receipts",
  );
  const [row] = await db
    .insert(schema.transactions)
    .values({
      organizationId: theirs,
      kind: "expense",
      amountCents: 100,
      receiptFileKey: packKey(stored.path, stored.name),
    })
    .returning();

  const res = await app.request(
    `http://localhost/api/transactions/${row?.id}/receipt`,
    { headers },
  );
  expect(res.status).toBe(404);
  expect(await res.text()).not.toContain("their private invoice");

  await db
    .delete(schema.transactions)
    .where(eq(schema.transactions.organizationId, theirs));
});

/**
 * "Fuel, this quarter" — the question a business asks its bookkeeping.
 *
 * The server has taken kind, from and to since it was written and the screen
 * never sent any of them, so the only view of the books was everything, newest
 * first. The total is part of the answer: adding the rows up by hand off the
 * screen is how a business gets a different figure every time it looks.
 */
test("the money list filters, searches, and totals what it shows", async () => {
  const record = (body: Record<string, unknown>) =>
    app.request("http://localhost/api/transactions", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

  await record({
    kind: "expense",
    description: "Diesel at the depot",
    amountCents: 8_000,
    occurredAt: "2027-02-10",
  });
  await record({
    kind: "expense",
    description: "Diesel, motorway",
    amountCents: 4_500,
    occurredAt: "2027-05-02",
  });
  await record({
    kind: "income",
    description: "Job in Barnsley",
    amountCents: 30_000,
    occurredAt: "2027-02-20",
  });

  const ask = async (query: string) => {
    const res = await app.request(
      `http://localhost/api/transactions?${query}`,
      { headers },
    );
    return (await res.json()) as {
      transactions: { description: string | null }[];
      totals: { inCents: number; outCents: number; netCents: number };
    };
  };

  // The quarter, both kinds.
  const quarter = await ask("from=2027-01-01&to=2027-03-31");
  expect(quarter.transactions).toHaveLength(2);
  expect(quarter.totals.inCents).toBe(30_000);
  expect(quarter.totals.outCents).toBe(8_000);
  expect(quarter.totals.netCents).toBe(22_000);

  // What it says on the line, across the year.
  const fuel = await ask("q=diesel&from=2027-01-01&to=2027-12-31");
  expect(fuel.transactions).toHaveLength(2);
  expect(fuel.totals.outCents).toBe(12_500);
  // Nothing came in on those, so the net is what went out.
  expect(fuel.totals.netCents).toBe(-12_500);

  // And one kind on its own, which is what the tabs send.
  const takings = await ask("kind=income&from=2027-01-01&to=2027-12-31");
  expect(takings.transactions.map((t) => t.description)).toEqual([
    "Job in Barnsley",
  ]);
  expect(takings.totals.outCents).toBe(0);
});
