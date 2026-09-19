import { afterAll, expect, test } from "bun:test";
import { db, eq, schema } from "@sentrello/db";
import { accountingFigures } from "./summary";

/**
 * The books panel, and what it must not do.
 *
 * Money recorded against no account is the figure worth having here: every
 * screen still adds up, the totals are simply in the wrong places, and the
 * profit and loss quietly stops being true. Nobody discovers that by
 * looking at a report, because the report looks fine.
 */
const orgId = `org-books-${crypto.randomUUID().slice(0, 8)}`;
const now = new Date();
const thisMonth = new Date(now.getFullYear(), now.getMonth(), 15);
const lastYear = new Date(now.getFullYear() - 1, now.getMonth(), 15);

const figure = (
  fs: Awaited<ReturnType<typeof accountingFigures>>,
  l: string,
) => {
  const found = fs.find((f) => f.label === l);
  if (!found) throw new Error(`no figure ${l}`);
  return found;
};

afterAll(async () => {
  await db
    .delete(schema.transactions)
    .where(eq(schema.transactions.organizationId, orgId));
});

test("an empty business reads as zero rather than as nothing", async () => {
  expect((await accountingFigures(orgId)).map((f) => f.value)).toEqual([
    0, 0, 0,
  ]);
});

test("this month is this month, and last year is not in it", async () => {
  await db.insert(schema.transactions).values([
    {
      organizationId: orgId,
      kind: "income",
      amountCents: 120_000,
      occurredAt: thisMonth,
      accountId: crypto.randomUUID(),
    },
    {
      organizationId: orgId,
      kind: "expense",
      amountCents: 45_000,
      occurredAt: thisMonth,
      accountId: crypto.randomUUID(),
    },
    {
      organizationId: orgId,
      kind: "income",
      amountCents: 999_999,
      occurredAt: lastYear,
      accountId: crypto.randomUUID(),
    },
  ]);
  const figures = await accountingFigures(orgId);
  expect(figure(figures, "Taken this month").value).toBe(120_000);
  expect(figure(figures, "Spent this month").value).toBe(45_000);
  expect(figure(figures, "Taken this month").kind).toBe("money");
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
