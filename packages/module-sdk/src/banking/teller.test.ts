import { afterEach, expect, test } from "bun:test";
import type { BankCredentials } from "./provider";
import { teller } from "./teller";

/**
 * The second provider, and the places it differs from the first.
 *
 * Its amounts already read the way this product does, its balances arrive as
 * strings, and it pages backwards from the newest transaction rather than
 * issuing a cursor — so "where did I get to" is a transaction id, and a sync
 * has to stop when it reaches one it has seen.
 */
const CREDENTIALS: BankCredentials = {
  clientId: "app-1",
  secret: "cert",
  test: true,
};

const realFetch = globalThis.fetch;

function stub(reply: (path: string) => unknown) {
  process.env.TELLER_API_BASE = "https://teller.test";
  globalThis.fetch = (async (url: string | URL | Request) =>
    new Response(JSON.stringify(reply(new URL(String(url)).pathname)), {
      status: 200,
    })) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.TELLER_API_BASE = undefined;
});

test("balances arrive as strings and are stored as cents", async () => {
  stub((path) =>
    path.endsWith("/balances")
      ? { available: "1234.56", ledger: "1300.00" }
      : [
          {
            id: "a1",
            name: "Business current",
            last_four: "6789",
            subtype: "checking",
            currency: "USD",
          },
        ],
  );

  const [account] = await teller.listAccounts(CREDENTIALS, "token-1");
  expect(account?.balanceCents).toBe(123_456);
  expect(account?.last4).toBe("6789");
});

/**
 * A sync stops at the last transaction it saw.
 *
 * Without that it re-reads the whole history every time, and every row already
 * reconciled comes back as new.
 */
test("a sync stops where the last one finished", async () => {
  stub((path) =>
    path.includes("/transactions")
      ? [
          {
            id: "t3",
            amount: "-10.00",
            description: "New",
            date: "2026-09-03",
            status: "posted",
          },
          {
            id: "t2",
            amount: "-20.00",
            description: "Also new",
            date: "2026-09-02",
            status: "posted",
          },
          {
            id: "t1",
            amount: "-30.00",
            description: "Already seen",
            date: "2026-09-01",
            status: "posted",
          },
        ]
      : [{ id: "a1", name: "Current", currency: "USD" }],
  );

  const page = await teller.syncTransactions(CREDENTIALS, "token-1", "t1");
  expect(page.transactions.map((t) => t.reference)).toEqual(["t3", "t2"]);
  // And the next sync carries on from the newest it just saw.
  expect(JSON.parse(page.cursor ?? "")).toEqual({ a1: { seen: "t3" } });
});

test("its amounts already read the way this product does", async () => {
  stub((path) =>
    path.includes("/transactions")
      ? [
          {
            id: "t1",
            amount: "-42.50",
            description: "ISP",
            date: "2026-09-01",
            status: "posted",
          },
        ]
      : [{ id: "a1", name: "Current", currency: "USD" }],
  );

  const page = await teller.syncTransactions(CREDENTIALS, "token-1", null);
  // Money out is already negative: no sign flip, unlike the other provider.
  expect(page.transactions[0]?.amountCents).toBe(-4_250);
});

/**
 * What it cannot do is said before anybody chooses it.
 *
 * A business in Canada picking this would find out at the moment it tried to
 * connect a bank, and one paying a monthly supplier would find out later still
 * — which is why the screen asks the provider rather than assuming.
 */
test("it says plainly what it cannot do", () => {
  const can = teller.capabilities();
  expect(can.countries).toEqual(["US"]);
  expect(can.recurringPayments).toBe(false);
  expect(can.onboarding).toMatch(/United States/);
  // And the contract leaves the method off rather than throwing at the till.
  expect(teller.payRepeatedly).toBeUndefined();
});

test("the other provider can do the things this one cannot", async () => {
  const { plaid } = await import("./plaid");
  const can = plaid.capabilities();
  expect(can.recurringPayments).toBe(true);
  expect(can.countries).toContain("GB");
  expect(typeof plaid.payRepeatedly).toBe("function");
});

/** A fake provider: `count` rows per account, newest first, honouring from_id. */
function history(ids: Record<string, string[]>) {
  const asked: string[] = [];
  process.env.TELLER_API_BASE = "https://teller.test";
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    asked.push(`${url.pathname}${url.search}`);
    const account = url.pathname.split("/")[2];
    if (!url.pathname.endsWith("/transactions")) {
      return Response.json(
        Object.keys(ids).map((id) => ({ id, name: id, currency: "USD" })),
      );
    }
    const all = ids[account ?? ""] ?? [];
    const from = url.searchParams.get("from_id");
    const start = from ? all.indexOf(from) + 1 : 0;
    const count = Number(url.searchParams.get("count"));
    return Response.json(
      all.slice(start, start + count).map((id) => ({
        id,
        amount: "-1.00",
        description: id,
        date: "2026-09-01",
        status: "posted",
      })),
    );
  }) as typeof fetch;
  return asked;
}

const ids = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}${n - i}`);

/**
 * Five hundred and no more was the newest five hundred for good: nothing
 * older was ever asked for, so a connected account's history stopped there.
 */
test("history older than one page is read a page at a time", async () => {
  const asked = history({ a1: ids("t", 1_200) });
  const first = await teller.syncTransactions(CREDENTIALS, "token-1", null);
  expect(first.transactions).toHaveLength(500);
  expect(first.hasMore).toBe(true);

  const second = await teller.syncTransactions(
    CREDENTIALS,
    "token-1",
    first.cursor,
  );
  expect(second.transactions[0]?.reference).toBe("t700");
  expect(second.hasMore).toBe(true);

  const third = await teller.syncTransactions(
    CREDENTIALS,
    "token-1",
    second.cursor,
  );
  expect(third.transactions).toHaveLength(200);
  expect(third.transactions.at(-1)?.reference).toBe("t1");
  expect(third.hasMore).toBe(false);
  expect(asked.filter((a) => a.includes("from_id"))).toEqual([
    "/accounts/a1/transactions?count=500&from_id=t701",
    "/accounts/a1/transactions?count=500&from_id=t201",
  ]);

  // Once the history is in, the next pass stops at the newest it saw.
  history({ a1: ["t1202", "t1201", ...ids("t", 1_200)] });
  const later = await teller.syncTransactions(
    CREDENTIALS,
    "token-1",
    third.cursor,
  );
  expect(later.transactions.map((t) => t.reference)).toEqual([
    "t1202",
    "t1201",
  ]);
  expect(later.hasMore).toBe(false);
});

test("the shared sync reads the whole history in one run", async () => {
  history({ a1: ids("t", 1_200), a2: ids("u", 30) });
  const { syncAllTransactions } = await import("./provider");
  const page = await syncAllTransactions(teller, CREDENTIALS, "token-1", null);
  expect(page.transactions).toHaveLength(1_230);
  expect(new Set(page.transactions.map((t) => t.reference)).size).toBe(1_230);
  expect(page.hasMore).toBe(false);
});

/** Each account stops at its own newest, not the first account's. */
test("a second account stops where it finished, too", async () => {
  history({ a1: ["t2", "t1"], a2: ["u2", "u1"] });
  const first = await teller.syncTransactions(CREDENTIALS, "token-1", null);
  history({ a1: ["t3", "t2", "t1"], a2: ["u3", "u2", "u1"] });
  const next = await teller.syncTransactions(
    CREDENTIALS,
    "token-1",
    first.cursor,
  );
  expect(next.transactions.map((t) => t.reference)).toEqual(["t3", "u3"]);
});
