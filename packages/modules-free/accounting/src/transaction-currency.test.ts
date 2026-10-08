import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, schema } from "@sentrello/db";
import { registerForTest } from "@sentrello/module-sdk";
import accounting from "./index";

/**
 * An expense is in the business's own money, and the record cannot say otherwise.
 *
 * The column defaulted to USD and the route took whatever a caller sent, while
 * the amount is posted into the journal at face value with no conversion. Two
 * consequences, both silent: a cash expense on a Canadian instance was recorded
 * as a dollar one beside a Canadian journal entry for the same money, and a
 * caller that said `EUR` put euro cents into the books as base cents — so the
 * trial balance, the profit and loss and every return built on them were out by
 * the exchange rate with nothing anywhere disagreeing.
 *
 * Refused rather than converted, because this table has no `rateMicro`. Invoices
 * and bills each carry the rate they were raised at; a transaction has nowhere to
 * put one, and a rate read at report time would restate last year's accounts
 * every time somebody opened them.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const app = registerForTest(accounting);

let headers: Headers;
let orgId: string;

const req = (path: string, init?: RequestInit) =>
  app.request(`http://localhost${path}`, { headers, ...init });
const post = (path: string, body: unknown) =>
  req(path, { method: "POST", body: JSON.stringify(body) });

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email: `txcur-${suffix}@x.test`,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `TxCur ${suffix}`, slug: `txcur-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  // A business that keeps its books in Canadian dollars, which is the whole
  // point: on an American instance the old default happened to be right.
  await db
    .update(schema.organizations)
    .set({ baseCurrency: "CAD" })
    .where(eq(schema.organizations.id, orgId));
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
    schema.transactions,
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

test("an expense that says nothing is in the business's own currency", async () => {
  const res = await post("/api/transactions", {
    kind: "expense",
    amountCents: 4500,
    description: "Courier",
  });
  expect(res.status).toBe(201);
  const { transaction } = (await res.json()) as {
    transaction: { id: string; currency: string };
  };
  expect(transaction.currency).toBe("CAD");
});

test("income is the same, because it is the same writer", async () => {
  const res = await post("/api/transactions", {
    kind: "income",
    amountCents: 12000,
    description: "Window cleaning",
  });
  expect(res.status).toBe(201);
  const { transaction } = (await res.json()) as {
    transaction: { currency: string };
  };
  expect(transaction.currency).toBe("CAD");
});

/** Naming the books' own currency is fine, in either case. */
test("saying the currency it is in is accepted", async () => {
  const res = await post("/api/transactions", {
    kind: "expense",
    amountCents: 999,
    currency: "cad",
    description: "Stamps",
  });
  expect(res.status).toBe(201);
  const { transaction } = (await res.json()) as {
    transaction: { currency: string };
  };
  expect(transaction.currency).toBe("CAD");
});

/**
 * And anything else is refused before a line is posted.
 *
 * The assertion that matters is the second one: the old code wrote the row and
 * posted the entry, so a refusal that left either behind would be the same bug
 * with a message on top.
 */
test("a currency the books cannot hold is refused, not posted", async () => {
  const before = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));

  const res = await post("/api/transactions", {
    kind: "expense",
    amountCents: 50_000,
    currency: "EUR",
    description: "A supplier in Berlin",
  });
  expect(res.status).toBe(400);
  const { error } = (await res.json()) as { error: string };
  expect(error).toContain("CAD");
  expect(error).toContain("bill");

  const after = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));
  expect(after.length).toBe(before.length);

  const euro = await db
    .select({ id: schema.transactions.id })
    .from(schema.transactions)
    .where(eq(schema.transactions.currency, "EUR"));
  expect(euro.length).toBe(0);
});
