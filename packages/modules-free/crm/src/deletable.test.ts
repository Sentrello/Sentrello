import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, schema } from "@sentrello/db";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { Hono } from "hono";
import crm from "./index";

/**
 * What stops a customer being deleted, table by table.
 *
 * The guard asked about invoices and quotes and nothing else, while nine
 * tables carry a `contactId` and not one of them is a foreign key — so a
 * contact with a live subscription deleted cleanly, and the scheduler went on
 * raising an invoice a month for somebody the CRM could no longer show.
 *
 * Each table is asserted on its own rather than all at once, because the
 * failure this is written against is precisely a table nobody thought of: a
 * test that inserts five rows and expects one refusal passes with four of the
 * five queries missing.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const app = new Hono<SentrelloEnv>();
let orgId: string;
let headers: Headers;

beforeAll(async () => {
  crm.register({
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
  } as never);

  const signUp = await signUpAsOwner({
    email: `deletable-${suffix}@example.test`,
    password: "correct-horse-battery-staple",
    name: "Deletable",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Deletable ${suffix}`, slug: `deletable-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });
});

afterAll(async () => {
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
});

/** A contact of this organization, and its id. */
async function aContact(name: string): Promise<string> {
  const res = await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({ firstName: name, lastName: suffix }),
  });
  if (res.status !== 201) {
    throw new Error(`could not create a contact: ${res.status}`);
  }
  const { contact } = (await res.json()) as { contact: { id: string } };
  return contact.id;
}

/** Asking to delete one, and whatever the answer was. */
async function deleteContact(id: string) {
  const res = await app.request(`http://localhost/api/contacts/${id}`, {
    method: "DELETE",
    headers,
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return { status: res.status, error: body.error ?? "" };
}

test("a contact with nothing financial on it deletes", async () => {
  const id = await aContact("Nothing");
  const { status } = await deleteContact(id);
  expect(status).toBe(200);
});

test("a live subscription stops the delete, and says it is a subscription", async () => {
  const id = await aContact("Subscriber");
  await db.insert(schema.recurringProfiles).values({
    organizationId: orgId,
    contactId: id,
    interval: "month",
    nextRunAt: new Date(),
    kind: "subscription",
  });
  const { status, error } = await deleteContact(id);
  expect(status).toBe(409);
  expect(error).toContain("1 subscription");
  // Not the other word for the same row: a subscription and a standing
  // instruction to bill monthly are different things to the business.
  expect(error).not.toContain("recurring invoice");
});

test("a recurring invoice stops it too, under its own name", async () => {
  const id = await aContact("Retainer");
  await db.insert(schema.recurringProfiles).values({
    organizationId: orgId,
    contactId: id,
    interval: "month",
    nextRunAt: new Date(),
    kind: "invoice",
  });
  const { status, error } = await deleteContact(id);
  expect(status).toBe(409);
  expect(error).toContain("1 recurring invoice");
});

test("a bookkeeping entry stops it", async () => {
  const id = await aContact("Ledger");
  await db.insert(schema.transactions).values({
    organizationId: orgId,
    contactId: id,
    kind: "expense",
    amountCents: 1234,
  });
  const { status, error } = await deleteContact(id);
  expect(status).toBe(409);
  expect(error).toContain("1 bookkeeping entry");
});

test("a payee record stops it", async () => {
  const id = await aContact("Payee");
  await db.insert(schema.payees).values({
    organizationId: orgId,
    contactId: id,
    name: `Supplier ${suffix}`,
    accountNumber: "000123456",
    routingNumber: "011000015",
  });
  const { status, error } = await deleteContact(id);
  expect(status).toBe(409);
  expect(error).toContain("1 payee record");
});

test("contractor tax details stop it — the IRS asks for those by name", async () => {
  const id = await aContact("Contractor");
  await db.insert(schema.contractorTaxDetails).values({
    organizationId: orgId,
    contactId: id,
    legalName: `Trades ${suffix}`,
  });
  const { status, error } = await deleteContact(id);
  expect(status).toBe(409);
  expect(error).toContain("contractor tax details");
});

/**
 * And the sentence itself, once there is more than one thing in it.
 *
 * "1 invoice and 1 quote" was an `Array.join(" and ")` of two, which reads as
 * "a, b and c" wrongly the moment there are three.
 */
test("several reasons are listed as a sentence, and counted as plural", async () => {
  const id = await aContact("Everything");
  await db.insert(schema.recurringProfiles).values({
    organizationId: orgId,
    contactId: id,
    interval: "month",
    nextRunAt: new Date(),
    kind: "subscription",
  });
  await db.insert(schema.transactions).values({
    organizationId: orgId,
    contactId: id,
    kind: "income",
    amountCents: 500,
  });
  await db.insert(schema.transactions).values({
    organizationId: orgId,
    contactId: id,
    kind: "income",
    amountCents: 700,
  });
  const { status, error } = await deleteContact(id);
  expect(status).toBe(409);
  expect(error).toContain("1 subscription and 2 bookkeeping entries");
  expect(error).toContain("leave those without a customer");
});

/** And that removing the reason removes the refusal. */
test("clearing the history makes the contact deletable again", async () => {
  const id = await aContact("Cleared");
  await db.insert(schema.transactions).values({
    organizationId: orgId,
    contactId: id,
    kind: "expense",
    amountCents: 42,
  });
  expect((await deleteContact(id)).status).toBe(409);
  await db
    .delete(schema.transactions)
    .where(eq(schema.transactions.contactId, id));
  expect((await deleteContact(id)).status).toBe(200);
});
