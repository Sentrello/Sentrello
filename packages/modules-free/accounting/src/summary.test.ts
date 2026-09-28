import { afterAll, beforeAll, expect, test } from "bun:test";
import { db, eq, schema } from "@sentrello/db";
import {
  CORE_ACCOUNTS,
  ensureAccount,
  postJournalEntry,
} from "@sentrello/db/ledger";
import { dropOrganization, makeOrganization } from "@sentrello/db/testing";
import { accountingFigures } from "./summary";

/**
 * The books panel, and the table it must not read.
 *
 * It read `transactions` — the register behind "Money in and out" — which is
 * one of the things that feed the books and not the books. An invoice posts
 * its income to the journal and never touches that table, so a business
 * that bills for what it does saw "Taken this month: $0.00" in a month it
 * had been paid. The panel was called The books and was the one screen here
 * not reading them.
 *
 * Money recorded against no account stays with the register, because that is
 * where it happens: every screen still adds up, the totals are simply in the
 * wrong places, and the profit and loss quietly stops being true. Nobody
 * discovers that by looking at a report, because the report looks fine.
 */
const orgId = `org-books-${crypto.randomUUID().slice(0, 8)}`;
const now = new Date();
const thisMonth = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15, 12),
);
const lastYear = new Date(
  Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 15, 12),
);

const figure = (
  fs: Awaited<ReturnType<typeof accountingFigures>>,
  l: string,
) => {
  const found = fs.find((f) => f.label === l);
  if (!found) throw new Error(`no figure ${l}`);
  return found;
};

beforeAll(async () => {
  // The books belong to a business that exists; the foreign key on every
  // business table has said so since 2026-09-27.
  await makeOrganization(orgId);
});

afterAll(async () => {
  await dropOrganization(orgId);
});

test("an empty business reads as zero rather than as nothing", async () => {
  expect((await accountingFigures(orgId)).map((f) => f.value)).toEqual([
    0, 0, 0,
  ]);
});

test("this month is this month, and last year is not in it", async () => {
  const cash = await ensureAccount(orgId, CORE_ACCOUNTS.cash);
  const sales = await ensureAccount(orgId, CORE_ACCOUNTS.salesIncome);
  const cost = await ensureAccount(orgId, CORE_ACCOUNTS.generalExpense);

  await postJournalEntry(
    orgId,
    "Earned",
    `test:books-${orgId}-in`,
    [
      { accountId: cash, debitCents: 120_000 },
      { accountId: sales, creditCents: 120_000 },
    ],
    thisMonth,
  );
  await postJournalEntry(
    orgId,
    "Spent",
    `test:books-${orgId}-out`,
    [
      { accountId: cost, debitCents: 45_000 },
      { accountId: cash, creditCents: 45_000 },
    ],
    thisMonth,
  );
  await postJournalEntry(
    orgId,
    "Earned, long ago",
    `test:books-${orgId}-old`,
    [
      { accountId: cash, debitCents: 999_999 },
      { accountId: sales, creditCents: 999_999 },
    ],
    lastYear,
  );

  const figures = await accountingFigures(orgId);
  expect(figure(figures, "Income this month").value).toBe(120_000);
  expect(figure(figures, "Expenses this month").value).toBe(45_000);
  expect(figure(figures, "Income this month").kind).toBe("money");
});

/**
 * The defect this panel was shipped with, spelled out.
 *
 * A business that raises invoices and never opens "Money in and out" has an
 * empty `transactions` table and a full journal. Reading the register, the
 * panel said nothing had come in all month.
 */
test("income that never went through the register is still income", async () => {
  const solo = await makeOrganization(
    `org-invoiced-${crypto.randomUUID().slice(0, 8)}`,
  );
  try {
    const cash = await ensureAccount(solo, CORE_ACCOUNTS.cash);
    const sales = await ensureAccount(solo, CORE_ACCOUNTS.salesIncome);
    await postJournalEntry(
      solo,
      "An invoice, issued",
      `test:books-${solo}-invoice`,
      [
        { accountId: cash, debitCents: 60_000 },
        { accountId: sales, creditCents: 60_000 },
      ],
      thisMonth,
    );

    const rows = await db
      .select({ id: schema.transactions.id })
      .from(schema.transactions)
      .where(eq(schema.transactions.organizationId, solo));
    expect(
      rows.length,
      "the register must be empty for this to mean anything",
    ).toBe(0);

    const figures = await accountingFigures(solo);
    expect(figure(figures, "Income this month").value).toBe(60_000);
  } finally {
    await dropOrganization(solo);
  }
});

/**
 * Uncategorised money is counted whenever it happened, not only this month.
 * A figure from March that nobody filed is still wrong in November.
 */
test("money against no account asks to be filed, whenever it happened", async () => {
  await db.insert(schema.transactions).values({
    organizationId: orgId,
    kind: "expense",
    amountCents: 8_000,
    occurredAt: lastYear,
    accountId: null,
  });
  const unfiled = figure(await accountingFigures(orgId), "Without a category");
  expect(unfiled.value).toBe(1);
  expect(unfiled.tone).toBe("bad");
});

test("one business's books are not another's", async () => {
  const fresh = `org-fresh-${crypto.randomUUID().slice(0, 8)}`;
  expect((await accountingFigures(fresh)).map((f) => f.value)).toEqual([
    0, 0, 0,
  ]);
});
