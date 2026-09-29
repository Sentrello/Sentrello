import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import { dayIn } from "@sentrello/db/day";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import invoicing from "./index";

/**
 * An issue date is the business's day, and the list still reads in order.
 *
 * Two faults behind this, one from each half of the same change:
 *
 * The create route set no issue date unless one was typed, so the column's
 * `defaultNow()` stored the instant the row was written. An invoice raised at
 * nine in the evening in New York was dated the next day, and at the end of a
 * month it was dated into a month the business had not traded in — a sale in
 * the wrong period, on the document and in the ledger.
 *
 * Then, once the date became a day, every invoice raised today shared it. The
 * list is sorted by issue date, and rows that tie come back in whatever order
 * the database likes: this morning's five invoices arrived shuffled, and under
 * paging one of them could sit on page one, then page two, and never be read.
 * The tie is broken by when the row was written.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const email = `issued-today-${suffix}@example.test`;
const app = new Hono<SentrelloEnv>();
const ZONE = "America/Los_Angeles";

let orgId: string;
let headers: Headers;
let contactId: string;

beforeAll(async () => {
  invoicing.register({
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
  });

  const signUp = await signUpAsOwner({
    email,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Issued ${suffix}`, slug: `issued-today-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });
  // Deliberately west of Greenwich: for the last seven hours of a UTC day this
  // business is still on the day before, which is where the bug lived.
  await db
    .update(schema.organizations)
    .set({ timezone: ZONE })
    .where(eq(schema.organizations.id, orgId));

  const [contact] = await db
    .insert(schema.contacts)
    .values({ organizationId: orgId, name: "Acme Ltd" })
    .returning();
  if (!contact) throw new Error("could not create contact");
  contactId = contact.id;
});

afterAll(async () => {
  // Lines cascade from the invoice, so the invoice is enough.
  for (const [table, column] of [
    [schema.invoices, schema.invoices.organizationId],
    [schema.contacts, schema.contacts.organizationId],
    [schema.invoicingSettings, schema.invoicingSettings.organizationId],
  ] as const) {
    await db.delete(table).where(eq(column, orgId));
  }
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  const [owner] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email));
  if (owner) {
    await db.delete(schema.session).where(eq(schema.session.userId, owner.id));
    await db.delete(schema.account).where(eq(schema.account.userId, owner.id));
    await db.delete(schema.user).where(eq(schema.user.id, owner.id));
  }
});

async function create(description: string) {
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "USD",
      lines: [{ description, quantity: 1, unitPrice: 10_000 }],
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    invoice: { id: string; number: string; issueDate: string };
  };
  return body.invoice;
}

test("an invoice nobody dated is dated the business's day", async () => {
  const invoice = await create("Consulting");
  const [row] = await db
    .select({ issueDate: schema.invoices.issueDate })
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoice.id));
  if (!row) throw new Error("invoice not stored");
  expect(row.issueDate.toISOString()).toBe(
    dayIn(new Date(), ZONE).toISOString(),
  );
  // Midnight, because a date names a day and not the moment it was typed.
  expect(row.issueDate.toISOString()).toEndWith("T00:00:00.000Z");
});

test("the day's invoices list in the order they were raised", async () => {
  const second = await create("Second");
  const third = await create("Third");

  const res = await app.request("http://localhost/api/invoices", { headers });
  expect(res.status).toBe(200);
  const { invoices } = (await res.json()) as {
    invoices: { id: string; number: string }[];
  };

  // Newest first, which is the list's default — and all three share a day.
  expect(invoices.slice(0, 2).map((i) => i.id)).toEqual([third.id, second.id]);
});
