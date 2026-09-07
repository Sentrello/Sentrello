import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { and, db, eq, schema } from "@sentrello/db";
import { registerForTest, secrets } from "@sentrello/module-sdk";
import accounting from "./index";

/**
 * A bank feed, from pasting the details to the rows arriving.
 *
 * The provider adapters are tested against a stub of their own. What is worth
 * testing here is the part that touches the books: that a sync run twice does
 * not duplicate a statement, that a bank amending a transaction updates the
 * one that is there rather than adding a second, that a match somebody made
 * survives the next sync, and that a secret is never in a response.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const app = registerForTest(accounting);

let headers: Headers;
let orgId: string;

const realFetch = globalThis.fetch;

const req = (path: string, init?: RequestInit) =>
  app.request(`http://localhost${path}`, { headers, ...init });

const send = (path: string, method: string, body: unknown) =>
  req(path, { method, body: JSON.stringify(body) });

/** Stands in for the provider, so nothing here talks to a bank. */
function stub(reply: (path: string) => unknown) {
  process.env.PLAID_API_BASE = "https://plaid.test";
  globalThis.fetch = (async (url: string | URL | Request) =>
    new Response(JSON.stringify(reply(new URL(String(url)).pathname)), {
      status: 200,
    })) as typeof fetch;
}

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email: `feeds-${suffix}@x.test`,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Feeds ${suffix}`, slug: `feeds-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.PLAID_API_BASE = undefined;
});

afterAll(async () => {
  await db
    .delete(schema.securityEvents)
    .where(eq(schema.securityEvents.organizationId, orgId));
  await db
    .delete(schema.organizationRole)
    .where(eq(schema.organizationRole.organizationId, orgId));
  for (const t of [
    schema.bankTransactions,
    schema.bankImports,
    schema.bankConnections,
    schema.bankProviderAccounts,
    schema.accounts,
  ]) {
    await db.delete(t).where(eq(t.organizationId, orgId));
  }
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
});

test("what each provider can do comes from the provider", async () => {
  const res = await req("/api/bank-feeds/providers");
  expect(res.status).toBe(200);
  const { providers } = (await res.json()) as {
    providers: {
      id: string;
      countries: string[];
      recurringPayments: boolean;
      connected: boolean;
    }[];
  };

  const plaid = providers.find((p) => p.id === "plaid");
  const teller = providers.find((p) => p.id === "teller");
  expect(plaid?.recurringPayments).toBe(true);
  // The one that cannot must say so, or the screen offers a button no
  // provider will honour.
  expect(teller?.recurringPayments).toBe(false);
  expect(teller?.countries).toEqual(["US"]);
  expect(plaid?.connected).toBe(false);
});

test("a secret that was pasted in never comes back out", async () => {
  const saved = await send("/api/bank-feeds/providers/plaid", "PUT", {
    clientId: "client-visible",
    secret: "secret-never-shown",
    testMode: true,
  });
  expect(saved.status).toBe(200);

  const res = await req("/api/bank-feeds/providers");
  const body = await res.text();
  // The client id is not secret and the screen shows it so somebody can tell
  // which account they pasted. The secret is not in any shape of this.
  expect(body).toContain("client-visible");
  expect(body).not.toContain("secret-never-shown");

  // And it is sealed at rest, not sitting in a column in the clear.
  const [row] = await db
    .select()
    .from(schema.bankProviderAccounts)
    .where(
      and(
        eq(schema.bankProviderAccounts.organizationId, orgId),
        eq(schema.bankProviderAccounts.provider, "plaid"),
      ),
    );
  expect(row?.secret).not.toBe("secret-never-shown");
  expect(secrets.open(row?.secret ?? "")).toBe("secret-never-shown");
});

test("connecting a bank brings its accounts into the chart", async () => {
  stub((path) => {
    if (path === "/link/token/create") {
      return { link_token: "link-1", hosted_link_url: "https://plaid.test/go" };
    }
    if (path === "/link/token/get") {
      return {
        link_sessions: [
          { results: { item_add_results: [{ public_token: "public-1" }] } },
        ],
      };
    }
    if (path === "/item/public_token/exchange") {
      return { access_token: "access-1", item_id: "item-1" };
    }
    if (path === "/item/get") return { item: { institution_id: "ins_1" } };
    if (path === "/institutions/get_by_id") {
      return { institution: { name: "Test Bank" } };
    }
    if (path === "/accounts/get") {
      return {
        accounts: [
          {
            account_id: "a1",
            name: "Business current",
            mask: "4321",
            subtype: "checking",
            balances: { current: 500, iso_currency_code: "USD" },
          },
        ],
      };
    }
    return {};
  });

  const started = await send("/api/bank-feeds/connect/start", "POST", {
    provider: "plaid",
  });
  expect(started.status).toBe(200);
  const start = (await started.json()) as { token: string; url?: string };
  // A page they host, not a script of theirs in this application.
  expect(start.url).toBe("https://plaid.test/go");

  const finished = await send("/api/bank-feeds/connect/finish", "POST", {
    provider: "plaid",
    startToken: start.token,
  });
  expect(finished.status).toBe(201);

  const accounts = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.organizationId, orgId));
  const bank = accounts.find((a) => a.bankAccountLast4 === "4321");
  expect(bank).toBeTruthy();
  // An asset, always: a bank account is money the business has.
  expect(bank?.type).toBe("asset");
  expect(bank?.isBank).toBe(true);
});

test("somebody who closed the window has not connected anything", async () => {
  stub((path) =>
    path === "/link/token/create"
      ? { link_token: "link-2", hosted_link_url: "https://plaid.test/go" }
      : // No item was added: they backed out.
        { link_sessions: [{ results: { item_add_results: [] } }] },
  );

  const before = await db
    .select()
    .from(schema.bankConnections)
    .where(eq(schema.bankConnections.organizationId, orgId));

  const res = await send("/api/bank-feeds/connect/finish", "POST", {
    provider: "plaid",
    startToken: "link-2",
  });
  // Not an error: nothing was connected and nothing is broken.
  expect(res.status).toBe(200);
  expect((await res.json()) as { connection: unknown }).toMatchObject({
    connection: null,
  });

  const after = await db
    .select()
    .from(schema.bankConnections)
    .where(eq(schema.bankConnections.organizationId, orgId));
  expect(after.length).toBe(before.length);
});

/**
 * The one that matters most: a sync run twice does not double the books.
 *
 * A bank amends a transaction days later — the amount settles, the description
 * gains a merchant name — and a feed that treated the amended copy as new
 * would leave the provisional row sitting beside the settled one on a
 * statement somebody is reconciling.
 */
test("a transaction the bank amended updates rather than duplicates", async () => {
  const [connection] = await db
    .select()
    .from(schema.bankConnections)
    .where(eq(schema.bankConnections.organizationId, orgId))
    .limit(1);
  if (!connection) throw new Error("no connection to sync");

  stub(() => ({
    added: [
      {
        transaction_id: "tx-1",
        account_id: "a1",
        amount: 42.5,
        iso_currency_code: "USD",
        name: "CARD 1234",
        merchant_name: null,
        date: "2026-09-01",
        pending: true,
      },
    ],
    modified: [],
    removed: [],
    next_cursor: "c1",
    has_more: false,
  }));

  const first = await send(`/api/bank-feeds/${connection.id}/sync`, "POST", {});
  expect(first.status).toBe(200);
  // One new, none updated. `INSERT … ON CONFLICT … RETURNING` hands back a row
  // either way, so counting what came back called every sync all-new and
  // reported nothing as updated, ever.
  expect(await first.json()).toMatchObject({ added: 1, updated: 0 });

  stub(() => ({
    added: [],
    // The same id, settled, with a name.
    modified: [
      {
        transaction_id: "tx-1",
        account_id: "a1",
        amount: 43.17,
        iso_currency_code: "USD",
        name: "CARD 1234",
        merchant_name: "The ISP",
        date: "2026-09-01",
        pending: false,
      },
    ],
    removed: [],
    next_cursor: "c2",
    has_more: false,
  }));

  const second = await send(
    `/api/bank-feeds/${connection.id}/sync`,
    "POST",
    {},
  );
  expect(second.status).toBe(200);
  expect(await second.json()).toMatchObject({ added: 0, updated: 1 });

  const rows = await db
    .select()
    .from(schema.bankTransactions)
    .where(eq(schema.bankTransactions.organizationId, orgId));
  const mine = rows.filter((r) => r.providerReference === "tx-1");

  expect(mine).toHaveLength(1);
  expect(mine[0]?.description).toBe("The ISP");
  expect(mine[0]?.pending).toBe(false);
  // Money out is negative here, whatever sign the provider used.
  expect(mine[0]?.amountCents).toBe(-4_317);
});

/**
 * A line the bank withdrew leaves with it.
 *
 * A pending card authorisation that never settles is taken back rather than
 * corrected, and one left behind is money the statement says was never spent —
 * a reconciliation that cannot be made to balance and a business hunting for a
 * transaction its bank no longer has.
 */
test("a transaction the bank withdrew is removed, unless it was reconciled", async () => {
  const [connection] = await db
    .select()
    .from(schema.bankConnections)
    .where(eq(schema.bankConnections.organizationId, orgId))
    .limit(1);
  if (!connection) throw new Error("no connection to sync");

  const withdrawn = {
    transaction_id: "tx-gone",
    account_id: "a1",
    amount: 10,
    iso_currency_code: "USD",
    name: "AUTHORISATION",
    merchant_name: null,
    date: "2026-09-02",
    pending: true,
  };
  const kept = { ...withdrawn, transaction_id: "tx-kept" };

  stub(() => ({
    added: [withdrawn, kept],
    modified: [],
    removed: [],
    next_cursor: "r1",
    has_more: false,
  }));
  await send(`/api/bank-feeds/${connection.id}/sync`, "POST", {});

  // One of them is somebody's own work by the time the bank changes its mind.
  await db
    .update(schema.bankTransactions)
    .set({ matchedEntryId: crypto.randomUUID() })
    .where(
      and(
        eq(schema.bankTransactions.organizationId, orgId),
        eq(schema.bankTransactions.providerReference, "tx-kept"),
      ),
    );

  stub(() => ({
    added: [],
    modified: [],
    removed: [{ transaction_id: "tx-gone" }, { transaction_id: "tx-kept" }],
    next_cursor: "r2",
    has_more: false,
  }));
  await send(`/api/bank-feeds/${connection.id}/sync`, "POST", {});

  const rows = await db
    .select()
    .from(schema.bankTransactions)
    .where(eq(schema.bankTransactions.organizationId, orgId));
  const references = rows.map((row) => row.providerReference);
  expect(references).not.toContain("tx-gone");
  // The reconciled one stays: the ledger holds the truth of what somebody did,
  // and deleting the line underneath would hide it rather than correct it.
  expect(references).toContain("tx-kept");
});

/**
 * And the match somebody made survives it.
 *
 * Reconciling is work a person did. A sync that cleared it would undo an
 * afternoon and give no sign that it had.
 */
test("a sync does not undo a reconciliation", async () => {
  const [connection] = await db
    .select()
    .from(schema.bankConnections)
    .where(eq(schema.bankConnections.organizationId, orgId))
    .limit(1);
  if (!connection) throw new Error("no connection to sync");

  const matched = crypto.randomUUID();
  await db
    .update(schema.bankTransactions)
    .set({ matchedEntryId: matched })
    .where(eq(schema.bankTransactions.providerReference, "tx-1"));

  stub(() => ({
    added: [],
    modified: [
      {
        transaction_id: "tx-1",
        account_id: "a1",
        amount: 43.17,
        iso_currency_code: "USD",
        name: "CARD 1234",
        merchant_name: "The ISP",
        date: "2026-09-01",
        pending: false,
      },
    ],
    removed: [],
    next_cursor: "c3",
    has_more: false,
  }));

  await send(`/api/bank-feeds/${connection.id}/sync`, "POST", {});

  const [row] = await db
    .select()
    .from(schema.bankTransactions)
    .where(eq(schema.bankTransactions.providerReference, "tx-1"));
  expect(row?.matchedEntryId).toBe(matched);
});

/**
 * A bank that has stopped working says so where somebody will see it.
 *
 * A feed that quietly fails is worse than one that never worked: the figures
 * look right and are a month old.
 */
test("a bank that wants a fresh login says so on the connection", async () => {
  const [connection] = await db
    .select()
    .from(schema.bankConnections)
    .where(eq(schema.bankConnections.organizationId, orgId))
    .limit(1);
  if (!connection) throw new Error("no connection to sync");

  process.env.PLAID_API_BASE = "https://plaid.test";
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error_code: "ITEM_LOGIN_REQUIRED",
        display_message: "Your bank needs you to sign in again.",
      }),
      { status: 400 },
    )) as unknown as typeof fetch;

  const res = await send(`/api/bank-feeds/${connection.id}/sync`, "POST", {});
  expect(res.status).toBe(502);

  const list = await req("/api/bank-feeds");
  const { connections } = (await list.json()) as {
    connections: { lastError: string | null }[];
  };
  // The bank's own words, because they say what to do about it.
  expect(connections[0]?.lastError).toBe(
    "Your bank needs you to sign in again.",
  );
});

test("no route hands back the token that reads the bank", async () => {
  const list = await req("/api/bank-feeds");
  const body = await list.text();
  expect(body).not.toContain("access-1");
  expect(body).not.toContain("accessToken");
});

/**
 * Connecting a bank is written into the log everything else is written into.
 *
 * Obvious at the time, unanswerable six months later: who connected a bank
 * account to these books, and when. The log already carries who changed a role
 * or turned off somebody's second factor.
 */
test("connecting and disconnecting a bank is recorded", async () => {
  const events = await db
    .select()
    .from(schema.securityEvents)
    .where(eq(schema.securityEvents.organizationId, orgId));

  const connected = events.find((e) => e.action === "bank.connected");
  expect(connected).toBeTruthy();
  expect(connected?.actorId).toBeTruthy();
  expect(connected?.detail).toMatchObject({ provider: "plaid" });

  // Pasting new details is its own event: it changes which account can read
  // the business's bank, which is not the same as connecting one.
  expect(events.some((e) => e.action === "bank.credentials.changed")).toBe(
    true,
  );

  // And the secret is not in the detail of any of them.
  expect(JSON.stringify(events)).not.toContain("secret-never-shown");
});

test("disconnecting says whether the provider agreed it was ended", async () => {
  const [connection] = await db
    .select()
    .from(schema.bankConnections)
    .where(eq(schema.bankConnections.organizationId, orgId))
    .limit(1);
  if (!connection) throw new Error("no connection to disconnect");

  stub(() => ({}));
  const res = await req(`/api/bank-feeds/${connection.id}`, {
    method: "DELETE",
  });
  expect(res.status).toBe(200);

  const events = await db
    .select()
    .from(schema.securityEvents)
    .where(
      and(
        eq(schema.securityEvents.organizationId, orgId),
        eq(schema.securityEvents.action, "bank.disconnected"),
      ),
    );
  expect(events[0]?.detail).toMatchObject({ endedAtProvider: true });

  // The rows that came in stay: they are a statement somebody may already have
  // reconciled against, and removing them would unpick the books.
  const rows = await db
    .select()
    .from(schema.bankTransactions)
    .where(eq(schema.bankTransactions.organizationId, orgId));
  expect(rows.length).toBeGreaterThan(0);
});

/**
 * The screen is told whether this person may connect a bank.
 *
 * A bookkeeper can see the connections and fetch a statement — that is the job
 * — and cannot link the business's bank to the books. Without this the screen
 * would offer them a button that answers 403, which is the same failure as
 * offering a repeating payment to a provider that cannot schedule one: a
 * control that cannot be honoured.
 *
 * Asked of the server, because the server is where the rule is. A second copy
 * of it in the browser is a second copy to get wrong.
 */
test("the providers list says whether this person may connect one", async () => {
  const res = await req("/api/bank-feeds/providers");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { mayConnect: boolean };
  // The owner of this instance, so yes.
  expect(body.mayConnect).toBe(true);
});

/**
 * And a bookkeeper can still do the work they are there to do.
 *
 * The point of splitting the permission was never to make reconciliation
 * harder. This is the real check rather than a reading of the source for the
 * strings it contains: a member holding the books and not the purse is asked
 * to do both things, and the answers have to differ.
 */
test("a bookkeeper fetches statements and cannot connect a bank", async () => {
  const bookkeeper = await signUpAsOwner({
    email: `feeds-books-${suffix}@x.test`,
    password: "correct-horse-battery-staple",
    name: "Bookkeeper",
  });
  const cookie = bookkeeper.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  const theirs = new Headers({ cookie, "content-type": "application/json" });

  // The whole ledger, and payments only to look at — the accounting default.
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: bookkeeper.response.user.id,
    role: "accounting",
    baseRole: "member",
    createdAt: new Date(),
  });
  // The role itself, as a business's own roles are stored: a name and the
  // permissions it grants, held per organization.
  await db.insert(schema.organizationRole).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    role: "accounting",
    permission: JSON.stringify({
      dashboard: ["read"],
      bookkeeping: ["read", "create", "update", "delete"],
      // Sees what was paid. Pays nobody.
      payments: ["read"],
    }),
  });
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers: theirs,
  });

  const ask = (path: string, init?: RequestInit) =>
    app.request(`http://localhost${path}`, { headers: theirs, ...init });

  // The screen is told not to offer what they cannot do.
  const list = await ask("/api/bank-feeds/providers");
  expect(list.status).toBe(200);
  expect(((await list.json()) as { mayConnect: boolean }).mayConnect).toBe(
    false,
  );

  // Connecting a bank is refused.
  const connect = await ask("/api/bank-feeds/connect/start", {
    method: "POST",
    body: JSON.stringify({ provider: "plaid" }),
  });
  expect(connect.status).toBe(403);

  // And the work they are there to do is not.
  const seen = await ask("/api/bank-feeds");
  expect(seen.status).toBe(200);
});
