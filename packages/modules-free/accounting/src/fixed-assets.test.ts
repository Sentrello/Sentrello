import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { and, db, eq, like, schema } from "@sentrello/db";
import { registerForTest } from "@sentrello/module-sdk";
import { depreciationSchedule, monthOf } from "./fixed-assets";
import accounting from "./index";

/**
 * A van does not cost thirty thousand pounds this year.
 *
 * It costs a slice of thirty thousand pounds every month for six years, and
 * the whole of this feature is the arithmetic of that slice: it has to add up
 * to exactly what was spent less what the thing will be worth at the end, in
 * whole pennies, however many months it is divided into. A schedule that is a
 * penny out leaves a balance sheet that never quite clears, and nobody finds
 * out until the asset is sold years later.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const app = registerForTest(accounting);

let headers: Headers;
let orgId: string;
let van = "";
let expense = "";
let accumulated = "";
let cash = "";
let gains = "";

const req = (path: string, init?: RequestInit) =>
  app.request(`http://localhost${path}`, { headers, ...init });
const post = (path: string, body: unknown) =>
  req(path, { method: "POST", body: JSON.stringify(body) });

async function account(code: string, name: string, type: string) {
  const res = await post("/api/accounts", { code, name, type });
  const { account: made } = (await res.json()) as { account: { id: string } };
  return made.id;
}

async function asset(body: Record<string, unknown> = {}) {
  const res = await post("/api/fixed-assets", {
    name: "Van",
    costCents: 3_000_000,
    salvageCents: 0,
    acquiredOn: "2026-01-10T00:00:00Z",
    lifeMonths: 60,
    assetAccountId: van,
    expenseAccountId: expense,
    accumulatedAccountId: accumulated,
    ...body,
  });
  return res;
}

/**
 * Everything one test made, taken back out.
 *
 * The assets and the entries together: leaving the entries behind makes the
 * next test's account balances the sum of every test before it, and the
 * arithmetic that is the whole point of this file stops meaning anything.
 */
async function clear() {
  const entries = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));
  for (const entry of entries) {
    await db
      .delete(schema.journalLines)
      .where(eq(schema.journalLines.entryId, entry.id));
  }
  await db
    .delete(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));
  await db
    .delete(schema.fixedAssets)
    .where(eq(schema.fixedAssets.organizationId, orgId));
}

/** Every line posted against one account, net. */
async function balanceOf(accountId: string) {
  const lines = await db
    .select()
    .from(schema.journalLines)
    .innerJoin(
      schema.journalEntries,
      eq(schema.journalEntries.id, schema.journalLines.entryId),
    )
    .where(eq(schema.journalEntries.organizationId, orgId));
  return lines
    .filter((row) => row.journal_lines.accountId === accountId)
    .reduce(
      (sum, row) =>
        sum + row.journal_lines.debitCents - row.journal_lines.creditCents,
      0,
    );
}

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email: `assets-${suffix}@x.test`,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Assets ${suffix}`, slug: `assets-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  van = await account("1500", "Vehicles", "asset");
  accumulated = await account("1590", "Accumulated depreciation", "asset");
  expense = await account("6500", "Depreciation", "expense");
  cash = await account("1000", "Cash", "asset");
  gains = await account("4900", "Gain on disposal", "income");
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
    schema.fixedAssets,
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

/**
 * The property everything else rests on.
 *
 * Swept across awkward numbers rather than checked on one: the cases that go
 * wrong are the ones that do not divide, and a single example is exactly the
 * one somebody chose because it worked.
 */
test("a schedule always adds up to the cost less the salvage", () => {
  const costs = [3_000_000, 100_001, 999, 7, 123_457];
  const lives = [1, 2, 3, 7, 12, 60, 37];
  const salvages = [0, 1, 500];

  for (const costCents of costs) {
    for (const lifeMonths of lives) {
      for (const salvageCents of salvages) {
        if (salvageCents >= costCents) continue;
        for (const method of ["straight-line", "reducing-balance"]) {
          const slices = depreciationSchedule({
            costCents,
            salvageCents,
            acquiredOn: new Date("2026-01-10T00:00:00Z"),
            method,
            lifeMonths,
            rateBp: 2_500,
          });
          const total = slices.reduce((sum, s) => sum + s.amountCents, 0);
          expect(total).toBe(costCents - salvageCents);
          // Whole pennies, and never a negative slice — a month that gives
          // money back is depreciation running past the end of the life.
          for (const slice of slices) {
            expect(Number.isInteger(slice.amountCents)).toBe(true);
            expect(slice.amountCents).toBeGreaterThan(0);
          }
        }
      }
    }
  }
});

test("straight line divides evenly and the last month carries the remainder", () => {
  const slices = depreciationSchedule({
    costCents: 1_000,
    salvageCents: 0,
    acquiredOn: new Date("2026-01-10T00:00:00Z"),
    method: "straight-line",
    lifeMonths: 3,
    rateBp: null,
  });
  expect(slices.map((s) => s.amountCents)).toEqual([333, 333, 334]);
  // The first slice belongs to the month it was bought in, not to today.
  expect(slices[0]?.month.toISOString().slice(0, 7)).toBe("2026-01");
});

test("reducing balance takes less every month and still lands exactly", () => {
  const slices = depreciationSchedule({
    costCents: 1_000_000,
    salvageCents: 100_000,
    acquiredOn: new Date("2026-01-10T00:00:00Z"),
    method: "reducing-balance",
    lifeMonths: 24,
    rateBp: 2_500,
  });
  const first = slices[0]?.amountCents ?? 0;
  const second = slices[1]?.amountCents ?? 0;
  expect(second).toBeLessThan(first);
  expect(slices.reduce((sum, s) => sum + s.amountCents, 0)).toBe(900_000);
});

/**
 * A month is posted once, whatever happens.
 *
 * The job runs monthly, somebody can press the button, and a server can
 * restart between the posting and anything that records it. Posting a month
 * twice doubles the expense and understates the asset, and the books still
 * balance while it does.
 */
test("catching up posts every month due, and never a month twice", async () => {
  const made = await asset({ costCents: 1_200, lifeMonths: 12 });
  expect(made.status).toBe(201);

  const first = await post("/api/fixed-assets/depreciate", {});
  const run = (await first.json()) as { posted: number };
  // Bought in January; every month from then to now is owed.
  expect(run.posted).toBeGreaterThan(1);

  const again = await post("/api/fixed-assets/depreciate", {});
  expect(((await again.json()) as { posted: number }).posted).toBe(0);

  const entries = await db
    .select()
    .from(schema.journalEntries)
    .where(
      and(
        eq(schema.journalEntries.organizationId, orgId),
        like(schema.journalEntries.source, "depreciation:%"),
      ),
    );
  expect(new Set(entries.map((e) => e.source)).size).toBe(entries.length);
  // And the expense equals what the contra-asset has accumulated.
  expect(await balanceOf(expense)).toBe(-(await balanceOf(accumulated)));

  await clear();
});

/**
 * A slice belongs to its own month, not to the day the job ran.
 *
 * A business that catches up in September would otherwise have eight months of
 * depreciation land in September: a profit and loss that is wrong in nine
 * periods at once, and a year-to-date figure that is right by accident.
 */
test("each slice is dated in the month it belongs to", async () => {
  await asset({ costCents: 1_200, lifeMonths: 12 });
  await post("/api/fixed-assets/depreciate", {});

  const entries = await db
    .select()
    .from(schema.journalEntries)
    .where(
      and(
        eq(schema.journalEntries.organizationId, orgId),
        like(schema.journalEntries.source, "depreciation:%"),
      ),
    );
  for (const entry of entries) {
    const month = (entry.source ?? "").split(":")[2];
    expect(entry.postedAt.toISOString().slice(0, 7)).toBe(month ?? "");
  }

  await clear();
});

/**
 * Three different accounts, or the entry says nothing at all.
 *
 * The expense and the accumulated account being the same posts a debit and a
 * credit to one account: perfectly balanced, no effect, and no depreciation
 * ever appears anywhere. Nothing downstream can catch it, because the books
 * add up.
 */
test("the three accounts have to be different", async () => {
  const res = await asset({ accumulatedAccountId: expense });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain(
    "different",
  );
});

test("an asset worth more at the end than it cost is refused", async () => {
  const res = await asset({ costCents: 1_000, salvageCents: 1_000 });
  // A schedule of nothing, which reads as a broken product rather than a
  // refusal.
  expect(res.status).toBe(400);
});

test("a reducing balance rate of 100% a year or more is refused", async () => {
  const res = await asset({ method: "reducing-balance", rateBp: 10_000 });
  expect(res.status).toBe(400);
});

test("the purchase is only posted when the business says it was not", async () => {
  const quiet = await asset({ name: "Already on a bill" });
  expect(quiet.status).toBe(201);
  expect(await balanceOf(van)).toBe(0);

  const bought = await asset({
    name: "Bought here",
    costCents: 500_000,
    paidFromAccountId: cash,
  });
  expect(bought.status).toBe(201);
  // The van on the balance sheet, the cash gone from the bank.
  expect(await balanceOf(van)).toBe(500_000);
  expect(await balanceOf(cash)).toBe(-500_000);

  await clear();
});

/**
 * Selling it has to do three things at once.
 *
 * The cost comes off, everything taken so far comes off with it, and the
 * difference between what is left and what was received is this year's gain or
 * loss. Half of it leaves an asset the business no longer owns on its balance
 * sheet forever, which is the commonest thing wrong with a small business's
 * books.
 */
test("disposal clears the asset, its depreciation, and books the difference", async () => {
  const made = await asset({
    name: "Sold van",
    costCents: 1_200,
    lifeMonths: 12,
    paidFromAccountId: cash,
  });
  const { asset: row } = (await made.json()) as { asset: { id: string } };
  await post("/api/fixed-assets/depreciate", {});

  const takenBefore = -(await balanceOf(accumulated));
  const bookValue = 1_200 - takenBefore;
  expect(takenBefore).toBeGreaterThan(0);

  const sold = await post(`/api/fixed-assets/${row.id}/dispose`, {
    proceedsCents: bookValue + 500,
    receivedIntoAccountId: cash,
    gainLossAccountId: gains,
  });
  expect(sold.status).toBe(200);
  const outcome = (await sold.json()) as {
    gainCents: number;
    lossCents: number;
    bookValueCents: number;
  };
  expect(outcome.bookValueCents).toBe(bookValue);
  expect(outcome.gainCents).toBe(500);
  expect(outcome.lossCents).toBe(0);

  // Nothing of it is left anywhere on the balance sheet.
  expect(await balanceOf(van)).toBe(0);
  expect(await balanceOf(accumulated)).toBe(0);
  // And the gain is income, not a smaller expense.
  expect(await balanceOf(gains)).toBe(-500);
});

test("an asset that has gone is not depreciated again, and not sold twice", async () => {
  const [sold] = await db
    .select()
    .from(schema.fixedAssets)
    .where(eq(schema.fixedAssets.organizationId, orgId))
    .limit(1);
  if (!sold?.disposedOn) throw new Error("expected a disposed asset");

  const again = await post(`/api/fixed-assets/${sold.id}/dispose`, {
    proceedsCents: 0,
    gainLossAccountId: gains,
  });
  expect(again.status).toBe(409);

  const before = await balanceOf(expense);
  await post("/api/fixed-assets/depreciate", {});
  expect(await balanceOf(expense)).toBe(before);
});

/**
 * Sold before anybody caught up on it.
 *
 * The disposal takes everything left on the asset in one entry, so a month
 * posted afterwards is depreciation on something the business does not own —
 * and it lands on the balance sheet as a negative asset nobody can explain.
 *
 * The earlier test could not see this: by the time it disposed of its asset
 * every month owed had already been posted, so excluding disposed assets or
 * not made no difference to what happened next.
 */
test("an asset sold before it was caught up on is not depreciated afterwards", async () => {
  await clear();
  const made = await asset({
    name: "Sold early",
    costCents: 1_200,
    lifeMonths: 12,
    acquiredOn: "2026-01-10T00:00:00Z",
  });
  const { asset: row } = (await made.json()) as { asset: { id: string } };

  // Straight from bought to gone, with eight or nine months owed on it.
  const sold = await post(`/api/fixed-assets/${row.id}/dispose`, {
    proceedsCents: 0,
    gainLossAccountId: gains,
  });
  expect(sold.status).toBe(200);

  const run = await post("/api/fixed-assets/depreciate", {});
  expect(((await run.json()) as { posted: number }).posted).toBe(0);
  expect(await balanceOf(expense)).toBe(0);

  await clear();
});

test("another business's asset cannot be disposed of", async () => {
  const res = await post(`/api/fixed-assets/${crypto.randomUUID()}/dispose`, {
    proceedsCents: 0,
    gainLossAccountId: gains,
  });
  expect(res.status).toBe(404);
});

test("a month is the month the date falls in, wherever the clock is", () => {
  // Ten to midnight on the last day of a month, in a place that is already
  // into the next one. The slice belongs to the month the ledger is keeping.
  expect(monthOf(new Date("2026-01-31T23:50:00Z")).toISOString()).toBe(
    "2026-01-01T00:00:00.000Z",
  );
});
