import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import {
  CORE_ACCOUNTS,
  ensureAccount,
  postJournalEntry,
} from "@sentrello/db/ledger";
import { eq } from "@sentrello/db/orm";
import { readInsights } from "@sentrello/module-dashboard/insights";
import { booksByMonth } from "@sentrello/module-money/books";

/**
 * Two screens, one click apart, must say the same thing about a month.
 *
 * The platform dashboard draws income and profit by month; Money's front page
 * draws income against expenses. Both read the journal, and both work the
 * months out for themselves — the dashboard over twelve, in one pass over
 * every line; Money over six, as six grouped aggregates. Two implementations
 * of one idea is a disagreement waiting for the month somebody notices.
 *
 * They were nearly out of step the day the second one was written: the
 * dashboard buckets by UTC month and the newer one was using the server's
 * local month, so a host an hour west of Greenwich would have put an entry
 * posted late on the 31st into a different month on each screen. Nothing
 * would have failed. A figure would simply have been different depending on
 * which page you were looking at.
 *
 * So this posts real entries — including one in the small hours of the 1st,
 * which is where the two bucketings part company — and holds the answers
 * together. **It cannot catch the timezone half of that on its own**: this
 * runner is UTC, where a local month and a UTC month are the same month. The
 * half it cannot see is caught in `books.test.ts`, by reading the source for
 * a local-time accessor. What this one catches is the likelier regression —
 * somebody totting up a month a third way.
 */
const suffix = crypto.randomUUID().slice(0, 8);
let orgId: string;
let cashId: string;
let salesId: string;
let expenseId: string;

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email: `books-agree-${suffix}@example.test`,
    password: "correct-horse-battery-staple",
    name: "Books Agree",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  const headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Books Agree ${suffix}`, slug: `books-agree-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;

  cashId = await ensureAccount(orgId, CORE_ACCOUNTS.cash);
  salesId = await ensureAccount(orgId, CORE_ACCOUNTS.salesIncome);
  expenseId = await ensureAccount(orgId, CORE_ACCOUNTS.generalExpense);

  const now = new Date();
  const at = (monthsBack: number, day: number, hour: number) =>
    new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, day, hour),
    );

  const sales: [Date, number][] = [
    [at(0, 15, 12), 12_000],
    [at(1, 2, 9), 8_000],
    [at(3, 20, 17), 5_500],
    // The last evening of a month, in UTC.
    [
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 45)),
      700,
    ],
    /*
     * And the small hours of the 1st, which is the entry that tells the two
     * bucketings apart: 02:00 UTC on the 1st is 20:00 on the last day of the
     * month before it in Denver. One of these screens would have counted it
     * in September and the other in August.
     */
    [new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 2)), 1_300],
  ];
  for (const [when, cents] of sales) {
    await postJournalEntry(
      orgId,
      "A sale",
      `test:agree-${suffix}-in-${when.getTime()}`,
      [
        { accountId: cashId, debitCents: cents },
        { accountId: salesId, creditCents: cents },
      ],
      when,
    );
  }

  const costs: [Date, number][] = [
    [at(0, 6, 8), 4_500],
    [at(2, 11, 14), 2_250],
  ];
  for (const [when, cents] of costs) {
    await postJournalEntry(
      orgId,
      "A cost",
      `test:agree-${suffix}-out-${when.getTime()}`,
      [
        { accountId: expenseId, debitCents: cents },
        { accountId: cashId, creditCents: cents },
      ],
      when,
    );
  }
});

afterAll(async () => {
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
});

test("Money's six months are the dashboard's last six, to the cent", async () => {
  const [mine, insights] = await Promise.all([
    booksByMonth(orgId),
    readInsights(orgId),
  ]);

  expect(mine.length).toBe(6);
  const theirs = insights.months.slice(-6);
  expect(theirs.map((m) => m.month)).toEqual(mine.map((m) => m.month));

  for (const [i, month] of mine.entries()) {
    const other = theirs[i];
    expect(
      month.incomeCents,
      `income for ${month.month}: Money says ${month.incomeCents}, the dashboard says ${other?.incomeCents}`,
    ).toBe(other?.incomeCents ?? -1);
    expect(
      month.expenseCents,
      `expenses for ${month.month}: Money says ${month.expenseCents}, the dashboard says ${other?.expenseCents}`,
    ).toBe(other?.expenseCents ?? -1);
  }

  // And the figures are not all zero, which would pass the loop above while
  // proving nothing.
  expect(mine.some((m) => m.incomeCents > 0)).toBe(true);
  expect(mine.some((m) => m.expenseCents > 0)).toBe(true);
});
