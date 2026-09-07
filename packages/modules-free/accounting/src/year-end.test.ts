import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { and, db, eq, schema } from "@sentrello/db";
import { registerForTest } from "@sentrello/module-sdk";
import accounting from "./index";

/**
 * Drawing a line under a year.
 *
 * Without this, "retained earnings" is a subtraction done on the spot — every
 * penny the business has ever made, recomputed on every request — and nothing
 * in the books ever says a year is finished. Closing it posts one entry that
 * empties every income and expense account into equity, so the new year starts
 * at zero because its accounts do.
 *
 * Three things have to hold or the balance sheet stops meaning anything: the
 * entry balances, the year is emptied exactly once, and closing a second year
 * does not sweep the first year's profit into equity twice.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const app = registerForTest(accounting);

let headers: Headers;
let orgId: string;
let sales = "";
let fuel = "";
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

/** Money earned or spent on a date, straight through the ledger. */
async function movement(
  at: string,
  income: number,
  expense: number,
): Promise<void> {
  if (income > 0) {
    await post("/api/journal/entries", {
      memo: "Sales",
      postedAt: at,
      lines: [
        { accountId: cash, debitCents: income },
        { accountId: sales, creditCents: income },
      ],
    });
  }
  if (expense > 0) {
    await post("/api/journal/entries", {
      memo: "Fuel",
      postedAt: at,
      lines: [
        { accountId: fuel, debitCents: expense },
        { accountId: cash, creditCents: expense },
      ],
    });
  }
}

async function balanceOf(accountId: string) {
  const rows = await db
    .select()
    .from(schema.journalLines)
    .innerJoin(
      schema.journalEntries,
      eq(schema.journalEntries.id, schema.journalLines.entryId),
    )
    .where(eq(schema.journalEntries.organizationId, orgId));
  return rows
    .filter((row) => row.journal_lines.accountId === accountId)
    .reduce(
      (sum, row) =>
        sum + row.journal_lines.debitCents - row.journal_lines.creditCents,
      0,
    );
}

async function retainedAccount() {
  const [row] = await db
    .select()
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.organizationId, orgId),
        eq(schema.accounts.code, "3200"),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

async function unlock() {
  await db
    .update(schema.ledgerSettings)
    .set({ closedThrough: null })
    .where(eq(schema.ledgerSettings.organizationId, orgId));
}

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email: `yearend-${suffix}@x.test`,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `YearEnd ${suffix}`, slug: `yearend-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  cash = await account("1000", "Cash", "asset");
  sales = await account("4000", "Sales", "income");
  fuel = await account("6100", "Fuel", "expense");
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
    schema.journalEntries,
    schema.accounts,
    schema.ledgerSettings,
    schema.securityEvents,
  ]) {
    await db.delete(t).where(eq(t.organizationId, orgId));
  }
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
});

/**
 * The whole of it: the year is emptied and equity holds what it made.
 *
 * A new year that starts anywhere but zero is a profit and loss that has to be
 * read by subtracting last year's, which is the thing this removes.
 */
test("closing a year empties income and expenses into equity", async () => {
  await movement("2025-06-01T00:00:00Z", 10_000, 4_000);

  const preview = await post("/api/year-end/preview", {
    endsOn: "2025-12-31",
  });
  expect(preview.status).toBe(200);
  const planned = (await preview.json()) as { retainedCents: number };
  expect(planned.retainedCents).toBe(6_000);

  const closed = await post("/api/year-end/close", { endsOn: "2025-12-31" });
  expect(closed.status).toBe(201);
  const done = (await closed.json()) as { retainedCents: number };
  // The preview and the close read one function; they cannot disagree.
  expect(done.retainedCents).toBe(planned.retainedCents);

  expect(await balanceOf(sales)).toBe(0);
  expect(await balanceOf(fuel)).toBe(0);
  const retained = await retainedAccount();
  if (!retained) throw new Error("no retained earnings account");
  // Equity is a credit balance, so a profit reads negative in debit terms.
  expect(await balanceOf(retained)).toBe(-6_000);
  // And the cash is untouched: closing moves nothing the business owns.
  expect(await balanceOf(cash)).toBe(6_000);

  await unlock();
});

/**
 * A second year takes its own profit, not the first year's again.
 *
 * The commonest way to get this wrong, and it doubles equity while leaving the
 * balance sheet balanced — nothing downstream can catch it.
 */
test("closing a second year does not sweep the first year again", async () => {
  await movement("2026-03-01T00:00:00Z", 5_000, 1_000);

  const closed = await post("/api/year-end/close", { endsOn: "2026-12-31" });
  expect(closed.status).toBe(201);
  expect(
    ((await closed.json()) as { retainedCents: number }).retainedCents,
  ).toBe(4_000);

  const retained = await retainedAccount();
  if (!retained) throw new Error("no retained earnings account");
  // Six from the first year and four from the second, not sixteen.
  expect(await balanceOf(retained)).toBe(-10_000);

  await unlock();
});

test("a year cannot be closed twice", async () => {
  const again = await post("/api/year-end/close", { endsOn: "2026-12-31" });
  // Twice empties accounts that are already empty and doubles what equity
  // says the business has kept.
  expect(again.status).toBe(409);
  await unlock();
});

/**
 * Two different refusals, said apart.
 *
 * A year already closed answers that it is closed. A year *earlier* than the
 * last close is a different mistake and says so — telling somebody their 2024
 * is "already closed" when it never was sends them looking for an entry that
 * does not exist.
 */
test("a year already closed says so, and an earlier one says something else", async () => {
  const again = await post("/api/year-end/close", { endsOn: "2025-12-31" });
  expect(again.status).toBe(409);
  expect(((await again.json()) as { error: string }).error).toContain(
    "already closed",
  );

  const earlier = await post("/api/year-end/close", { endsOn: "2024-12-31" });
  expect(earlier.status).toBe(400);
  expect(((await earlier.json()) as { error: string }).error).toContain(
    "before the last one",
  );
  await unlock();
});

/**
 * The books balance afterwards.
 *
 * The one property that must survive every closing entry: the entry is
 * balanced, so the balance sheet still is.
 */
test("the closing entry balances", async () => {
  const entries = await db
    .select()
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));
  for (const entry of entries.filter((e) =>
    (e.source ?? "").startsWith("year-end"),
  )) {
    const lines = await db
      .select()
      .from(schema.journalLines)
      .where(eq(schema.journalLines.entryId, entry.id));
    const debits = lines.reduce((n, l) => n + l.debitCents, 0);
    const credits = lines.reduce((n, l) => n + l.creditCents, 0);
    expect(debits).toBe(credits);
    expect(debits).toBeGreaterThan(0);
  }
});

/**
 * A closed year is locked, or its accounts quietly refill.
 *
 * The closing entry emptied them; a month still open to posting fills them
 * again, and the balance sheet that was signed stops agreeing with the books.
 */
test("closing a year locks it", async () => {
  await movement("2027-02-01T00:00:00Z", 2_000, 500);
  const closed = await post("/api/year-end/close", { endsOn: "2027-12-31" });
  expect(closed.status).toBe(201);

  const [settings] = await db
    .select()
    .from(schema.ledgerSettings)
    .where(eq(schema.ledgerSettings.organizationId, orgId))
    .limit(1);
  expect(settings?.closedThrough?.toISOString().slice(0, 10)).toBe(
    "2027-12-31",
  );

  // And posting into it is refused by the lock that already existed.
  const refused = await post("/api/journal/entries", {
    memo: "Too late",
    postedAt: "2027-06-01T00:00:00Z",
    lines: [
      { accountId: fuel, debitCents: 100 },
      { accountId: cash, creditCents: 100 },
    ],
  });
  expect(refused.status).toBe(409);
});

/**
 * And reopening it, by reversal.
 *
 * An accountant coming back with a change is ordinary. Deleting the closing
 * entry would leave a balance sheet that had been printed and signed
 * disagreeing with the books it came from and nothing to explain it.
 */
test("a year can be reopened, and the reversal puts everything back", async () => {
  const retained = await retainedAccount();
  if (!retained) throw new Error("no retained earnings account");
  const before = await balanceOf(retained);

  const reopened = await post("/api/year-end/reopen", { endsOn: "2027-12-31" });
  expect(reopened.status).toBe(200);

  // The year's figures are back where they were.
  expect(await balanceOf(sales)).toBe(-2_000);
  expect(await balanceOf(fuel)).toBe(500);
  expect(await balanceOf(retained)).toBe(before + 1_500);

  // The lock is off, or the reversal could never have been posted and the
  // year could be closed once and never reopened.
  const [settings] = await db
    .select()
    .from(schema.ledgerSettings)
    .where(eq(schema.ledgerSettings.organizationId, orgId))
    .limit(1);
  expect(settings?.closedThrough).toBeNull();

  // The original close is still in the books beside its reversal.
  const closes = await db
    .select()
    .from(schema.journalEntries)
    .where(
      and(
        eq(schema.journalEntries.organizationId, orgId),
        eq(schema.journalEntries.source, "year-end:2027-12-31"),
      ),
    );
  expect(closes).toHaveLength(1);
});

test("a reopened year can be closed again", async () => {
  const res = await post("/api/year-end/close", { endsOn: "2027-12-31" });
  expect(res.status).toBe(201);
  expect(((await res.json()) as { retainedCents: number }).retainedCents).toBe(
    1_500,
  );
  await unlock();
});

test("reopening a year that was never closed says so", async () => {
  const res = await post("/api/year-end/reopen", { endsOn: "2019-12-31" });
  expect(res.status).toBe(404);
});

test("a year with nothing in it is not closed", async () => {
  const res = await post("/api/year-end/close", { endsOn: "2028-12-31" });
  // An entry full of nothing is noise in the journal for ever.
  expect(res.status).toBe(400);
  await unlock();
});

test("a date that is not a date is refused", async () => {
  expect(
    (await post("/api/year-end/close", { endsOn: "last Tuesday" })).status,
  ).toBe(400);
});

test("closing and reopening are written into the log", async () => {
  const events = await db
    .select()
    .from(schema.securityEvents)
    .where(eq(schema.securityEvents.organizationId, orgId));
  const actions = events.map((e) => e.action);
  expect(actions).toContain("year.closed");
  expect(actions).toContain("year.reopened");
});
