import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import {
  CORE_ACCOUNTS,
  ensureAccount,
  postJournalEntry,
} from "@sentrello/db/ledger";
import { eq } from "drizzle-orm";
import { booksByMonth } from "./books";

/**
 * What Money's front page says about earning and spending.
 *
 * The figure it draws is the one the Summary screen draws, because both read
 * the journal — so the test that matters is not "does it return a number" but
 * "is the number the journal's". Every case below posts real entries and then
 * asks.
 */
const suffix = crypto.randomUUID().slice(0, 8);
let orgId: string;
let cashId: string;
let salesId: string;
let expenseId: string;

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email: `money-books-${suffix}@example.test`,
    password: "correct-horse-battery-staple",
    name: "Money Books",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  const headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Money Books ${suffix}`, slug: `money-books-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;

  // Three accounts, made rather than assumed: a fresh organization has no
  // chart until somebody asks for one, and a test that depends on a seeder
  // depends on the seeder's opinions too.
  cashId = await ensureAccount(orgId, CORE_ACCOUNTS.cash);
  salesId = await ensureAccount(orgId, CORE_ACCOUNTS.salesIncome);
  expenseId = await ensureAccount(orgId, CORE_ACCOUNTS.generalExpense);
});

afterAll(async () => {
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
});

const firstOf = (monthsBack: number) => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
};

test("six months come back, oldest first, quiet ones included", async () => {
  const months = await booksByMonth(orgId);
  expect(months.length).toBe(6);
  expect([...months].sort((a, b) => a.month.localeCompare(b.month))).toEqual(
    months,
  );
  const now = new Date();
  expect(months[5]?.month).toBe(
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
  );
  // Nothing posted yet, and it says so rather than leaving the months out.
  expect(months.every((m) => m.incomeCents === 0 && m.expenseCents === 0)).toBe(
    true,
  );
});

test("income and expenses read in the direction an accountant reads them", async () => {
  // £120 earned and £45 spent, this month.
  const mid = new Date(new Date().getFullYear(), new Date().getMonth(), 15);
  await postJournalEntry(
    orgId,
    "A sale",
    `test:money-books-${suffix}-sale`,
    [
      { accountId: cashId, debitCents: 12_000 },
      { accountId: salesId, creditCents: 12_000 },
    ],
    mid,
  );
  await postJournalEntry(
    orgId,
    "A cost",
    `test:money-books-${suffix}-cost`,
    [
      { accountId: expenseId, debitCents: 4_500 },
      { accountId: cashId, creditCents: 4_500 },
    ],
    mid,
  );

  const months = await booksByMonth(orgId);
  const thisMonth = months[5];
  /*
   * Positive both times. An expense account full of debits reads as money
   * spent, not as minus money earned — getting that backwards is how a
   * profitable business appears to be losing money.
   */
  expect(thisMonth?.incomeCents).toBe(12_000);
  expect(thisMonth?.expenseCents).toBe(4_500);
});

test("a month's last day is inside that month", async () => {
  /*
   * The window ends at the first instant of the next month rather than on the
   * last day of this one. A period written as "the 30th" drops everything
   * posted on the 30th — which is the day a month's work is most likely to be
   * posted on, and the sort of off-by-one that reads as a quiet month.
   */
  const last = firstOf(1);
  const endOfLastMonth = new Date(
    last.getFullYear(),
    last.getMonth() + 1,
    0,
    23,
    30,
  );
  await postJournalEntry(
    orgId,
    "Posted on the last evening",
    `test:money-books-${suffix}-edge`,
    [
      { accountId: cashId, debitCents: 700 },
      { accountId: salesId, creditCents: 700 },
    ],
    endOfLastMonth,
  );

  const months = await booksByMonth(orgId);
  expect(months[4]?.incomeCents).toBe(700);
  // And it did not leak into the month after it.
  expect(months[5]?.incomeCents).toBe(12_000);
});
