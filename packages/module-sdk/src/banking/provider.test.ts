import { expect, test } from "bun:test";
import {
  BANK_SYNC_MAX_PAGES,
  type BankTransactionInfo,
  type BankTransactionPage,
  syncAllTransactions,
} from "./provider";

const credentials = { clientId: "client", secret: "secret", test: true };

const line = (reference: string): BankTransactionInfo => ({
  reference,
  accountReference: "acc",
  amountCents: -500,
  currency: "USD",
  description: reference,
  postedAt: new Date("2026-10-01T00:00:00Z"),
  pending: false,
  category: null,
});

/** A provider that has three pages waiting, and remembers what it was asked. */
function threePages() {
  const asked: (string | null)[] = [];
  const pages: Record<string, BankTransactionPage> = {
    start: {
      transactions: [line("a"), line("b")],
      cursor: "c1",
      removed: [],
      hasMore: true,
    },
    c1: {
      transactions: [line("c")],
      cursor: "c2",
      removed: ["b", "old"],
      hasMore: true,
    },
    c2: {
      transactions: [line("d"), line("old")],
      cursor: "c3",
      removed: [],
      hasMore: false,
    },
  };
  return {
    asked,
    provider: {
      async syncTransactions(_c: unknown, _t: string, cursor: string | null) {
        asked.push(cursor);
        const page = pages[cursor ?? "start"];
        if (!page) throw new Error(`no page after ${cursor}`);
        return page;
      },
    },
  };
}

/**
 * One page a run was one page a night: a long history arrived over weeks, and
 * whatever the provider expired first was never read at all.
 */
test("a sync reads every page the provider has, in one run", async () => {
  const { provider, asked } = threePages();
  const page = await syncAllTransactions(provider, credentials, "token", null);
  expect(asked).toEqual([null, "c1", "c2"]);
  expect(page.transactions.map((row) => row.reference)).toEqual([
    "a",
    "c",
    "d",
    "old",
  ]);
  // b was added then removed; old was removed then added back.
  expect(page.removed).toEqual(["b"]);
  expect(page.cursor).toBe("c3");
  expect(page.hasMore).toBe(false);
});

test("the page cap stops a run and says there is more", async () => {
  expect(BANK_SYNC_MAX_PAGES).toBeGreaterThan(1);
  const { provider, asked } = threePages();
  const page = await syncAllTransactions(
    provider,
    credentials,
    "token",
    null,
    2,
  );
  expect(asked).toEqual([null, "c1"]);
  // The cursor is the last page read, so the next run carries on from there.
  expect(page.cursor).toBe("c2");
  expect(page.hasMore).toBe(true);
});

test("a cursor that does not move is not asked for again", async () => {
  let calls = 0;
  const page = await syncAllTransactions(
    {
      async syncTransactions() {
        calls += 1;
        return { transactions: [], cursor: "same", removed: [], hasMore: true };
      },
    },
    credentials,
    "token",
    "same",
  );
  expect(calls).toBe(1);
  expect(page.hasMore).toBe(false);
});

test("a failed page keeps nothing, so the next run starts where this one did", async () => {
  const { provider } = threePages();
  await expect(
    syncAllTransactions(provider, credentials, "token", "c2-broken"),
  ).rejects.toThrow("no page after c2-broken");
});
