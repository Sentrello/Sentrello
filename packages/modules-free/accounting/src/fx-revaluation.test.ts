import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import { CORE_ACCOUNTS } from "@sentrello/db/ledger";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import accounting from "./index";

/**
 * The unrealised half of multi-currency.
 *
 * Settlement gain and loss has always existed; this is the other one — an open
 * euro balance at a period end is worth something different from what it was
 * worth when it was raised, and until now the books said nothing about it.
 *
 * Three things are held here and they are the three that can go wrong: a rise
 * posts as a gain, a fall posts as a loss, and both reverse into the next
 * period so nothing compounds and the eventual settlement still clears the
 * debt at the rate it was raised at.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const email = `fx-${suffix}@example.test`;
const app = new Hono<SentrelloEnv>();

let orgId: string;
let headers: Headers;

const EUR = "EUR";
/** Raised when a euro was worth 1.10 of the books' own currency. */
const RAISED_AT = 1_100_000;

beforeAll(async () => {
  accounting.register({
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
    body: { name: `FX ${suffix}`, slug: `fx-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  // €1,000 raised on 15 January at 1.10, so the books hold it at 1,100.00.
  await db.insert(schema.invoices).values({
    organizationId: orgId,
    number: `FX-INV-${suffix}`,
    status: "open",
    currency: EUR,
    rateMicro: RAISED_AT,
    issueDate: new Date("2026-01-15T00:00:00.000Z"),
    subtotalCents: 100_000,
    totalCents: 100_000,
  });

  // A €500 bill on the same terms: owed, not yet paid, recorded at 1.10.
  await db.insert(schema.bills).values({
    organizationId: orgId,
    number: `FX-BILL-${suffix}`,
    status: "open",
    currency: EUR,
    rateMicro: RAISED_AT,
    billDate: new Date("2026-01-20T00:00:00.000Z"),
    subtotalCents: 50_000,
    totalCents: 50_000,
  });

  // What a euro was worth at each of the two period ends this file closes.
  await db.insert(schema.exchangeRates).values([
    // 31 March: the euro has risen to 1.20.
    {
      organizationId: orgId,
      code: EUR,
      rateMicro: 1_200_000,
      asOf: new Date("2026-03-31T00:00:00.000Z"),
    },
    // 30 June: it has fallen to 1.00, below where it started.
    {
      organizationId: orgId,
      code: EUR,
      rateMicro: 1_000_000,
      asOf: new Date("2026-06-30T00:00:00.000Z"),
    },
  ]);
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
    [schema.invoices, schema.invoices.organizationId],
    [schema.bills, schema.bills.organizationId],
    [schema.exchangeRates, schema.exchangeRates.organizationId],
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

/** The entry's lines, keyed by the account code they landed on. */
async function linesOf(entryId: string) {
  const rows = await db
    .select({
      code: schema.accounts.code,
      debitCents: schema.journalLines.debitCents,
      creditCents: schema.journalLines.creditCents,
    })
    .from(schema.journalLines)
    .innerJoin(
      schema.accounts,
      eq(schema.accounts.id, schema.journalLines.accountId),
    )
    .where(eq(schema.journalLines.entryId, entryId));
  return rows;
}

test("a euro balance that has risen posts an unrealised gain, and reverses", async () => {
  const res = await app.request(
    "http://localhost/api/accounting/fx-revaluation",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ asOf: "2026-03-31" }),
    },
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    receivableCents: number;
    payableCents: number;
    posted: { id: string; postedAt: string };
    reversal: { id: string; postedAt: string };
    lines: { kind: string; carryingCents: number; revaluedCents: number }[];
  };

  /*
   * €1,000 held at 1.10 is 1,100.00; at 1.20 it is 1,200.00. The customer
   * still owes €1,000 — nothing about the debt changed — but what it is worth
   * to this business went up by 100.00, and that is the sentence the balance
   * sheet was not making.
   */
  expect(body.receivableCents).toBe(10_000);
  // €500 owed the other way: the debt got 50.00 more expensive, which is a
  // loss, and the sign is the only thing that differs between the two sides.
  expect(body.payableCents).toBe(5_000);

  const receivable = body.lines.find((l) => l.kind === "receivable");
  expect(receivable?.carryingCents).toBe(110_000);
  expect(receivable?.revaluedCents).toBe(120_000);

  const posted = await linesOf(body.posted.id);
  // The asset is worth more: debit receivable, credit exchange.
  expect(
    posted.find((l) => l.code === CORE_ACCOUNTS.accountsReceivable.code),
  ).toMatchObject({ debitCents: 10_000, creditCents: 0 });
  // The liability is worth more: credit payable, debit exchange.
  expect(
    posted.find((l) => l.code === CORE_ACCOUNTS.accountsPayable.code),
  ).toMatchObject({ debitCents: 0, creditCents: 5_000 });
  // Exchange nets to the 50.00 gain the two sides leave between them.
  const exchange = posted.filter((l) => l.code === CORE_ACCOUNTS.exchange.code);
  expect(
    exchange.reduce((sum, l) => sum + l.creditCents - l.debitCents, 0),
  ).toBe(5_000);
  // Balanced, which `postJournalEntry` would have refused otherwise — and is
  // worth asserting here because the four-line shape is built by hand.
  expect(posted.reduce((sum, l) => sum + l.debitCents, 0)).toBe(
    posted.reduce((sum, l) => sum + l.creditCents, 0),
  );

  /*
   * And it comes straight back out on the first day of the next period.
   *
   * Without this the invoice would be carried at neither the rate it was
   * raised at nor any rate it will be settled at, and the payment entry —
   * which clears receivable at the issued rate, because that is the only rate
   * that makes the debt leave the balance sheet — would strand the difference
   * for ever.
   */
  const reversal = await linesOf(body.reversal.id);
  expect(
    reversal.find((l) => l.code === CORE_ACCOUNTS.accountsReceivable.code),
  ).toMatchObject({ debitCents: 0, creditCents: 10_000 });
  expect(
    reversal.find((l) => l.code === CORE_ACCOUNTS.accountsPayable.code),
  ).toMatchObject({ debitCents: 5_000, creditCents: 0 });
  expect(new Date(body.reversal.postedAt).getTime()).toBe(
    new Date(body.posted.postedAt).getTime() + 1,
  );
});

test("the same period end cannot be revalued twice", async () => {
  const res = await app.request(
    "http://localhost/api/accounting/fx-revaluation",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ asOf: "2026-03-31" }),
    },
  );
  expect(res.status).toBe(409);
});

test("a euro balance that has fallen posts an unrealised loss", async () => {
  const res = await app.request(
    "http://localhost/api/accounting/fx-revaluation",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ asOf: "2026-06-30" }),
    },
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    receivableCents: number;
    payableCents: number;
    posted: { id: string };
  };

  /*
   * Measured from the rate the documents were raised at, not from March's
   * revaluation — because March's was reversed on 1 April. €1,000 at 1.00 is
   * 1,000.00 against a carrying 1,100.00, so 100.00 of the asset has gone.
   */
  expect(body.receivableCents).toBe(-10_000);
  expect(body.payableCents).toBe(-5_000);

  const posted = await linesOf(body.posted.id);
  expect(
    posted.find((l) => l.code === CORE_ACCOUNTS.accountsReceivable.code),
  ).toMatchObject({ debitCents: 0, creditCents: 10_000 });
  expect(
    posted.find((l) => l.code === CORE_ACCOUNTS.accountsPayable.code),
  ).toMatchObject({ debitCents: 5_000, creditCents: 0 });
  // Net 50.00 of loss: a debit to Exchange.
  const exchange = posted.filter((l) => l.code === CORE_ACCOUNTS.exchange.code);
  expect(
    exchange.reduce((sum, l) => sum + l.debitCents - l.creditCents, 0),
  ).toBe(5_000);
});

test("a currency with no rate on or before the date is refused, not guessed", async () => {
  const res = await app.request(
    "http://localhost/api/accounting/fx-revaluation",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ asOf: "2026-01-31" }),
    },
  );
  // The first rate this business recorded is dated 31 March, so January has
  // nothing to revalue at. Posting at 1:1 would be a plausible wrong number.
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("EUR");
});
