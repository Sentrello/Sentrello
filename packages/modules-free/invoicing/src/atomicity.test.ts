import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import { dropOrganization, dropUsers } from "@sentrello/db/testing";
import { registerForTest } from "@sentrello/module-sdk";
import { and, eq, inArray, like } from "drizzle-orm";
import invoicing from "./index";

/**
 * A document that records money and the entry that posts it live or die
 * together — and nothing takes money against a document that is not a debt.
 *
 * Both halves were reachable. Posting refuses a date inside a closed period,
 * and every route that raises or issues an invoice accepts a back-dated issue
 * date, so the refusal arrived *after* the invoice had been written as `open`:
 * a debt on every aging report, chased by the reminder sweep, with no entry
 * behind it. And the payments route worked the balance out longhand from
 * `totalCents` rather than asking `invoiceState`, so it took money against a
 * draft — clearing a receivable the books had never carried — and against a
 * void, clearing one already reversed.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const email = `invoicing-atomic-${suffix}@example.test`;
const app = registerForTest(invoicing);

let orgId: string;
let headers: Headers;
let contactId: string;

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Atomic ${suffix}`, slug: `atomic-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  const [contact] = await db
    .insert(schema.contacts)
    .values({ organizationId: orgId, name: "Halloran Ltd" })
    .returning();
  if (!contact) throw new Error("could not create test contact");
  contactId = contact.id;
});

afterAll(async () => {
  await dropOrganization(orgId);
  await dropUsers(email);
});

async function draft(body: Record<string, unknown> = {}) {
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      status: "draft",
      lines: [{ description: "Work", quantity: 1, unitPrice: 50_000 }],
      ...body,
    }),
  });
  if (res.status >= 400) throw new Error(`draft answered ${res.status}`);
  const { invoice } = (await res.json()) as {
    invoice: { id: string; status: string };
  };
  return invoice;
}

async function entriesFor(invoiceId: string) {
  return db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(
      and(
        eq(schema.journalEntries.organizationId, orgId),
        eq(schema.journalEntries.source, `invoice:${invoiceId}`),
      ),
    );
}

test("an issue the books refuse leaves the invoice a draft", async () => {
  const invoice = await draft();

  // The books are closed through the end of last month, which is exactly the
  // case the back-dated issue date exists for.
  const closedThrough = new Date();
  closedThrough.setUTCDate(0);
  await db
    .insert(schema.ledgerSettings)
    .values({ organizationId: orgId, closedThrough })
    .onConflictDoUpdate({
      target: schema.ledgerSettings.organizationId,
      set: { closedThrough },
    });

  const backdated = new Date(closedThrough);
  backdated.setUTCDate(backdated.getUTCDate() - 3);
  const refused = await app.request(
    `http://localhost/api/invoices/${invoice.id}/issue`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        issueDate: backdated.toISOString().slice(0, 10),
      }),
    },
  );
  expect(refused.status).toBe(409);

  const [after] = await db
    .select({ status: schema.invoices.status })
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoice.id));
  // Still a draft, and nothing in the books: the refusal took both halves.
  expect(after?.status).toBe("draft");
  expect(await entriesFor(invoice.id)).toEqual([]);

  await db
    .delete(schema.ledgerSettings)
    .where(eq(schema.ledgerSettings.organizationId, orgId));
});

test("a raised invoice the books refuse is not written at all", async () => {
  const closedThrough = new Date();
  closedThrough.setUTCDate(0);
  await db
    .insert(schema.ledgerSettings)
    .values({ organizationId: orgId, closedThrough })
    .onConflictDoUpdate({
      target: schema.ledgerSettings.organizationId,
      set: { closedThrough },
    });

  const backdated = new Date(closedThrough);
  backdated.setUTCDate(backdated.getUTCDate() - 3);
  const before = await db
    .select({ id: schema.invoices.id })
    .from(schema.invoices)
    .where(eq(schema.invoices.organizationId, orgId));

  const refused = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      issueDate: backdated.toISOString().slice(0, 10),
      lines: [{ description: "Work", quantity: 1, unitPrice: 25_000 }],
    }),
  });
  expect(refused.status).toBe(409);

  const after = await db
    .select({ id: schema.invoices.id })
    .from(schema.invoices)
    .where(eq(schema.invoices.organizationId, orgId));
  expect(after.length).toBe(before.length);

  await db
    .delete(schema.ledgerSettings)
    .where(eq(schema.ledgerSettings.organizationId, orgId));
});

test("no payment against a draft, and none against a void", async () => {
  const stillADraft = await draft();
  const onDraft = await app.request(
    `http://localhost/api/invoices/${stillADraft.id}/payments`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ amountCents: 50_000 }),
    },
  );
  expect(onDraft.status).toBe(409);
  const paidRows = await db
    .select({ id: schema.payments.id })
    .from(schema.payments)
    .where(eq(schema.payments.invoiceId, stillADraft.id));
  expect(paidRows).toEqual([]);

  const voided = await draft();
  await app.request(`http://localhost/api/invoices/${voided.id}/issue`, {
    method: "POST",
    headers,
    body: "{}",
  });
  const voidRes = await app.request(
    `http://localhost/api/invoices/${voided.id}/void`,
    { method: "POST", headers, body: "{}" },
  );
  expect(voidRes.status).toBe(200);

  const onVoid = await app.request(
    `http://localhost/api/invoices/${voided.id}/payments`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ amountCents: 50_000 }),
    },
  );
  expect(onVoid.status).toBe(409);

  // And a credit note against it is refused too: the void already reversed
  // the sale, and a note on top would take the income out twice.
  const credited = await app.request(
    `http://localhost/api/invoices/${voided.id}/credit`,
    { method: "POST", headers, body: JSON.stringify({ amountCents: 1000 }) },
  );
  expect(credited.status).toBe(409);
  const notes = await db
    .select({ id: schema.invoices.id })
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.organizationId, orgId),
        eq(schema.invoices.referenceInvoiceId, voided.id),
      ),
    );
  expect(notes).toEqual([]);
});

test("a credit note and its entry are written together", async () => {
  const invoice = await draft();
  await app.request(`http://localhost/api/invoices/${invoice.id}/issue`, {
    method: "POST",
    headers,
    body: "{}",
  });

  const res = await app.request(
    `http://localhost/api/invoices/${invoice.id}/credit`,
    { method: "POST", headers, body: JSON.stringify({ amountCents: 20_000 }) },
  );
  expect(res.status).toBe(201);
  const { creditNote } = (await res.json()) as { creditNote: { id: string } };

  const entries = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(
      and(
        eq(schema.journalEntries.organizationId, orgId),
        like(schema.journalEntries.source, `credit-note:${creditNote.id}`),
      ),
    );
  expect(entries.length).toBe(1);
  const lines = await db
    .select({
      debitCents: schema.journalLines.debitCents,
      creditCents: schema.journalLines.creditCents,
    })
    .from(schema.journalLines)
    .where(
      inArray(
        schema.journalLines.entryId,
        entries.map((e) => e.id),
      ),
    );
  const debits = lines.reduce((sum, l) => sum + l.debitCents, 0);
  const credits = lines.reduce((sum, l) => sum + l.creditCents, 0);
  expect(debits).toBe(credits);
  expect(credits).toBe(20_000);
});
