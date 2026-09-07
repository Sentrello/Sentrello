import { afterEach, expect, test } from "bun:test";
import { plaid } from "./plaid";
import type { BankCredentials } from "./provider";

/**
 * The adapter, against a stub standing in for the provider.
 *
 * What is worth testing here is not that a fetch happened — it is the handful
 * of places where their shape and ours disagree, because each of those is a
 * figure on somebody's books:
 *
 *  - they report money leaving as a positive number and this product reads the
 *    other way round;
 *  - amounts arrive in whole units and everything here is integer cents;
 *  - a modified transaction is the same transaction, not a second one;
 *  - what a supplier sees on their statement is ten characters, silently cut.
 */
const CREDENTIALS: BankCredentials = {
  clientId: "client-1",
  secret: "secret-1",
  test: true,
};

const calls: { path: string; body: Record<string, unknown> }[] = [];
const realFetch = globalThis.fetch;

function stub(reply: (path: string) => unknown, status = 200) {
  process.env.PLAID_API_BASE = "https://plaid.test";
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify(reply(path)), { status });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.PLAID_API_BASE = undefined;
  calls.length = 0;
});

test("money leaving the account is negative here", async () => {
  stub(() => ({
    added: [
      {
        transaction_id: "t1",
        account_id: "a1",
        // Their sign: a payment out is positive.
        amount: 42.5,
        iso_currency_code: "USD",
        name: "ISP",
        merchant_name: null,
        date: "2026-09-01",
        pending: false,
      },
      {
        transaction_id: "t2",
        account_id: "a1",
        // And a refund arrives as a negative.
        amount: -10,
        iso_currency_code: "USD",
        name: "Refund",
        merchant_name: null,
        date: "2026-09-02",
        pending: false,
      },
    ],
    modified: [],
    removed: [],
    next_cursor: "c2",
    has_more: false,
  }));

  const page = await plaid.syncTransactions(CREDENTIALS, "access-1", null);
  const [out, back] = page.transactions;

  // The whole point: a bill leaving the account reads as money out.
  expect(out?.amountCents).toBe(-4_250);
  expect(back?.amountCents).toBe(1_000);
});

test("a transaction the bank amended is the same transaction", async () => {
  stub(() => ({
    added: [
      {
        transaction_id: "t1",
        account_id: "a1",
        amount: 1,
        iso_currency_code: "USD",
        name: "Pending card",
        merchant_name: null,
        date: "2026-09-01",
        pending: true,
      },
    ],
    // The same id again, settled and with a merchant name.
    modified: [
      {
        transaction_id: "t1",
        account_id: "a1",
        amount: 1.07,
        iso_currency_code: "USD",
        name: "CARD 1234",
        merchant_name: "Coffee",
        date: "2026-09-01",
        pending: false,
      },
    ],
    removed: [{ transaction_id: "t9" }],
    next_cursor: "c2",
    has_more: false,
  }));

  const page = await plaid.syncTransactions(CREDENTIALS, "access-1", null);

  // Both come through, carrying one id, so whatever stores them updates rather
  // than ending up with the pending one sitting beside the settled one on a
  // statement somebody is reconciling.
  expect(page.transactions.map((t) => t.reference)).toEqual(["t1", "t1"]);
  expect(page.transactions[1]?.description).toBe("Coffee");
  expect(page.transactions[1]?.pending).toBe(false);
  expect(page.removed).toEqual(["t9"]);
});

test("a balance in whole units is stored as cents", async () => {
  stub(() => ({
    accounts: [
      {
        account_id: "a1",
        name: "Business current",
        mask: "6789",
        subtype: "checking",
        balances: { current: 1234.56, iso_currency_code: "USD" },
      },
      {
        account_id: "a2",
        name: "No balance yet",
        mask: null,
        subtype: null,
        balances: { current: null, iso_currency_code: null },
      },
    ],
  }));

  const [first, second] = await plaid.listAccounts(CREDENTIALS, "access-1");
  expect(first?.balanceCents).toBe(123_456);
  expect(first?.last4).toBe("6789");
  // Not nought: a balance nobody could read is unknown, and nought is a claim.
  expect(second?.balanceCents).toBeNull();
});

/**
 * The provider says why in words meant for the person who is stuck.
 *
 * Throwing that away and reporting a status code is how somebody rings for
 * help instead of doing the one thing that would fix it.
 */
test("the reason a bank gave is the reason shown", async () => {
  stub(
    () => ({
      error_code: "ITEM_LOGIN_REQUIRED",
      error_message: "the login details have changed",
      display_message: "Your bank needs you to sign in again.",
    }),
    400,
  );

  await expect(plaid.listAccounts(CREDENTIALS, "access-1")).rejects.toThrow(
    "Your bank needs you to sign in again.",
  );
});

/**
 * A payment is authorised before it is sent, and a refusal stops there.
 *
 * The alternative is money that leaves and is returned a week later with a
 * fee, which is the failure this two-step exists to prevent.
 */
test("a payment the bank will not authorise is never sent", async () => {
  stub((path) =>
    path.endsWith("/transfer/authorization/create")
      ? {
          authorization: {
            id: "auth-1",
            decision: "declined",
            decision_rationale: { description: "There is not enough in it." },
          },
        }
      : {},
  );

  await expect(
    plaid.pay?.(CREDENTIALS, "access-1", {
      fromAccountReference: "a1",
      amountCents: 10_000,
      currency: "USD",
      description: "Invoice 2091",
      payee: {
        name: "Acme Supplies",
        accountNumber: "1234",
        routingNumber: "5678",
        kind: "business",
      },
    }),
  ).rejects.toThrow("There is not enough in it.");

  // And it stopped at the authorisation: nothing was created.
  expect(calls.map((c) => c.path)).not.toContain("/transfer/create");
});

test("what the supplier sees on their statement fits", async () => {
  stub((path) =>
    path.endsWith("/transfer/authorization/create")
      ? { authorization: { id: "auth-1", decision: "approved" } }
      : { transfer: { id: "tr-1", status: "pending" } },
  );

  await plaid.pay?.(CREDENTIALS, "access-1", {
    fromAccountReference: "a1",
    amountCents: 10_000,
    currency: "USD",
    description: "Invoice 2091 — September retainer",
    payee: {
      name: "Acme Supplies",
      accountNumber: "1234",
      routingNumber: "5678",
      kind: "business",
    },
  });

  const created = calls.find((c) => c.path === "/transfer/create");
  // Ten characters is what the rails carry. More is not an error: it is cut,
  // and the supplier rings up asking what "Invoice 20" was.
  expect(String(created?.body.description).length).toBeLessThanOrEqual(10);
});

/**
 * Paying a business and paying a person are different to the receiving bank.
 *
 * The class decides how the payment may be returned; the wrong one is a
 * payment that bounces in a way nobody can explain.
 */
test("a business is paid as a business", async () => {
  stub((path) =>
    path.endsWith("/transfer/authorization/create")
      ? { authorization: { id: "auth-1", decision: "approved" } }
      : { transfer: { id: "tr-1", status: "pending" } },
  );

  for (const [kind, expected] of [
    ["business", "ccd"],
    ["personal", "ppd"],
  ] as const) {
    calls.length = 0;
    await plaid.pay?.(CREDENTIALS, "access-1", {
      fromAccountReference: "a1",
      amountCents: 100,
      currency: "USD",
      description: "Test",
      payee: {
        name: "Somebody",
        accountNumber: "1",
        routingNumber: "2",
        kind,
      },
    });
    const auth = calls.find((c) =>
      c.path.endsWith("/transfer/authorization/create"),
    );
    expect(auth?.body.ach_class).toBe(expected);
  }
});

test("the sandbox and the live host are not the same place", async () => {
  process.env.PLAID_API_BASE = undefined;
  const seen: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    seen.push(new URL(String(url)).host);
    return new Response(JSON.stringify({ accounts: [] }), { status: 200 });
  }) as typeof fetch;

  await plaid.listAccounts({ ...CREDENTIALS, test: true }, "a");
  await plaid.listAccounts({ ...CREDENTIALS, test: false }, "a");

  expect(seen[0]).toContain("sandbox");
  expect(seen[1]).not.toContain("sandbox");
});
