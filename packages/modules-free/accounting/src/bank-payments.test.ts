import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { and, db, eq, schema } from "@sentrello/db";
import { registerForTest, secrets } from "@sentrello/module-sdk";
import { settleOutstanding, validRouting } from "./bank-payments";
import accounting from "./index";

/**
 * The one thing in the product that cannot be taken back.
 *
 * Everything else here can be corrected: a wrong entry is reversed, a wrong
 * rule undone, a wrong reconciliation abandoned. Money that has left the bank
 * has left the bank — so what is tested is not that a payment can be sent, but
 * that one cannot be sent twice, cannot be sent by somebody who only keeps the
 * books, and never reaches the ledger unless the bank accepted it.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const app = registerForTest(accounting);

let headers: Headers;
let orgId: string;
let cash = "";
let connectionId = "";
let payeeId = "";
/** The second business, cleaned up whatever happens. */
let otherOrgId: string | null = null;

const realFetch = globalThis.fetch;

const req = (path: string, init?: RequestInit) =>
  app.request(`http://localhost${path}`, { headers, ...init });
const post = (path: string, body: unknown) =>
  req(path, { method: "POST", body: JSON.stringify(body) });

/** Stands in for the bank, so nothing here moves any money. */
function stub(reply: (path: string) => unknown, status = 200) {
  process.env.PLAID_API_BASE = "https://plaid.test";
  globalThis.fetch = (async (url: string | URL | Request) =>
    new Response(JSON.stringify(reply(new URL(String(url)).pathname)), {
      status,
    })) as typeof fetch;
}

const ACCEPTED = (path: string) =>
  path.includes("/transfer/authorization/create")
    ? { authorization: { id: "auth-1", decision: "approved" } }
    : path.includes("/transfer/recurring/create")
      ? {
          recurring_transfer: {
            recurring_transfer_id: "rec-1",
            status: "active",
          },
        }
      : {
          transfer: {
            id: "tr-1",
            status: "pending",
            expected_settlement_date: "2026-09-10",
          },
        };

async function account(code: string, name: string, type: string) {
  const res = await post("/api/accounts", { code, name, type });
  const { account: made } = (await res.json()) as { account: { id: string } };
  return made.id;
}

const pay = (body: Record<string, unknown>) =>
  post("/api/bank-payments", {
    payeeId,
    connectionId,
    fromAccountReference: "acct-1",
    fromLedgerAccountId: cash,
    amountCents: 25_000,
    description: "Invoice 44",
    idempotencyKey: crypto.randomUUID(),
    ...body,
  });

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email: `pay-${suffix}@x.test`,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Pay ${suffix}`, slug: `pay-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  cash = await account("1000", "Current account", "asset");

  await db.insert(schema.bankProviderAccounts).values({
    organizationId: orgId,
    provider: "plaid",
    clientId: "client",
    secret: secrets.seal("secret"),
    testMode: true,
  });
  const [connection] = await db
    .insert(schema.bankConnections)
    .values({
      organizationId: orgId,
      provider: "plaid",
      institutionName: "Test Bank",
      accessToken: secrets.seal("access-token"),
      testMode: true,
    })
    .returning();
  if (!connection) throw new Error("no connection");
  connectionId = connection.id;

  const made = await post("/api/payees", {
    name: "Sam the joiner",
    accountNumber: "000123456789",
    // A real routing number, check digit and all.
    routingNumber: "021000021",
  });
  const { payee } = (await made.json()) as { payee: { id: string } };
  payeeId = payee.id;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.PLAID_API_BASE = undefined;
});

afterAll(async () => {
  if (otherOrgId) {
    for (const t of [schema.payees, schema.securityEvents]) {
      await db.delete(t).where(eq(t.organizationId, otherOrgId));
    }
    await db
      .delete(schema.member)
      .where(eq(schema.member.organizationId, otherOrgId));
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, otherOrgId));
  }
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
    .delete(schema.organizationRole)
    .where(eq(schema.organizationRole.organizationId, orgId));
  for (const t of [
    schema.bankPaymentSchedules,
    schema.bankPayments,
    schema.payees,
    schema.bankConnections,
    schema.bankProviderAccounts,
    schema.journalEntries,
    schema.accounts,
    schema.securityEvents,
  ]) {
    await db.delete(t).where(eq(t.organizationId, orgId));
  }
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
});

/**
 * An account number is enough on its own to take money out of an account.
 *
 * Sealed at rest and never in any response — the same rule as a provider
 * secret, for the same reason.
 */
test("a payee's bank details never come back out", async () => {
  const listed = await req("/api/payees");
  // Cloned before the body is read: a response can only be consumed once.
  const body = (await listed.clone().json()) as {
    payees: Record<string, unknown>[];
  };
  const text = await listed.text();
  expect(text).not.toContain("000123456789");
  expect(text).not.toContain("021000021");
  expect(text).toContain("6789");

  /**
   * And the sealed value does not come out either.
   *
   * Checking only for the plaintext passes for a response handing back the
   * ciphertext, which is a secret leaving the database on every page load and
   * needing only the key to read. The field is not there at all.
   */
  for (const row of body.payees) {
    expect("accountNumber" in row).toBe(false);
    expect("routingNumber" in row).toBe(false);
  }

  const [row] = await db
    .select()
    .from(schema.payees)
    .where(eq(schema.payees.id, payeeId))
    .limit(1);
  expect(row?.accountNumber).not.toContain("000123456789");
  expect(secrets.open(row?.accountNumber ?? "")).toBe("000123456789");
});

/**
 * The check digit, which catches most single mistyped digits.
 *
 * The difference between a supplier being paid and money going somewhere
 * nobody can get it back from.
 */
test("a routing number that does not check out is refused", () => {
  expect(validRouting("021000021")).toBe(true);
  // One digit changed.
  expect(validRouting("021000022")).toBe(false);
  expect(validRouting("12345")).toBe(false);
});

test("a bad routing number never becomes a payee", async () => {
  const res = await post("/api/payees", {
    name: "Typo",
    accountNumber: "12345678",
    routingNumber: "021000022",
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain(
    "does not check out",
  );
});

/**
 * Sent once, and the books follow.
 *
 * The entry is posted after the bank accepted, from what it said — books that
 * record a payment the bank refused disagree with the statement for ever.
 */
test("a payment is sent, recorded, and posted to the books", async () => {
  stub(ACCEPTED);
  const res = await pay({});
  expect(res.status).toBe(201);
  const { payment } = (await res.json()) as {
    payment: { id: string; status: string; providerReference: string | null };
  };
  expect(payment.status).toBe("pending");
  expect(payment.providerReference).toBe("tr-1");

  const [row] = await db
    .select()
    .from(schema.bankPayments)
    .where(eq(schema.bankPayments.id, payment.id))
    .limit(1);
  expect(row?.entryId).toBeTruthy();

  const lines = await db
    .select()
    .from(schema.journalLines)
    .where(eq(schema.journalLines.entryId, row?.entryId ?? ""));
  // Money out of the bank, and something on the other side.
  expect(lines.find((l) => l.accountId === cash)?.creditCents).toBe(25_000);
});

/**
 * One press is one payment.
 *
 * The failure this prevents is a supplier paid twice because a button was
 * slow, and it is not recoverable by pressing anything else.
 */
test("the same key twice sends one payment", async () => {
  stub(ACCEPTED);
  const key = crypto.randomUUID();
  const first = await pay({ idempotencyKey: key });
  expect(first.status).toBe(201);

  const second = await pay({ idempotencyKey: key });
  const body = (await second.json()) as { repeated?: boolean };
  expect(body.repeated).toBe(true);

  const rows = await db
    .select()
    .from(schema.bankPayments)
    .where(
      and(
        eq(schema.bankPayments.organizationId, orgId),
        eq(schema.bankPayments.idempotencyKey, key),
      ),
    );
  expect(rows).toHaveLength(1);
});

test("a payment with no key is refused", async () => {
  stub(ACCEPTED);
  const res = await pay({ idempotencyKey: "" });
  expect(res.status).toBe(400);
});

/**
 * A bank that refuses says why, and nothing reaches the books.
 *
 * "Insufficient funds" is something a person can act on. "Payment failed" is
 * not, and an entry posted anyway is a bank balance that is wrong until
 * somebody reconciles.
 */
test("a refused payment is recorded as failed and posts nothing", async () => {
  stub(
    () => ({
      error_message: "insufficient funds in the account",
      error_code: "INSUFFICIENT_FUNDS",
    }),
    400,
  );

  const before = await db
    .select()
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));

  const res = await pay({});
  expect(res.status).toBe(502);
  const said = (await res.json()) as { error: string; paymentId: string };
  expect(said.error).toContain("insufficient funds");

  const [row] = await db
    .select()
    .from(schema.bankPayments)
    .where(eq(schema.bankPayments.id, said.paymentId))
    .limit(1);
  expect(row?.status).toBe("failed");
  // Written down rather than lost, so a payment nobody can account for cannot
  // happen even when the provider answers and this process dies.
  expect(row?.lastError).toContain("insufficient funds");
  expect(row?.entryId).toBeNull();

  const after = await db
    .select()
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));
  expect(after.length).toBe(before.length);
});

/**
 * A real payee, belonging to somebody else.
 *
 * An id that exists nowhere answers 404 whether the route is scoped or not.
 * This one exists — and paying it would send this business's money to another
 * business's supplier, which is the worst thing in this file.
 */
test("a payee that is not this business's cannot be paid", async () => {
  const other = await auth.api.createOrganization({
    body: { name: `Other ${suffix}`, slug: `other-pay-${suffix}` },
    headers,
  });
  if (!other) throw new Error("could not create the second organization");
  otherOrgId = other.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  const [theirs] = await db
    .insert(schema.payees)
    .values({
      organizationId: other.id,
      name: "Their supplier",
      kind: "business",
      accountNumber: secrets.seal("999888777"),
      routingNumber: secrets.seal("021000021"),
      accountLast4: "8777",
    })
    .returning();
  if (!theirs) throw new Error("their payee was not written");

  stub(ACCEPTED);
  const res = await pay({ payeeId: theirs.id });
  expect(res.status).toBe(404);

  // And nothing was written against them.
  const sent = await db
    .select()
    .from(schema.bankPayments)
    .where(eq(schema.bankPayments.payeeId, theirs.id));
  expect(sent).toHaveLength(0);
});

/**
 * A provider that accepts nothing posts nothing.
 *
 * The books follow the money: an entry written for a payment the bank
 * cancelled is a bank balance that is wrong until somebody reconciles, and the
 * reconciliation is where it is found rather than here.
 */
test("a payment the provider cancelled never reaches the books", async () => {
  stub((path) =>
    path.includes("/transfer/authorization/create")
      ? { authorization: { id: "auth-2", decision: "approved" } }
      : {
          transfer: {
            id: "tr-cancelled",
            status: "cancelled",
            expected_settlement_date: null,
          },
        },
  );

  const res = await pay({ description: "Cancelled one" });
  expect(res.status).toBe(201);
  const { payment } = (await res.json()) as { payment: { id: string } };

  const [row] = await db
    .select()
    .from(schema.bankPayments)
    .where(eq(schema.bankPayments.id, payment.id))
    .limit(1);
  expect(row?.status).toBe("cancelled");
  expect(row?.entryId).toBeNull();
});

/**
 * The books are caught up, once.
 *
 * A process that dies between the bank saying yes and the entry being written
 * leaves money gone and nothing in the ledger. The job finds those — and must
 * not post a second entry for one it already did, which would take the bank
 * balance down twice.
 */
test("a payment that never reached the books is caught up, and only once", async () => {
  stub(ACCEPTED);
  const res = await pay({ description: "Interrupted" });
  const { payment } = (await res.json()) as { payment: { id: string } };

  // As if the process had died between the bank saying yes and the entry
  // being written: the entry is taken away and the link with it.
  const [before] = await db
    .select()
    .from(schema.bankPayments)
    .where(eq(schema.bankPayments.id, payment.id))
    .limit(1);
  if (!before?.entryId) throw new Error("expected an entry to remove");
  await db
    .delete(schema.journalLines)
    .where(eq(schema.journalLines.entryId, before.entryId));
  await db
    .delete(schema.journalEntries)
    .where(eq(schema.journalEntries.id, before.entryId));
  await db
    .update(schema.bankPayments)
    .set({ entryId: null })
    .where(eq(schema.bankPayments.id, payment.id));

  await settleOutstanding();
  const [caught] = await db
    .select()
    .from(schema.bankPayments)
    .where(eq(schema.bankPayments.id, payment.id))
    .limit(1);
  expect(caught?.entryId).toBeTruthy();

  const entriesAfterFirst = await db
    .select()
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.source, `bank-payment:${payment.id}`));

  await settleOutstanding();
  const entriesAfterSecond = await db
    .select()
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.source, `bank-payment:${payment.id}`));
  // Running it again writes nothing: a second entry would take the bank
  // balance down twice for one payment.
  expect(entriesAfterSecond.length).toBe(entriesAfterFirst.length);
});

/**
 * And a failed one is never caught up either.
 *
 * The job sweeps everything with no entry, and a refused payment has no entry
 * for exactly the right reason.
 */
test("a failed payment is not posted by the catch-up either", async () => {
  stub(
    () => ({ error_message: "account closed", error_code: "ACCOUNT_CLOSED" }),
    400,
  );
  const res = await pay({ description: "Refused" });
  const { paymentId } = (await res.json()) as { paymentId: string };

  await settleOutstanding();

  const [row] = await db
    .select()
    .from(schema.bankPayments)
    .where(eq(schema.bankPayments.id, paymentId))
    .limit(1);
  expect(row?.entryId).toBeNull();
});

test("a bank that is not this business's cannot send money", async () => {
  stub(ACCEPTED);
  const res = await pay({ connectionId: crypto.randomUUID() });
  expect(res.status).toBe(404);
});

test("a payment of nothing, or of a fraction, is refused", async () => {
  stub(ACCEPTED);
  expect((await pay({ amountCents: 0 })).status).toBe(400);
  expect((await pay({ amountCents: 12.5 })).status).toBe(400);
  expect((await pay({ amountCents: -100 })).status).toBe(400);
});

/**
 * A repeating payment is scheduled at the bank, never here.
 *
 * A product that ran its own timer would be a business's rent depending on our
 * server being awake at the right minute.
 */
test("a repeating payment is set up at the provider", async () => {
  stub(ACCEPTED);
  const res = await post("/api/bank-payments/recurring", {
    payeeId,
    connectionId,
    fromAccountReference: "acct-1",
    fromLedgerAccountId: cash,
    amountCents: 5_000,
    description: "The ISP",
    every: "month",
    startsOn: "2026-10-01T00:00:00Z",
  });
  expect(res.status).toBe(201);
  const { schedule } = (await res.json()) as {
    schedule: { id: string; providerReference: string | null; active: boolean };
  };
  expect(schedule.providerReference).toBe("rec-1");
  expect(schedule.active).toBe(true);

  const stopped = await post(
    `/api/bank-payments/recurring/${schedule.id}/stop`,
    {},
  );
  expect(stopped.status).toBe(200);
  // Said plainly: the arrangement lives at the bank, and claiming otherwise
  // would have somebody discover a payment they thought was cancelled.
  expect(((await stopped.json()) as { note: string }).note).toContain("bank");
});

test("a repeating payment that ends before it begins is refused", async () => {
  stub(ACCEPTED);
  const res = await post("/api/bank-payments/recurring", {
    payeeId,
    connectionId,
    fromAccountReference: "acct-1",
    amountCents: 5_000,
    every: "month",
    startsOn: "2026-10-01T00:00:00Z",
    endsOn: "2026-09-01T00:00:00Z",
  });
  expect(res.status).toBe(400);
});

test("a schedule of some other frequency is refused", async () => {
  stub(ACCEPTED);
  const res = await post("/api/bank-payments/recurring", {
    payeeId,
    connectionId,
    fromAccountReference: "acct-1",
    amountCents: 5_000,
    every: "fortnight",
    startsOn: "2026-10-01T00:00:00Z",
  });
  expect(res.status).toBe(400);
});

/**
 * Sending money is not keeping the books.
 *
 * A bookkeeper reconciles and categorises all day and never needs to move a
 * penny. The two being one permission is how a compromised bookkeeping login
 * becomes a bank transfer.
 */
test("somebody who only keeps the books cannot send money", async () => {
  const theirEmail = `clerk-${suffix}@x.test`;
  const signUp = await signUpAsOwner({
    email: theirEmail,
    password: "correct-horse-battery-staple",
    name: "Bookkeeper",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("no cookie");
  const [them] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, theirEmail))
    .limit(1);
  if (!them) throw new Error("no user");

  await db.insert(schema.organizationRole).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    role: "bookkeeper",
    permission: JSON.stringify({
      bookkeeping: ["read", "create", "update"],
      payments: ["read"],
    }),
    createdAt: new Date(),
  });
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: them.id,
    role: "bookkeeper",
    createdAt: new Date(),
  });

  const theirHeaders = new Headers({
    cookie,
    "content-type": "application/json",
  });
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers: theirHeaders,
  });

  stub(ACCEPTED);
  const res = await app.request("http://localhost/api/bank-payments", {
    method: "POST",
    headers: theirHeaders,
    body: JSON.stringify({
      payeeId,
      connectionId,
      fromAccountReference: "acct-1",
      amountCents: 100,
      idempotencyKey: crypto.randomUUID(),
    }),
  });
  expect(res.status).toBe(403);

  // And they can still see what has been paid, which is their job.
  const seen = await app.request("http://localhost/api/bank-payments", {
    headers: theirHeaders,
  });
  expect(seen.status).toBe(200);

  await db.delete(schema.user).where(eq(schema.user.id, them.id));
});

test("sending money is written into the log", async () => {
  const events = await db
    .select()
    .from(schema.securityEvents)
    .where(eq(schema.securityEvents.organizationId, orgId));
  const actions = events.map((e) => e.action);
  expect(actions).toContain("payee.added");
  expect(actions).toContain("payment.sent");
  expect(actions).toContain("payment.scheduled");
  // Never the numbers themselves, only enough to recognise the payee.
  expect(JSON.stringify(events)).not.toContain("000123456789");
});
