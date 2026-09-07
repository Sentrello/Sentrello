import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { resetRateLimits } from "@sentrello/module-sdk";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import invoicing from "./index";

const suffix = crypto.randomUUID().slice(0, 8);
const email = `invoicing-${suffix}@example.test`;
const app = new Hono<SentrelloEnv>();

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
    body: { name: `Invoicing ${suffix}`, slug: `invoicing-${suffix}` },
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
    .values({ organizationId: orgId, name: "Acme Ltd", email: "ap@acme.test" })
    .returning();
  if (!contact) throw new Error("could not create test contact");
  contactId = contact.id;
});

afterAll(async () => {
  const entries = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));
  const entryIds = entries.map((e) => e.id);
  if (entryIds.length > 0) {
    await db
      .delete(schema.journalLines)
      .where(inArray(schema.journalLines.entryId, entryIds));
  }
  const invoices = await db
    .select({ id: schema.invoices.id })
    .from(schema.invoices)
    .where(eq(schema.invoices.organizationId, orgId));
  const invoiceIds = invoices.map((i) => i.id);
  if (invoiceIds.length > 0) {
    await db
      .delete(schema.invoiceLines)
      .where(inArray(schema.invoiceLines.invoiceId, invoiceIds));
  }
  await db
    .delete(schema.recurringProfiles)
    .where(eq(schema.recurringProfiles.organizationId, orgId));
  for (const [table, column] of [
    [schema.journalEntries, schema.journalEntries.organizationId],
    [schema.payments, schema.payments.organizationId],
    [schema.recurringProfiles, schema.recurringProfiles.organizationId],
    // Plans are catalogue items, and the plan tests make one each. Without
    // this they pile up in the shared test database, run after run.
    [schema.billableItems, schema.billableItems.organizationId],
    [schema.taxDefinitions, schema.taxDefinitions.organizationId],
    [schema.documentTemplates, schema.documentTemplates.organizationId],
    [schema.invoices, schema.invoices.organizationId],
    [schema.accounts, schema.accounts.organizationId],
    [schema.contacts, schema.contacts.organizationId],
    [schema.documentCounters, schema.documentCounters.organizationId],
  ] as const) {
    await db.delete(table).where(eq(column, orgId));
  }
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  const [u] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email));
  if (u) {
    await db.delete(schema.session).where(eq(schema.session.userId, u.id));
    await db.delete(schema.account).where(eq(schema.account.userId, u.id));
    await db.delete(schema.user).where(eq(schema.user.id, u.id));
  }
});

async function createInvoice(lines: unknown[], dueDate?: string) {
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({ contactId, currency: "USD", dueDate, lines }),
  });
  return {
    res,
    body: (await res.json()) as {
      invoice: typeof schema.invoices.$inferSelect;
    },
  };
}

test("creating an invoice stores subtotal, tax and total in integer cents", async () => {
  const { res, body } = await createInvoice([
    { description: "Consulting", quantity: 2, unitPrice: 5000, taxRateBp: 875 },
    { description: "Hosting", quantity: 1, unitPrice: 2500, taxRateBp: 0 },
  ]);
  expect(res.status).toBe(201);
  expect(body.invoice.subtotalCents).toBe(12500);
  expect(body.invoice.taxCents).toBe(875);
  expect(body.invoice.totalCents).toBe(13375);
  expect(body.invoice.status).toBe("open");
  expect(body.invoice.number).toMatch(/^INV-\d{4}$/);
  expect(body.invoice.organizationId).toBe(orgId);
});

test("invoice numbers are sequential per organization", async () => {
  const first = await createInvoice([
    { description: "A", quantity: 1, unitPrice: 100, taxRateBp: 0 },
  ]);
  const second = await createInvoice([
    { description: "B", quantity: 1, unitPrice: 100, taxRateBp: 0 },
  ]);
  const n = (s: string) => Number(s.split("-")[1]);
  expect(n(second.body.invoice.number)).toBe(n(first.body.invoice.number) + 1);
});

test("issuing an invoice posts a balanced ledger entry", async () => {
  const { body } = await createInvoice([
    { description: "Work", quantity: 1, unitPrice: 10000, taxRateBp: 1000 },
  ]);

  const [entry] = await db
    .select()
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.source, `invoice:${body.invoice.id}`));
  expect(entry).toBeDefined();
  if (!entry) return;

  const lines = await db
    .select()
    .from(schema.journalLines)
    .where(eq(schema.journalLines.entryId, entry.id));
  const debits = lines.reduce((s, l) => s + l.debitCents, 0);
  const credits = lines.reduce((s, l) => s + l.creditCents, 0);
  expect(debits).toBe(11000);
  expect(credits).toBe(11000);
});

test("a partial payment sets status partial and posts Dr Cash / Cr AR", async () => {
  const { body } = await createInvoice([
    { description: "Retainer", quantity: 1, unitPrice: 10000, taxRateBp: 0 },
  ]);

  const res = await app.request(
    `http://localhost/api/invoices/${body.invoice.id}/payments`,
    { method: "POST", headers, body: JSON.stringify({ amountCents: 2500 }) },
  );
  expect(res.status).toBe(201);
  const paid = (await res.json()) as { status: string; balanceDue: number };
  expect(paid.status).toBe("partial");
  expect(paid.balanceDue).toBe(7500);

  const [stored] = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.id, body.invoice.id));
  expect(stored?.status).toBe("partial");

  const [entry] = await db
    .select()
    .from(schema.journalEntries)
    .where(
      eq(schema.journalEntries.memo, `Payment for ${body.invoice.number}`),
    );
  expect(entry).toBeDefined();
  if (!entry) return;
  const lines = await db
    .select()
    .from(schema.journalLines)
    .where(eq(schema.journalLines.entryId, entry.id));
  expect(lines.reduce((s, l) => s + l.debitCents, 0)).toBe(2500);
  expect(lines.reduce((s, l) => s + l.creditCents, 0)).toBe(2500);
});

test("paying the remainder marks the invoice paid", async () => {
  const { body } = await createInvoice([
    { description: "Deposit", quantity: 1, unitPrice: 4000, taxRateBp: 0 },
  ]);
  const pay = (amountCents: number) =>
    app.request(`http://localhost/api/invoices/${body.invoice.id}/payments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ amountCents }),
    });

  await pay(1000);
  const res = await pay(3000);
  const paid = (await res.json()) as { status: string; balanceDue: number };
  expect(paid.status).toBe("paid");
  expect(paid.balanceDue).toBe(0);
});

test("a non-integer or negative payment is rejected", async () => {
  const { body } = await createInvoice([
    { description: "X", quantity: 1, unitPrice: 1000, taxRateBp: 0 },
  ]);
  for (const amountCents of [12.5, 0, -100]) {
    const res = await app.request(
      `http://localhost/api/invoices/${body.invoice.id}/payments`,
      { method: "POST", headers, body: JSON.stringify({ amountCents }) },
    );
    expect(res.status).toBe(400);
  }
});

test("paying an invoice from another organization is a 404, not a leak", async () => {
  const [foreign] = await db
    .insert(schema.invoices)
    .values({
      organizationId: `other-org-${suffix}`,
      number: "INV-9999",
      status: "open",
      totalCents: 5000,
    })
    .returning();
  if (!foreign) throw new Error("could not create foreign invoice");

  const res = await app.request(
    `http://localhost/api/invoices/${foreign.id}/payments`,
    { method: "POST", headers, body: JSON.stringify({ amountCents: 100 }) },
  );
  expect(res.status).toBe(404);

  await db.delete(schema.invoices).where(eq(schema.invoices.id, foreign.id));
});

test("a customer's portal link shows their invoices and nobody else's", async () => {
  // The people being invoiced have no account: the link is the credential.
  const minted = await app.request(
    `http://localhost/api/contacts/${contactId}/portal-link`,
    { method: "POST", headers },
  );
  expect(minted.status).toBe(200);
  const { url } = (await minted.json()) as { url: string };
  const path = new URL(url).pathname;
  expect(path).toMatch(/^\/portal\/[\w-]{43}$/);

  const [other] = await db
    .insert(schema.contacts)
    .values({
      organizationId: orgId,
      name: "Somebody Else",
      email: `other-${suffix}@example.test`,
    })
    .returning();
  await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId: other?.id,
      currency: "USD",
      lines: [
        {
          description: "Not yours",
          quantity: 1,
          unitPrice: 99900,
          taxRateBp: 0,
        },
      ],
    }),
  });

  const page = await app.request(`http://localhost${path}`);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");
  const body = await page.text();
  expect(body).toContain("Acme Ltd");
  expect(body).not.toContain("Somebody Else");
  expect(body).not.toContain("$999.00");
});

test("a guessed portal link is a 404, and rotating revokes the old one", async () => {
  const first = await app.request(
    `http://localhost/api/contacts/${contactId}/portal-link`,
    { method: "POST", headers },
  );
  const oldPath = new URL(((await first.json()) as { url: string }).url)
    .pathname;

  const guess = await app.request(`http://localhost/portal/${"z".repeat(43)}`);
  expect(guess.status).toBe(404);
  expect((await app.request("http://localhost/portal/short")).status).toBe(404);

  const rotated = await app.request(
    `http://localhost/api/contacts/${contactId}/portal-link?rotate=1`,
    { method: "POST", headers },
  );
  const newPath = new URL(((await rotated.json()) as { url: string }).url)
    .pathname;

  expect(newPath).not.toBe(oldPath);
  expect((await app.request(`http://localhost${oldPath}`)).status).toBe(404);
  expect((await app.request(`http://localhost${newPath}`)).status).toBe(200);
});

test("sending the link needs somewhere to send it", async () => {
  const [noEmail] = await db
    .insert(schema.contacts)
    .values({ organizationId: orgId, name: "No address" })
    .returning();

  const res = await app.request(
    `http://localhost/api/contacts/${noEmail?.id}/portal-link?send=1`,
    { method: "POST", headers },
  );
  expect(res.status).toBe(400);

  // the link still exists — the business can copy it by hand
  const copied = await app.request(
    `http://localhost/api/contacts/${noEmail?.id}/portal-link`,
    { method: "POST", headers },
  );
  expect(copied.status).toBe(200);
  await db
    .delete(schema.contacts)
    .where(eq(schema.contacts.id, noEmail?.id ?? ""));
});

/** A quote the business has sent, ready for an answer. */
async function sentQuote(forContactId: string, totalCents = 45000) {
  const res = await app.request("http://localhost/api/quotes", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId: forContactId,
      currency: "USD",
      lines: [
        {
          description: "Fitted shelving",
          quantity: 1,
          unitPrice: totalCents,
          taxRateBp: 0,
        },
      ],
    }),
  });
  const { quote } = (await res.json()) as { quote: { id: string } };
  await db
    .update(schema.quotes)
    .set({ status: "sent" })
    .where(eq(schema.quotes.id, quote.id));
  return quote.id;
}

const ledgerFor = async (source: string) => {
  const [entry] = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.source, source));
  if (!entry) return [];
  return db
    .select({
      debitCents: schema.journalLines.debitCents,
      creditCents: schema.journalLines.creditCents,
    })
    .from(schema.journalLines)
    .where(eq(schema.journalLines.entryId, entry.id));
};

test("one invoice comes back with its lines, payments and true balance", async () => {
  const created = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "USD",
      lines: [
        {
          description: "Fitting",
          quantity: 2,
          unitPrice: 5000,
          taxRateBp: 875,
        },
        {
          description: "Materials",
          quantity: 1,
          unitPrice: 2500,
          taxRateBp: 0,
        },
      ],
    }),
  });
  const { invoice } = (await created.json()) as { invoice: { id: string } };

  await app.request(`http://localhost/api/invoices/${invoice.id}/payments`, {
    method: "POST",
    headers,
    body: JSON.stringify({ amountCents: 5000, method: "bank" }),
  });

  const res = await app.request(`http://localhost/api/invoices/${invoice.id}`, {
    headers,
  });
  expect(res.status).toBe(200);
  const detail = (await res.json()) as {
    lines: unknown[];
    payments: unknown[];
    paidCents: number;
    balanceDue: number;
    computedStatus: string;
    invoice: { totalCents: number };
  };

  expect(detail.lines).toHaveLength(2);
  expect(detail.payments).toHaveLength(1);
  expect(detail.paidCents).toBe(5000);
  // 2×50.00 at 8.75% = 108.75, plus 25.00 = 133.75, less 50.00 paid
  expect(detail.invoice.totalCents).toBe(13375);
  expect(detail.balanceDue).toBe(8375);
  expect(detail.computedStatus).toBe("partial");
});

test("another organization's invoice is a 404, not a detail page", async () => {
  const [foreign] = await db
    .insert(schema.invoices)
    .values({
      organizationId: `org_other_${suffix}`,
      number: `INV-PRIVATE-${suffix}`,
      status: "open",
      currency: "USD",
      subtotalCents: 5000,
      taxCents: 0,
      totalCents: 5000,
    })
    .returning();

  const res = await app.request(
    `http://localhost/api/invoices/${foreign?.id}`,
    {
      headers,
    },
  );
  expect(res.status).toBe(404);
  await db
    .delete(schema.invoices)
    .where(eq(schema.invoices.id, foreign?.id ?? ""));
});

test("sending an invoice records it on the timeline and links the portal", async () => {
  // The template existed and nothing called it: a business could raise an
  // invoice and had no way to deliver it.
  const created = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "USD",
      lines: [
        {
          description: "Sent work",
          quantity: 1,
          unitPrice: 15000,
          taxRateBp: 0,
        },
      ],
    }),
  });
  const { invoice } = (await created.json()) as {
    invoice: { id: string; number: string };
  };

  const res = await app.request(
    `http://localhost/api/invoices/${invoice.id}/send`,
    { method: "POST", headers },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { sent: boolean; to: string };
  expect(body.sent).toBe(true);

  // sending mints the customer's portal token if they had none
  const [contact] = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.id, contactId));
  expect(contact?.portalToken).toBeTruthy();

  const timeline = await db
    .select()
    .from(schema.activities)
    .where(eq(schema.activities.contactId, contactId));
  expect(
    timeline.some((a) => a.body?.includes(`Sent invoice ${invoice.number}`)),
  ).toBe(true);
});

test("an invoice with no customer, or a customer with no address, cannot be sent", async () => {
  const [orphan] = await db
    .insert(schema.invoices)
    .values({
      organizationId: orgId,
      number: `INV-ORPHAN-${suffix}`,
      status: "open",
      currency: "USD",
      subtotalCents: 1000,
      taxCents: 0,
      totalCents: 1000,
    })
    .returning();
  expect(
    (
      await app.request(`http://localhost/api/invoices/${orphan?.id}/send`, {
        method: "POST",
        headers,
      })
    ).status,
  ).toBe(400);

  const [silent] = await db
    .insert(schema.contacts)
    .values({ organizationId: orgId, name: "No address" })
    .returning();
  const [theirs] = await db
    .insert(schema.invoices)
    .values({
      organizationId: orgId,
      contactId: silent?.id,
      number: `INV-SILENT-${suffix}`,
      status: "open",
      currency: "USD",
      subtotalCents: 1000,
      taxCents: 0,
      totalCents: 1000,
    })
    .returning();
  expect(
    (
      await app.request(`http://localhost/api/invoices/${theirs?.id}/send`, {
        method: "POST",
        headers,
      })
    ).status,
  ).toBe(400);
});

test("sending another organization's invoice is a 404", async () => {
  const [foreign] = await db
    .insert(schema.invoices)
    .values({
      organizationId: `org_other_${suffix}`,
      number: `INV-FOREIGN-${suffix}`,
      status: "open",
      currency: "USD",
      subtotalCents: 1000,
      taxCents: 0,
      totalCents: 1000,
    })
    .returning();

  const res = await app.request(
    `http://localhost/api/invoices/${foreign?.id}/send`,
    { method: "POST", headers },
  );
  expect(res.status).toBe(404);
  await db
    .delete(schema.invoices)
    .where(eq(schema.invoices.id, foreign?.id ?? ""));
});

test("sending a quote marks it sent, which is what the customer can see", async () => {
  const quoteId = await sentQuote(contactId, 33000);
  // sentQuote sets the status directly; here we exercise the real path
  await db
    .update(schema.quotes)
    .set({ status: "draft" })
    .where(eq(schema.quotes.id, quoteId));

  const res = await app.request(`http://localhost/api/quotes/${quoteId}/send`, {
    method: "POST",
    headers,
  });
  expect(res.status).toBe(200);

  const [quote] = await db
    .select()
    .from(schema.quotes)
    .where(eq(schema.quotes.id, quoteId));
  expect(quote?.status).toBe("sent");

  const timeline = await db
    .select()
    .from(schema.activities)
    .where(eq(schema.activities.contactId, contactId));
  expect(
    timeline.some((a) => a.body?.includes(`Sent quote ${quote?.number}`)),
  ).toBe(true);
});

test("a quote with no customer cannot be sent", async () => {
  const created = await app.request("http://localhost/api/quotes", {
    method: "POST",
    headers,
    body: JSON.stringify({
      currency: "USD",
      lines: [
        {
          description: "Nobody's work",
          quantity: 1,
          unitPrice: 100,
          taxRateBp: 0,
        },
      ],
    }),
  });
  const { quote } = (await created.json()) as { quote: { id: string } };

  const res = await app.request(
    `http://localhost/api/quotes/${quote.id}/send`,
    {
      method: "POST",
      headers,
    },
  );
  expect(res.status).toBe(400);
});

test("the quote list is this organization's only", async () => {
  const res = await app.request("http://localhost/api/quotes", { headers });
  const { quotes } = (await res.json()) as {
    quotes: { organizationId: string }[];
  };
  expect(quotes.length).toBeGreaterThan(0);
  expect(quotes.every((q) => q.organizationId === orgId)).toBe(true);
});

test("a customer accepting a quote raises an invoice that reaches the books", async () => {
  // Converting a quote used to create the invoice and post nothing, so the
  // revenue existed on the document and nowhere in the accounts.
  const quoteId = await sentQuote(contactId);
  const minted = await app.request(
    `http://localhost/api/contacts/${contactId}/portal-link`,
    { method: "POST", headers },
  );
  const token = new URL(((await minted.json()) as { url: string }).url).pathname
    .split("/")
    .pop() as string;

  const res = await app.request(
    `http://localhost/portal/${token}/quotes/${quoteId}/accept`,
    { method: "POST" },
  );
  expect(res.status).toBe(303);

  const [quote] = await db
    .select()
    .from(schema.quotes)
    .where(eq(schema.quotes.id, quoteId));
  expect(quote?.status).toBe("accepted");

  const [invoice] = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.quoteId, quoteId));
  expect(invoice?.totalCents).toBe(45000);
  // An invoice with no due date can never be late, so it never appears on the
  // list of who owes you.
  expect(invoice?.dueDate).not.toBeNull();
  expect(invoice?.dueDate?.getTime()).toBeGreaterThan(Date.now());

  const lines = await ledgerFor(`invoice:${invoice?.id}`);
  expect(lines.length).toBeGreaterThan(0);
  const debits = lines.reduce((sum, l) => sum + l.debitCents, 0);
  const credits = lines.reduce((sum, l) => sum + l.creditCents, 0);
  expect(debits).toBe(credits);
  expect(debits).toBe(45000);
});

test("a quote cannot be accepted twice", async () => {
  // Twice would mean two invoices for one piece of work.
  const quoteId = await sentQuote(contactId, 12000);
  const minted = await app.request(
    `http://localhost/api/contacts/${contactId}/portal-link`,
    { method: "POST", headers },
  );
  const token = new URL(((await minted.json()) as { url: string }).url).pathname
    .split("/")
    .pop() as string;

  const first = await app.request(
    `http://localhost/portal/${token}/quotes/${quoteId}/accept`,
    { method: "POST" },
  );
  expect(first.status).toBe(303);

  const again = await app.request(
    `http://localhost/portal/${token}/quotes/${quoteId}/accept`,
    { method: "POST" },
  );
  expect(again.status).toBe(404);

  const invoices = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.quoteId, quoteId));
  expect(invoices).toHaveLength(1);
});

test("a customer cannot accept somebody else's quote", async () => {
  const [other] = await db
    .insert(schema.contacts)
    .values({
      organizationId: orgId,
      name: "Another customer",
      email: `another-${suffix}@example.test`,
    })
    .returning();
  const theirQuote = await sentQuote(other?.id ?? "", 88800);

  const minted = await app.request(
    `http://localhost/api/contacts/${contactId}/portal-link`,
    { method: "POST", headers },
  );
  const token = new URL(((await minted.json()) as { url: string }).url).pathname
    .split("/")
    .pop() as string;

  const res = await app.request(
    `http://localhost/portal/${token}/quotes/${theirQuote}/accept`,
    { method: "POST" },
  );
  expect(res.status).toBe(404);

  const invoices = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.quoteId, theirQuote));
  expect(invoices).toHaveLength(0);
});

test("minting a link for another organization's contact is a 404", async () => {
  const [foreign] = await db
    .insert(schema.contacts)
    .values({ organizationId: `org_other_${suffix}`, name: "Not yours" })
    .returning();

  const res = await app.request(
    `http://localhost/api/contacts/${foreign?.id}/portal-link`,
    { method: "POST", headers },
  );
  expect(res.status).toBe(404);
  await db
    .delete(schema.contacts)
    .where(eq(schema.contacts.id, foreign?.id ?? ""));
});

test("the invoice list only returns this organization's rows", async () => {
  const res = await app.request("http://localhost/api/invoices", { headers });
  const body = (await res.json()) as {
    invoices: { organizationId: string }[];
  };
  expect(body.invoices.length).toBeGreaterThan(0);
  expect(body.invoices.every((i) => i.organizationId === orgId)).toBe(true);
});

/**
 * The shape a client gets wrong most often is the field names on a line.
 *
 * A line with no price at all used to multiply out to NaN, reach Postgres,
 * and come back as a bare 500 with a stack trace in the logs — no indication
 * of which field was wrong.
 */
test("a malformed invoice line is a 400 that names the problem", async () => {
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "USD",
      lines: [
        {
          description: "Consumer unit replacement",
          quantity: 1,
          // The price under no name this accepts.
          priceInPennies: 48500,
        },
      ],
    }),
  });

  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toContain("unitPrice");
  expect(body.error).toContain("line 1");
});

test("a price may be sent under either name", async () => {
  // `unitPrice` is what the recurring job and the other modules have always
  // sent; `unitPriceCents` is the clearer name and what the column is called.
  // Refusing either would have broken callers that have worked for months.
  for (const field of ["unitPrice", "unitPriceCents"]) {
    const res = await app.request("http://localhost/api/invoices", {
      method: "POST",
      headers,
      body: JSON.stringify({
        contactId,
        currency: "USD",
        lines: [
          { description: `Priced by ${field}`, quantity: 1, [field]: 1000 },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { invoice: { totalCents: number } };
    expect(body.invoice.totalCents).toBe(1000);
  }
});

test("a malformed quote line is refused the same way", async () => {
  const res = await app.request("http://localhost/api/quotes", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      lines: [{ description: "Survey", quantity: 1, unitPrice: "500" }],
    }),
  });
  expect(res.status).toBe(400);
});

test("a rejected invoice leaves nothing behind", async () => {
  const before = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.organizationId, orgId));

  await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      // Refused for the price it does not carry, so nothing should be written.
      lines: [{ description: "Bad", quantity: 1, priceInPennies: 100 }],
    }),
  });

  const after = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.organizationId, orgId));
  expect(after).toHaveLength(before.length);
});

/**
 * An invoice with no due date is invisible to overdue chasing.
 *
 * `sendOverdueReminders` filters on `dueDate is not null`, so an invoice
 * created without one can never age, never be chased and never appear in
 * receivables with a meaningful age — it is simply money the business is never
 * reminded to ask for. The form left the field blank and optional.
 */
test("an invoice created without a due date still gets one", async () => {
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "USD",
      lines: [
        {
          description: "No terms given",
          quantity: 1,
          unitPrice: 5000,
          taxRateBp: 0,
        },
      ],
    }),
  });
  expect(res.status).toBe(201);

  const { invoice } = (await res.json()) as { invoice: { id: string } };
  const [row] = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoice.id));

  const dueDate = row?.dueDate;
  if (!dueDate) throw new Error("an invoice must carry a due date");
  // Thirty days, give or take the time the test takes to run.
  const days = (dueDate.getTime() - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(29);
  expect(days).toBeLessThan(31);
});

test("a due date the business chose is kept", async () => {
  const chosen = "2027-02-01";
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "USD",
      dueDate: chosen,
      lines: [
        { description: "Net 14", quantity: 1, unitPrice: 5000, taxRateBp: 0 },
      ],
    }),
  });
  const { invoice } = (await res.json()) as { invoice: { id: string } };
  const [row] = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoice.id));
  expect(row?.dueDate?.toISOString().slice(0, 10)).toBe(chosen);
});

/**
 * The customer portal is a public path that does database work on every hit,
 * on a box that is often the smallest one the customer could rent. Scheduling,
 * the shop and forms all carry a limit; this one did not.
 */
test("the customer portal stops answering a flood", async () => {
  resetRateLimits();
  const codes = new Set<number>();
  for (let i = 0; i < 35; i += 1) {
    const res = await app.request("http://localhost/portal/not-a-real-token", {
      headers: { "x-real-ip": "203.0.113.9" },
    });
    codes.add(res.status);
  }
  expect(codes.has(429)).toBe(true);
  resetRateLimits();
});

test("a wrong token is refused the same way whether or not it exists", async () => {
  // The reply must not tell an attacker they got closer.
  resetRateLimits();
  const missing = await app.request(
    "http://localhost/portal/aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  const malformed = await app.request("http://localhost/portal/short");
  expect(missing.status).toBe(malformed.status);
  resetRateLimits();
});

/**
 * An invoice with no due date can never be late.
 *
 * It sits outside every aging bucket, the overdue chase skips it, and it never
 * reaches the dashboard's overdue figure — so it is money the business is
 * never reminded to ask for. Found by converting a quote the way somebody
 * would on their first afternoon: the portal's acceptance path set a date and
 * the staff conversion did not, which meant which screen accepted the work
 * decided whether the bill would ever be chased.
 */
test("converting a quote produces an invoice that can be chased", async () => {
  const quoted = await app.request("http://localhost/api/quotes", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "USD",
      lines: [
        {
          description: "Oak worktop",
          quantity: 1,
          unitPrice: 128000,
          taxRateBp: 875,
        },
      ],
    }),
  });
  const { quote } = (await quoted.json()) as { quote: { id: string } };

  const converted = await app.request(
    `http://localhost/api/quotes/${quote.id}/convert`,
    { method: "POST", headers },
  );
  const { invoice } = (await converted.json()) as {
    invoice: { dueDate: string | null };
  };

  expect(invoice.dueDate).not.toBeNull();
  const days = Math.round(
    (new Date(invoice.dueDate as string).getTime() - Date.now()) / 86_400_000,
  );
  expect(days).toBe(30);
});

// ---------------------------------------------------------------------------
// Drafts, discounts and the banded tax
// ---------------------------------------------------------------------------

/**
 * A draft is not an accounting event.
 *
 * The reference lets an invoice be drafted, corrected, and only then sent —
 * which is how people actually work. Posting a journal entry for something
 * nobody has seen puts revenue in the books that may never be earned, and
 * removing it afterwards means a reversal for a document that never existed.
 */
test("a draft invoice writes nothing to the ledger", async () => {
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "USD",
      status: "draft",
      lines: [{ description: "Not sent yet", quantity: 1, unitPrice: 25_000 }],
    }),
  });
  expect(res.status).toBe(201);
  const { invoice } = (await res.json()) as {
    invoice: { id: string; status: string };
  };
  expect(invoice.status).toBe("draft");

  const entries = await db
    .select()
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.source, `invoice:${invoice.id}`));
  expect(entries).toHaveLength(0);
});

test("an invoice raised outright does post to the ledger", async () => {
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "USD",
      lines: [{ description: "Issued now", quantity: 1, unitPrice: 25_000 }],
    }),
  });
  const { invoice } = (await res.json()) as { invoice: { id: string } };

  const entries = await db
    .select()
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.source, `invoice:${invoice.id}`));
  expect(entries).toHaveLength(1);
});

test("a discount comes off the income posted, not off nothing", async () => {
  // The discount never gets its own ledger line. It has already come off the
  // subtotal, and posting it separately would record revenue the business
  // never earned and then contra it — which reads as a refund on every report
  // that counts them.
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "USD",
      discountType: "percent",
      discountValue: 1000, // 10%
      lines: [
        {
          description: "Discounted",
          quantity: 1,
          unitPrice: 10_000,
          taxRateBp: 0,
        },
      ],
    }),
  });
  const { invoice } = (await res.json()) as {
    invoice: {
      id: string;
      subtotalCents: number;
      discountCents: number;
      totalCents: number;
    };
  };
  expect(invoice.subtotalCents).toBe(10_000);
  expect(invoice.discountCents).toBe(1000);
  expect(invoice.totalCents).toBe(9000);

  const [entry] = await db
    .select()
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.source, `invoice:${invoice.id}`));
  const lines = await db
    .select()
    .from(schema.journalLines)
    .where(eq(schema.journalLines.entryId, entry?.id ?? ""));

  const debits = lines.reduce((sum, l) => sum + l.debitCents, 0);
  const credits = lines.reduce((sum, l) => sum + l.creditCents, 0);
  expect(debits).toBe(credits);
  expect(debits).toBe(9000);
});

test("an invoice stores its tax banded by rate", async () => {
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "USD",
      lines: [
        {
          description: "Standard",
          quantity: 1,
          unitPrice: 10_000,
          taxRateBp: 2000,
        },
        {
          description: "Also standard",
          quantity: 1,
          unitPrice: 5000,
          taxRateBp: 2000,
        },
        {
          description: "Reduced",
          quantity: 1,
          unitPrice: 10_000,
          taxRateBp: 500,
        },
      ],
    }),
  });
  const { invoice } = (await res.json()) as {
    invoice: { id: string; taxCents: number };
  };

  const bands = await db
    .select()
    .from(schema.documentTaxes)
    .where(eq(schema.documentTaxes.documentId, invoice.id));

  // Two bands, not three: two lines at the same rate are one line on a tax
  // return, which is the whole reason this is stored rather than derived.
  expect(bands).toHaveLength(2);
  const standard = bands.find((b) => b.rateBp === 2000);
  expect(standard?.taxableCents).toBe(15_000);
  expect(standard?.taxCents).toBe(3000);

  // And the bands add up to what the document says it charged.
  expect(bands.reduce((sum, b) => sum + b.taxCents, 0)).toBe(invoice.taxCents);
});

test("a tax rate belonging to another business is refused", async () => {
  // Charging no tax by accident is the expensive direction, so an unknown
  // definition is a refusal rather than a silent zero.
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "USD",
      lines: [
        {
          description: "Someone else's rate",
          quantity: 1,
          unitPrice: 1000,
          taxDefinitionId: "00000000-0000-0000-0000-000000000009",
        },
      ],
    }),
  });
  expect(res.status).toBe(400);
});

test("a fractional quantity survives being stored", async () => {
  // "1.5 hours" is an ordinary line on a service invoice, and an integer
  // quantity forces the business to fake it in the price.
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "USD",
      lines: [
        {
          description: "Site visit",
          quantityMilli: 1500,
          unitPrice: 6000,
          unit: "hour",
          taxRateBp: 0,
        },
      ],
    }),
  });
  const { invoice } = (await res.json()) as {
    invoice: { id: string; totalCents: number };
  };
  expect(invoice.totalCents).toBe(9000);

  const [line] = await db
    .select()
    .from(schema.invoiceLines)
    .where(eq(schema.invoiceLines.invoiceId, invoice.id));
  expect(line?.quantityMilli).toBe(1500);
  expect(line?.unit).toBe("hour");
});

// ---------------------------------------------------------------------------
// The lifecycle: issue, copy, void, credit
// ---------------------------------------------------------------------------

/** A draft with one line, for the lifecycle tests to act on. */
async function draftInvoice(unitPrice = 20_000): Promise<{
  id: string;
  number: string;
  totalCents: number;
}> {
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "USD",
      status: "draft",
      lines: [
        { description: "Work done", quantity: 1, unitPrice, taxRateBp: 0 },
      ],
    }),
  });
  const { invoice } = (await res.json()) as {
    invoice: { id: string; number: string; totalCents: number };
  };
  return invoice;
}

const entriesFor = (source: string) =>
  db
    .select()
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.source, source));

test("issuing a draft is what puts it in the books", async () => {
  const draft = await draftInvoice();
  expect(await entriesFor(`invoice:${draft.id}`)).toHaveLength(0);

  const res = await app.request(
    `http://localhost/api/invoices/${draft.id}/issue`,
    { method: "POST", headers },
  );
  expect(res.status).toBe(200);
  expect(await entriesFor(`invoice:${draft.id}`)).toHaveLength(1);
});

/**
 * Issuing something that was raised weeks ago.
 *
 * A business adopting Sentrello halfway through its year has a back catalogue
 * to load, and revenue that belongs to June has to post to June or every
 * report built on the ledger is wrong for as long as the year lasts.
 */
test("an invoice issued with a past date posts to that month", async () => {
  const draft = await draftInvoice(50_000);
  const when = "2026-06-15";

  const res = await app.request(
    `http://localhost/api/invoices/${draft.id}/issue`,
    { method: "POST", headers, body: JSON.stringify({ issueDate: when }) },
  );
  expect(res.status).toBe(200);

  const [entry] = await entriesFor(`invoice:${draft.id}`);
  expect(entry).toBeDefined();
  expect(entry?.postedAt.toISOString().slice(0, 7)).toBe("2026-06");

  // The document agrees with the books it produced.
  const [row] = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.id, draft.id));
  expect(row?.issueDate?.toISOString().slice(0, 10)).toBe(when);
});

test("a backdated entry still balances", async () => {
  // The whole point of the ledger. Backdating moves an entry, never unbalances
  // one.
  const draft = await draftInvoice(37_500);
  await app.request(`http://localhost/api/invoices/${draft.id}/issue`, {
    method: "POST",
    headers,
    body: JSON.stringify({ issueDate: "2026-07-02" }),
  });

  const [entry] = await entriesFor(`invoice:${draft.id}`);
  if (!entry) throw new Error("the backdated invoice posted no entry");
  const lines = await db
    .select()
    .from(schema.journalLines)
    .where(eq(schema.journalLines.entryId, entry.id));

  const debits = lines.reduce((sum, line) => sum + line.debitCents, 0);
  const credits = lines.reduce((sum, line) => sum + line.creditCents, 0);
  expect(debits).toBe(credits);
  expect(debits).toBe(37_500);
});

test("an invoice cannot be issued into the future", async () => {
  // Revenue that has not happened yet. Every report downstream would carry it.
  const draft = await draftInvoice();
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

  const res = await app.request(
    `http://localhost/api/invoices/${draft.id}/issue`,
    { method: "POST", headers, body: JSON.stringify({ issueDate: tomorrow }) },
  );
  expect(res.status).toBe(400);
  expect(await entriesFor(`invoice:${draft.id}`)).toHaveLength(0);
});

/**
 * The path most invoices actually take.
 *
 * The web form saves straight to "open" — a draft is the exception, not the
 * rule — and that route already accepted a back-dated issue date for a
 * business loading its catalogue. It then posted every one of those entries
 * with today's date, so the document said June and the ledger said today.
 */
test("an invoice raised open on a past date posts to that month", async () => {
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "USD",
      issueDate: "2026-06-20",
      lines: [
        {
          description: "June work",
          quantity: 1,
          unitPrice: 44_000,
          taxRateBp: 0,
        },
      ],
    }),
  });
  expect(res.status).toBe(201);
  const { invoice } = (await res.json()) as { invoice: { id: string } };

  const [entry] = await entriesFor(`invoice:${invoice.id}`);
  expect(entry).toBeDefined();
  expect(entry?.postedAt.toISOString().slice(0, 7)).toBe("2026-06");
});

test("issuing with no date still means today", async () => {
  // The overwhelmingly common case, and the one that must not have changed.
  const draft = await draftInvoice(12_000);
  const res = await app.request(
    `http://localhost/api/invoices/${draft.id}/issue`,
    { method: "POST", headers },
  );
  expect(res.status).toBe(200);

  const [entry] = await entriesFor(`invoice:${draft.id}`);
  const today = new Date().toISOString().slice(0, 10);
  expect(entry?.postedAt.toISOString().slice(0, 10)).toBe(today);
});

test("a draft cannot be issued twice", async () => {
  // Otherwise the same revenue is recorded as many times as somebody clicks.
  const draft = await draftInvoice();
  await app.request(`http://localhost/api/invoices/${draft.id}/issue`, {
    method: "POST",
    headers,
  });
  const again = await app.request(
    `http://localhost/api/invoices/${draft.id}/issue`,
    { method: "POST", headers },
  );
  expect(again.status).toBe(409);
  expect(await entriesFor(`invoice:${draft.id}`)).toHaveLength(1);
});

test("a copy is a fresh draft with its own number", async () => {
  const source = await draftInvoice(33_300);
  await app.request(`http://localhost/api/invoices/${source.id}/issue`, {
    method: "POST",
    headers,
  });

  const res = await app.request(
    `http://localhost/api/invoices/${source.id}/duplicate`,
    { method: "POST", headers },
  );
  expect(res.status).toBe(201);
  const { invoice } = (await res.json()) as {
    invoice: { id: string; number: string; status: string; totalCents: number };
  };

  expect(invoice.status).toBe("draft");
  expect(invoice.number).not.toBe(source.number);
  expect(invoice.totalCents).toBe(source.totalCents);

  // The copy is a draft, so it is not in the books until somebody issues it.
  expect(await entriesFor(`invoice:${invoice.id}`)).toHaveLength(0);

  const lines = await db
    .select()
    .from(schema.invoiceLines)
    .where(eq(schema.invoiceLines.invoiceId, invoice.id));
  expect(lines).toHaveLength(1);
});

test("voiding an issued invoice reverses it rather than deleting it", async () => {
  // A gap in an invoice sequence is the first thing an auditor asks about.
  const draft = await draftInvoice(15_000);
  await app.request(`http://localhost/api/invoices/${draft.id}/issue`, {
    method: "POST",
    headers,
  });

  const res = await app.request(
    `http://localhost/api/invoices/${draft.id}/void`,
    { method: "POST", headers },
  );
  expect(res.status).toBe(200);

  const [row] = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.id, draft.id));
  expect(row?.status).toBe("void");
  expect(row?.number).toBe(draft.number);

  // Both entries stand, and together they cancel.
  const issued = await entriesFor(`invoice:${draft.id}`);
  const reversal = await entriesFor(`invoice-void:${draft.id}`);
  expect(issued).toHaveLength(1);
  expect(reversal).toHaveLength(1);
});

test("an invoice with money against it is credited, not voided", async () => {
  // Pretending a paid invoice never happened loses the payment.
  const draft = await draftInvoice(10_000);
  await app.request(`http://localhost/api/invoices/${draft.id}/issue`, {
    method: "POST",
    headers,
  });
  await app.request(`http://localhost/api/invoices/${draft.id}/payments`, {
    method: "POST",
    headers,
    body: JSON.stringify({ amountCents: 4000 }),
  });

  const refused = await app.request(
    `http://localhost/api/invoices/${draft.id}/void`,
    { method: "POST", headers },
  );
  expect(refused.status).toBe(409);
  expect((await refused.json()).error).toContain("credit note");

  const credited = await app.request(
    `http://localhost/api/invoices/${draft.id}/credit`,
    { method: "POST", headers, body: JSON.stringify({ amountCents: 4000 }) },
  );
  expect(credited.status).toBe(201);
  const { creditNote } = (await credited.json()) as {
    creditNote: { id: string; kind: string; referenceInvoiceId: string };
  };
  expect(creditNote.kind).toBe("credit_note");
  expect(creditNote.referenceInvoiceId).toBe(draft.id);
  expect(await entriesFor(`credit-note:${creditNote.id}`)).toHaveLength(1);
});

test("a credit note cannot be larger than what it credits", async () => {
  // More than the invoice is a payment to the customer, not a credit.
  const draft = await draftInvoice(5000);
  await app.request(`http://localhost/api/invoices/${draft.id}/issue`, {
    method: "POST",
    headers,
  });
  const res = await app.request(
    `http://localhost/api/invoices/${draft.id}/credit`,
    { method: "POST", headers, body: JSON.stringify({ amountCents: 999_999 }) },
  );
  expect(res.status).toBe(400);
});

test("a share link is minted once and kept, unless it is rotated", async () => {
  // A link already sent has to keep working; rotating is what to do when one
  // has gone somewhere it should not have.
  const draft = await draftInvoice();
  const first = await app.request(
    `http://localhost/api/invoices/${draft.id}/share`,
    { method: "POST", headers },
  );
  const a = (await first.json()) as { url: string };

  const second = await app.request(
    `http://localhost/api/invoices/${draft.id}/share`,
    { method: "POST", headers },
  );
  expect(((await second.json()) as { url: string }).url).toBe(a.url);

  const rotated = await app.request(
    `http://localhost/api/invoices/${draft.id}/share?rotate=1`,
    { method: "POST", headers },
  );
  expect(((await rotated.json()) as { url: string }).url).not.toBe(a.url);
});

// ---------------------------------------------------------------------------
// The shared document, and the read receipt
// ---------------------------------------------------------------------------

async function sharedInvoice(): Promise<{ id: string; url: string }> {
  const draft = await draftInvoice(12_500);
  await app.request(`http://localhost/api/invoices/${draft.id}/issue`, {
    method: "POST",
    headers,
  });
  const res = await app.request(
    `http://localhost/api/invoices/${draft.id}/share`,
    { method: "POST", headers },
  );
  const { url } = (await res.json()) as { url: string };
  return { id: draft.id, url };
}

test("a shared invoice opens for somebody with no account", async () => {
  const { url } = await sharedInvoice();
  const res = await app.request(url);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Invoice");
  expect(html).toContain("125.00");
});

test("opening it records that they saw it, and when they first did", async () => {
  // "I never received it" is the most common thing said on a chasing call.
  const { id, url } = await sharedInvoice();

  const before = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.id, id));
  expect(before[0]?.firstViewedAt).toBeNull();
  expect(before[0]?.viewCount).toBe(0);

  await app.request(url);
  const [first] = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.id, id));
  expect(first?.firstViewedAt).toBeTruthy();
  expect(first?.viewCount).toBe(1);

  // Opening it again counts, but the first time is not overwritten — the
  // question a business asks is "did they ever see it".
  await app.request(url);
  const [second] = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.id, id));
  expect(second?.viewCount).toBe(2);
  expect(second?.firstViewedAt?.getTime()).toBe(
    first?.firstViewedAt?.getTime(),
  );
  expect(second?.lastViewedAt).toBeTruthy();
});

test("unsharing takes it offline without losing the link", async () => {
  const { id, url } = await sharedInvoice();
  expect((await app.request(url)).status).toBe(200);

  await app.request(`http://localhost/api/invoices/${id}/unshare`, {
    method: "POST",
    headers,
  });
  expect((await app.request(url)).status).toBe(404);

  // And sharing again gives back the same address, so anything already sent
  // starts working again rather than needing to be resent.
  const again = await app.request(`http://localhost/api/invoices/${id}/share`, {
    method: "POST",
    headers,
  });
  expect(((await again.json()) as { url: string }).url).toBe(url);
});

test("a guessed token is a 404, not a hint", async () => {
  // Telling somebody a token is real but not for them is telling them
  // something. Both answers are the same.
  const short = await app.request("http://localhost/share/invoice/abc");
  expect(short.status).toBe(404);

  const long = await app.request(
    `http://localhost/share/invoice/${"0".repeat(48)}`,
  );
  expect(long.status).toBe(404);
});

test("a draft is never readable on a link", async () => {
  // Sharing publishes; a draft that was shared and then reverted must not
  // stay open to whoever has the address.
  const draft = await draftInvoice();
  const res = await app.request(
    `http://localhost/api/invoices/${draft.id}/share`,
    { method: "POST", headers },
  );
  const { url } = (await res.json()) as { url: string };

  await app.request(`http://localhost/api/invoices/${draft.id}/unshare`, {
    method: "POST",
    headers,
  });
  expect((await app.request(url)).status).toBe(404);
});

test("a draft owes nothing, because nobody has been asked", async () => {
  // The figure in the "owed" column is the one people quote to an accountant.
  // A draft's total sitting in it is money the business has no claim to.
  const draft = await draftInvoice(50_000);
  const res = await app.request("http://localhost/api/invoices?tab=draft", {
    headers,
  });
  const { invoices } = (await res.json()) as {
    invoices: { id: string; totalCents: number; balanceCents: number }[];
  };
  const mine = invoices.find((i) => i.id === draft.id);
  expect(mine?.totalCents).toBe(50_000);
  expect(mine?.balanceCents).toBe(0);
});

test("an issued invoice does owe, and paying it clears the balance", async () => {
  const draft = await draftInvoice(30_000);
  await app.request(`http://localhost/api/invoices/${draft.id}/issue`, {
    method: "POST",
    headers,
  });

  const owing = async () => {
    const res = await app.request("http://localhost/api/invoices?tab=all", {
      headers,
    });
    const { invoices } = (await res.json()) as {
      invoices: { id: string; balanceCents: number }[];
    };
    return invoices.find((i) => i.id === draft.id)?.balanceCents;
  };

  expect(await owing()).toBe(30_000);
  await app.request(`http://localhost/api/invoices/${draft.id}/payments`, {
    method: "POST",
    headers,
    body: JSON.stringify({ amountCents: 10_000 }),
  });
  expect(await owing()).toBe(20_000);
});

test("the tab counts add up to what the tabs actually hold", async () => {
  // The counts are what the screen leads with; a count that disagrees with
  // the list under it is worse than no count.
  const { counts } = (await (
    await app.request("http://localhost/api/invoices/counts", { headers })
  ).json()) as { counts: Record<string, number> };

  for (const tab of ["draft", "unpaid", "paid", "void"]) {
    const { total } = (await (
      await app.request(`http://localhost/api/invoices?tab=${tab}`, { headers })
    ).json()) as { total: number };
    expect(total).toBe(counts[tab] ?? -1);
  }
});

test("a deleted invoice leaves the list without losing its number", async () => {
  const draft = await draftInvoice();
  await app.request(`http://localhost/api/invoices/${draft.id}`, {
    method: "DELETE",
    headers,
  });

  const live = (await (
    await app.request("http://localhost/api/invoices?tab=all", { headers })
  ).json()) as { invoices: { id: string }[] };
  expect(live.invoices.map((i) => i.id)).not.toContain(draft.id);

  const binned = (await (
    await app.request("http://localhost/api/invoices?tab=deleted", { headers })
  ).json()) as { invoices: { id: string; number: string }[] };
  const found = binned.invoices.find((i) => i.id === draft.id);
  expect(found?.number).toBe(draft.number);

  // And it comes back.
  await app.request(`http://localhost/api/invoices/${draft.id}/restore`, {
    method: "POST",
    headers,
  });
  const back = (await (
    await app.request("http://localhost/api/invoices?tab=all", { headers })
  ).json()) as { invoices: { id: string }[] };
  expect(back.invoices.map((i) => i.id)).toContain(draft.id);
});

// ---------------------------------------------------------------------------
// Turning a quote into an invoice
// ---------------------------------------------------------------------------

test("a quote becomes an invoice once, and refuses to do it twice", async () => {
  // Two bills for the same work, two journal entries for the same revenue,
  // and a customer who has to be talked down. The guard is in the conversion
  // itself rather than the route, because the customer portal converts too.
  const quoteId = await sentQuote(contactId, 120_000);

  const first = await app.request(
    `http://localhost/api/quotes/${quoteId}/convert`,
    { method: "POST", headers },
  );
  expect(first.status).toBe(201);
  const { invoice } = (await first.json()) as { invoice: { id: string } };

  const [quote] = await db
    .select()
    .from(schema.quotes)
    .where(eq(schema.quotes.id, quoteId));
  expect(quote?.status).toBe("accepted");
  expect(quote?.convertedInvoiceId).toBe(invoice.id);

  const second = await app.request(
    `http://localhost/api/quotes/${quoteId}/convert`,
    { method: "POST", headers },
  );
  expect(second.status).toBe(409);
  const body = (await second.json()) as { error: string; invoiceId: string };
  // And it says which invoice it already became, rather than "not found" —
  // which is the message that has somebody raising a duplicate by hand.
  expect(body.error).toContain("already");
  expect(body.invoiceId).toBe(invoice.id);

  // One invoice, and one journal entry for it.
  const invoices = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.quoteId, quoteId));
  expect(invoices).toHaveLength(1);
});

test("converting carries the whole line across, not a subset", async () => {
  // Dropping the unit or the fractional quantity turns "2.5 hours" into
  // "2 pieces" on the document the customer is actually asked to pay.
  const made = (await (
    await app.request("http://localhost/api/quotes", {
      method: "POST",
      headers,
      body: JSON.stringify({
        contactId,
        currency: "USD",
        lines: [
          {
            description: "Second fix",
            quantityMilli: 2500,
            unitPrice: 6000,
            unit: "hour",
            taxRateBp: 0,
          },
        ],
      }),
    })
  ).json()) as { quote: { id: string; totalCents: number } };

  const res = await app.request(
    `http://localhost/api/quotes/${made.quote.id}/convert`,
    { method: "POST", headers },
  );
  const { invoice } = (await res.json()) as {
    invoice: { id: string; totalCents: number };
  };
  expect(invoice.totalCents).toBe(made.quote.totalCents);

  const [line] = await db
    .select()
    .from(schema.invoiceLines)
    .where(eq(schema.invoiceLines.invoiceId, invoice.id));
  expect(line?.quantityMilli).toBe(2500);
  expect(line?.unit).toBe("hour");
});

test("the quote's tax bands travel with it", async () => {
  // The customer agreed to the figure on the quote. Recomputing on the
  // invoice gives the same answer today and a different one after a rate
  // changes.
  const taxRes = await app.request("http://localhost/api/invoicing/taxes", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Convert VAT", rateBp: 2000 }),
  });
  const { tax } = (await taxRes.json()) as { tax: { id: string } };

  const made = (await (
    await app.request("http://localhost/api/quotes", {
      method: "POST",
      headers,
      body: JSON.stringify({
        contactId,
        currency: "USD",
        lines: [
          {
            description: "Banded work",
            quantity: 1,
            unitPrice: 10_000,
            taxDefinitionId: tax.id,
          },
        ],
      }),
    })
  ).json()) as { quote: { id: string } };

  const res = await app.request(
    `http://localhost/api/quotes/${made.quote.id}/convert`,
    { method: "POST", headers },
  );
  const { invoice } = (await res.json()) as { invoice: { id: string } };

  const bands = await db
    .select()
    .from(schema.documentTaxes)
    .where(eq(schema.documentTaxes.documentId, invoice.id));
  expect(bands).toHaveLength(1);
  expect(bands[0]?.name).toBe("Convert VAT");
  expect(bands[0]?.taxCents).toBe(2000);
  expect(bands[0]?.documentType).toBe("invoice");
});

test("a statement shows what the customer was asked for, and nothing else", async () => {
  // Its own customer, because the statement is the whole account and the
  // other tests in this file have been raising invoices against Acme.
  const [statementContact] = await db
    .insert(schema.contacts)
    .values({
      organizationId: orgId,
      name: "Statement Ltd",
      email: "ap@statement.test",
    })
    .returning();
  const who = statementContact?.id ?? "";

  const raise = async (
    description: string,
    unitPrice: number,
    status = "open",
  ) => {
    const res = await app.request("http://localhost/api/invoices", {
      method: "POST",
      headers,
      body: JSON.stringify({
        contactId: who,
        currency: "USD",
        status,
        lines: [{ description, quantity: 1, unitPrice, taxRateBp: 0 }],
      }),
    });
    const { invoice } = (await res.json()) as {
      invoice: { id: string; number: string };
    };
    return invoice;
  };

  const sent = await raise("Delivered work", 400_00);
  await app.request(`http://localhost/api/invoices/${sent.id}/payments`, {
    method: "POST",
    headers,
    body: JSON.stringify({ amountCents: 150_00, method: "bank" }),
  });

  // Never sent, so nobody has been asked for it. It must not appear.
  const draft = await raise("Not yet sent", 999_00, "draft");

  const res = await app.request(
    `http://localhost/api/invoicing/statements/${who}`,
    { headers },
  );
  expect(res.status).toBe(200);
  const { statement } = (await res.json()) as {
    statement: {
      rows: { reference: string; amountCents: number }[];
      closingCents: number;
    };
  };

  expect(statement.rows.map((r) => r.reference)).toEqual([
    sent.number,
    sent.number,
  ]);
  expect(statement.rows.some((r) => r.reference === draft.number)).toBe(false);
  expect(statement.closingCents).toBe(250_00);
});

test("a statement belongs to one business only", async () => {
  const [theirs] = await db
    .insert(schema.contacts)
    .values({
      organizationId: crypto.randomUUID(),
      name: "Somebody else's customer",
    })
    .returning();

  const res = await app.request(
    `http://localhost/api/invoicing/statements/${theirs?.id}`,
    { headers },
  );
  expect(res.status).toBe(404);

  await db
    .delete(schema.contacts)
    .where(eq(schema.contacts.id, theirs?.id ?? ""));
});

test("a schedule can be set up, paused and deleted", async () => {
  const created = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "USD",
      status: "draft",
      lines: [
        {
          description: "Retainer",
          quantity: 1,
          unitPrice: 30_000,
          taxRateBp: 0,
        },
      ],
    }),
  });
  const { invoice } = (await created.json()) as { invoice: { id: string } };

  const res = await app.request("http://localhost/api/invoicing/recurring", {
    method: "POST",
    headers,
    body: JSON.stringify({
      templateInvoiceId: invoice.id,
      interval: "monthly",
      intervalCount: 3,
      nextRunAt: "2026-09-01",
      autoSend: true,
    }),
  });
  expect(res.status).toBe(201);
  const { profile } = (await res.json()) as {
    profile: { id: string; contactId: string; intervalCount: number };
  };
  // The customer comes from the invoice rather than being asked for twice.
  expect(profile.contactId).toBe(contactId);
  expect(profile.intervalCount).toBe(3);

  const listed = await app.request("http://localhost/api/invoicing/recurring", {
    headers,
  });
  const { profiles } = (await listed.json()) as {
    profiles: { id: string; templateNumber: string | null }[];
  };
  const mine = profiles.find((p) => p.id === profile.id);
  expect(mine?.templateNumber).toBeTruthy();

  const paused = await app.request(
    `http://localhost/api/invoicing/recurring/${profile.id}`,
    { method: "PATCH", headers, body: JSON.stringify({ active: false }) },
  );
  expect(paused.status).toBe(200);
  expect(
    ((await paused.json()) as { profile: { active: boolean } }).profile.active,
  ).toBe(false);

  const deleted = await app.request(
    `http://localhost/api/invoicing/recurring/${profile.id}`,
    { method: "DELETE", headers },
  );
  expect(deleted.status).toBe(200);
});

test("a schedule cannot be pointed at another business's invoice", async () => {
  // Without the check it would copy their prices, their notes and their lines
  // into a document billed under this business's number.
  const otherOrg = crypto.randomUUID();
  const [theirs] = await db
    .insert(schema.invoices)
    .values({
      organizationId: otherOrg,
      number: "THEIRS-1",
      status: "draft",
      subtotalCents: 1_000,
      taxCents: 0,
      totalCents: 1_000,
    })
    .returning();

  const res = await app.request("http://localhost/api/invoicing/recurring", {
    method: "POST",
    headers,
    body: JSON.stringify({
      templateInvoiceId: theirs?.id,
      interval: "monthly",
      nextRunAt: "2026-09-01",
    }),
  });
  expect(res.status).toBe(404);

  const rows = await db
    .select()
    .from(schema.recurringProfiles)
    .where(eq(schema.recurringProfiles.templateInvoiceId, theirs?.id ?? ""));
  expect(rows).toHaveLength(0);

  await db
    .delete(schema.invoices)
    .where(eq(schema.invoices.id, theirs?.id ?? ""));
});

test("somebody else's schedule cannot be changed or deleted", async () => {
  const [theirs] = await db
    .insert(schema.recurringProfiles)
    .values({
      organizationId: crypto.randomUUID(),
      contactId: crypto.randomUUID(),
      interval: "monthly",
      nextRunAt: new Date(),
    })
    .returning();

  const patched = await app.request(
    `http://localhost/api/invoicing/recurring/${theirs?.id}`,
    { method: "PATCH", headers, body: JSON.stringify({ active: false }) },
  );
  expect(patched.status).toBe(404);

  const deleted = await app.request(
    `http://localhost/api/invoicing/recurring/${theirs?.id}`,
    { method: "DELETE", headers },
  );
  expect(deleted.status).toBe(404);

  const [still] = await db
    .select()
    .from(schema.recurringProfiles)
    .where(eq(schema.recurringProfiles.id, theirs?.id ?? ""));
  expect(still?.active).toBe(true);

  await db
    .delete(schema.recurringProfiles)
    .where(eq(schema.recurringProfiles.id, theirs?.id ?? ""));
});

test("a business's own branding reaches the document it sends", async () => {
  const made = await app.request("http://localhost/api/invoicing/templates", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Our letterhead",
      accentColor: "#1d4ed8",
      paperSize: "a4",
      footerNote: "Thank you for your business.",
    }),
  });
  expect(made.status).toBe(201);
  const { template } = (await made.json()) as {
    template: { id: string; isDefault: boolean };
  };
  // The first template a business makes is the one its documents use — one
  // nothing points at is a screen somebody filled in for nothing.
  expect(template.isDefault).toBe(true);

  const { url } = await sharedInvoice();
  const page = await (await app.request(url)).text();
  expect(page).toContain("--accent:#1d4ed8");
  expect(page).toContain("size:A4");
  expect(page).toContain("Thank you for your business.");
});

test("wording on a template is text on the page, never markup", async () => {
  // The public document is same-origin with the application, so a script
  // stored here would run with an administrator's session the first time
  // somebody previewed the invoice.
  const made = await app.request("http://localhost/api/invoicing/templates", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Trouble",
      headerNote: "<script>fetch('/api/users')</script>",
    }),
  });
  const { template } = (await made.json()) as { template: { id: string } };
  await app.request(
    `http://localhost/api/invoicing/templates/${template.id}/default`,
    { method: "POST", headers },
  );

  const { url } = await sharedInvoice();
  const page = await (await app.request(url)).text();
  expect(page).not.toContain("<script>fetch");
  expect(page).toContain("&lt;script&gt;");
});

test("a colour that is not a colour never reaches the stylesheet", async () => {
  const res = await app.request("http://localhost/api/invoicing/templates", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Injected",
      accentColor: "#fff;}@import url(//evil.test/x.css);a{",
    }),
  });
  expect(res.status).toBe(400);

  const rows = await db
    .select()
    .from(schema.documentTemplates)
    .where(eq(schema.documentTemplates.organizationId, orgId));
  expect(rows.some((t) => t.accentColor?.includes("@import"))).toBe(false);
});

test("exactly one template is the default, and it is this business's own", async () => {
  const first = await app.request("http://localhost/api/invoicing/templates", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "One" }),
  });
  const second = await app.request("http://localhost/api/invoicing/templates", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Two" }),
  });
  const b = ((await second.json()) as { template: { id: string } }).template;
  await first.json();

  await app.request(
    `http://localhost/api/invoicing/templates/${b.id}/default`,
    { method: "POST", headers },
  );

  const listed = await app.request("http://localhost/api/invoicing/templates", {
    headers,
  });
  const { templates } = (await listed.json()) as {
    templates: { id: string; isDefault: boolean }[];
  };
  expect(templates.filter((t) => t.isDefault)).toHaveLength(1);
  expect(templates.find((t) => t.isDefault)?.id).toBe(b.id);

  // And somebody else's cannot be made this business's default.
  const [theirs] = await db
    .insert(schema.documentTemplates)
    .values({ organizationId: crypto.randomUUID(), name: "Theirs" })
    .returning();
  const stolen = await app.request(
    `http://localhost/api/invoicing/templates/${theirs?.id}/default`,
    { method: "POST", headers },
  );
  expect(stolen.status).toBe(404);
  const [untouched] = await db
    .select()
    .from(schema.documentTemplates)
    .where(eq(schema.documentTemplates.id, theirs?.id ?? ""));
  expect(untouched?.isDefault).toBe(false);

  await db
    .delete(schema.documentTemplates)
    .where(eq(schema.documentTemplates.id, theirs?.id ?? ""));
});

test("tax charged with no breakdown behind it is still shown", async () => {
  // Documents raised before the tax breakdown existed carry a figure and no
  // bands. Without a fallback row the totals jump from subtotal to total with
  // the difference unexplained, which is the first thing a customer queries.
  const { id, url } = await sharedInvoice();
  await db
    .update(schema.invoices)
    .set({ taxCents: 1_000, totalCents: 21_000 })
    .where(eq(schema.invoices.id, id));
  await db
    .delete(schema.documentTaxes)
    .where(eq(schema.documentTaxes.documentId, id));

  const page = await (await app.request(url)).text();
  expect(page).toContain("Tax");
  expect(page).toContain("$10.00");
});

/**
 * A payment belongs to the day the money arrived.
 *
 * Not the day somebody typed it in. Without the date on the entry, a period's
 * cash figures depend on when the bookkeeper got to their desk — and a cheque
 * that cleared on Friday reads as Monday's takings.
 */
test("a payment can be dated, and its entry carries that date", async () => {
  const { body } = await createInvoice([
    { description: "Backdated", quantity: 1, unitPrice: 5000 },
  ]);

  const paid = await app.request(
    `http://localhost/api/invoices/${body.invoice.id}/payments`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        amountCents: 5000,
        receivedAt: "2026-01-05T00:00:00.000Z",
      }),
    },
  );
  expect(paid.status).toBe(201);
  const { payment } = (await paid.json()) as { payment: { id: string } };

  const [entry] = await db
    .select({ postedAt: schema.journalEntries.postedAt })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.source, `payment:${payment.id}`));
  expect(entry?.postedAt.toISOString().slice(0, 10)).toBe("2026-01-05");
});

test("a payment with an unreadable date is refused", async () => {
  const { body } = await createInvoice([
    { description: "Bad date", quantity: 1, unitPrice: 1000 },
  ]);
  const res = await app.request(
    `http://localhost/api/invoices/${body.invoice.id}/payments`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ amountCents: 1000, receivedAt: "not a date" }),
    },
  );
  expect(res.status).toBe(400);
});

// ---------------------------------------------------------------------------
// Subscriptions: the screens' side of it
// ---------------------------------------------------------------------------

/** A plan, and the customer put on it. */
async function makePlan(priceCents = 3_900) {
  const res = await app.request("http://localhost/api/invoicing/plans", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: `Pro ${crypto.randomUUID().slice(0, 4)}`,
      unitPriceCents: priceCents,
      billingInterval: "monthly",
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { plan: { id: string } }).plan;
}

async function makeSubscription(body: Record<string, unknown> = {}) {
  const plan = await makePlan();
  const res = await app.request(
    "http://localhost/api/invoicing/subscriptions",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ contactId, planItemId: plan.id, ...body }),
    },
  );
  expect(res.status).toBe(201);
  const { subscription } = (await res.json()) as {
    subscription: Record<string, unknown>;
  };
  return { plan, subscription };
}

test("a plan is a catalogue item with a period on it", async () => {
  const plan = await makePlan(4_900);
  const listed = await app.request("http://localhost/api/invoicing/plans", {
    headers,
  });
  const { plans } = (await listed.json()) as {
    plans: { id: string; billingInterval: string; unitPriceCents: number }[];
  };
  const mine = plans.find((p) => p.id === plan.id);
  expect(mine?.billingInterval).toBe("monthly");
  expect(mine?.unitPriceCents).toBe(4_900);

  // and it shows up as something to put on an invoice, because it is one
  const items = await app.request("http://localhost/api/invoicing/items", {
    headers,
  });
  const { items: catalogue } = (await items.json()) as {
    items: { id: string }[];
  };
  expect(catalogue.some((item) => item.id === plan.id)).toBe(true);
});

test("subscribing copies the plan's price, so a later rise does not follow", async () => {
  const { plan, subscription } = await makeSubscription();
  expect(subscription.unitPriceCents).toBe(3_900);
  expect(subscription.status).toBe("active");
  expect(subscription.kind).toBe("subscription");

  await app.request("http://localhost/api/invoicing/plans", {
    method: "POST",
    headers,
    body: JSON.stringify({
      itemId: plan.id,
      billingInterval: "yearly",
    }),
  });

  const listed = await app.request(
    "http://localhost/api/invoicing/subscriptions",
    { headers },
  );
  const { subscriptions } = (await listed.json()) as {
    subscriptions: { id: string; unitPriceCents: number; interval: string }[];
  };
  const mine = subscriptions.find((s) => s.id === subscription.id);
  expect(mine?.unitPriceCents).toBe(3_900);
  expect(mine?.interval).toBe("monthly");
});

test("a trial starts the billing on the day it ends", async () => {
  const inTenDays = new Date(Date.now() + 10 * 86_400_000);
  const { subscription } = await makeSubscription({
    trialEndsAt: inTenDays.toISOString(),
  });
  expect(subscription.status).toBe("trialing");
  expect(String(subscription.nextRunAt).slice(0, 10)).toBe(
    inTenDays.toISOString().slice(0, 10),
  );
});

/**
 * Cancelling keeps what has been paid for.
 *
 * The default is the end of the period, and the row says so with a date rather
 * than a flag — the screen has to be able to show "billing stops on the 14th"
 * and to take it back before then.
 */
test("cancelling ends at the period, and can be taken back", async () => {
  const { subscription } = await makeSubscription();

  const cancelled = await app.request(
    `http://localhost/api/invoicing/subscriptions/${subscription.id}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({ action: "cancel" }),
    },
  );
  expect(cancelled.status).toBe(200);
  const after = (await cancelled.json()) as {
    subscription: { cancelAt: string | null; status: string; active: boolean };
  };
  expect(after.subscription.cancelAt).toBeTruthy();
  expect(after.subscription.status).toBe("active");
  expect(after.subscription.active).toBe(true);

  const kept = await app.request(
    `http://localhost/api/invoicing/subscriptions/${subscription.id}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({ action: "uncancel" }),
    },
  );
  const back = (await kept.json()) as {
    subscription: { cancelAt: string | null; status: string };
  };
  expect(back.subscription.cancelAt).toBeNull();
  expect(back.subscription.status).toBe("active");
});

test("cancelling immediately stops it there and then", async () => {
  const { subscription } = await makeSubscription();
  const res = await app.request(
    `http://localhost/api/invoicing/subscriptions/${subscription.id}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({ action: "cancel", immediately: true }),
    },
  );
  const body = (await res.json()) as {
    subscription: { status: string; active: boolean };
  };
  expect(body.subscription.status).toBe("cancelled");
  expect(body.subscription.active).toBe(false);
});

/**
 * Resuming picks up from today.
 *
 * A subscription paused for three months would otherwise raise three invoices
 * the moment it came back, for periods in which the customer had nothing.
 */
test("resuming does not bill for the pause", async () => {
  const { subscription } = await makeSubscription({
    startsOn: new Date(Date.now() - 90 * 86_400_000).toISOString(),
  });

  await app.request(
    `http://localhost/api/invoicing/subscriptions/${subscription.id}`,
    { method: "PATCH", headers, body: JSON.stringify({ action: "pause" }) },
  );
  const resumed = await app.request(
    `http://localhost/api/invoicing/subscriptions/${subscription.id}`,
    { method: "PATCH", headers, body: JSON.stringify({ action: "resume" }) },
  );
  const body = (await resumed.json()) as {
    subscription: { status: string; nextRunAt: string };
  };
  expect(body.subscription.status).toBe("active");
  expect(new Date(body.subscription.nextRunAt).getTime()).toBeGreaterThan(
    Date.now() - 60_000,
  );
});

test("another business's subscription cannot be touched", async () => {
  const theirs = `other-org-${crypto.randomUUID().slice(0, 8)}`;
  const [row] = await db
    .insert(schema.recurringProfiles)
    .values({
      organizationId: theirs,
      kind: "subscription",
      contactId,
      interval: "monthly",
      intervalCount: 1,
      nextRunAt: new Date(),
      unitPriceCents: 1_000,
    })
    .returning();

  const res = await app.request(
    `http://localhost/api/invoicing/subscriptions/${row?.id}`,
    { method: "PATCH", headers, body: JSON.stringify({ action: "pause" }) },
  );
  expect(res.status).toBe(404);

  await db
    .delete(schema.recurringProfiles)
    .where(eq(schema.recurringProfiles.organizationId, theirs));
});

test("what the business is owed each month adds up across intervals", async () => {
  const yearly = await app.request("http://localhost/api/invoicing/plans", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: `Yearly ${crypto.randomUUID().slice(0, 4)}`,
      unitPriceCents: 12_000,
      billingInterval: "yearly",
    }),
  });
  const { plan } = (await yearly.json()) as { plan: { id: string } };
  await app.request("http://localhost/api/invoicing/subscriptions", {
    method: "POST",
    headers,
    body: JSON.stringify({ contactId, planItemId: plan.id }),
  });

  const listed = await app.request(
    "http://localhost/api/invoicing/subscriptions",
    { headers },
  );
  const { monthlyRecurringCents } = (await listed.json()) as {
    monthlyRecurringCents: number;
  };
  // a 120.00 yearly plan is 10.00 a month, whatever else is on the list
  expect(monthlyRecurringCents).toBeGreaterThanOrEqual(1_000);
});

/**
 * Subscriptions are Pro. Free bills for work done.
 *
 * Registered on a second app with the gate closed rather than asserted against
 * the shared one, because what is being tested is the instance's licence, not
 * this person's role. The nav entry is checked in the same breath: a door in
 * the sidebar onto a 404 is worse than no door.
 */
test("a Free instance has no subscriptions, in the routes or the sidebar", async () => {
  const free = new Hono<SentrelloEnv>();
  const nav: { id: string }[] = [];
  invoicing.register({
    app: free,
    entitled: (need) => need.tier !== "pro",
    registerNav: (item) => nav.push(item),
    registerPermission: () => {},
    registerSummary: () => {},
    registerJob: () => {},
  });

  expect(nav.some((item) => item.id === "subscriptions")).toBe(false);
  // The ones Free does get are still there, so this is a gate and not a break.
  expect(nav.some((item) => item.id === "invoicing")).toBe(true);

  for (const [method, path] of [
    ["GET", "/api/invoicing/plans"],
    ["POST", "/api/invoicing/plans"],
    ["DELETE", "/api/invoicing/plans/whatever"],
    ["GET", "/api/invoicing/subscriptions"],
    ["POST", "/api/invoicing/subscriptions"],
    ["PATCH", "/api/invoicing/subscriptions/whatever"],
    ["GET", "/api/invoicing/subscriptions/whatever/invoices"],
  ] as const) {
    const res = await free.request(`http://localhost${path}`, {
      method,
      headers,
      body: method === "GET" || method === "DELETE" ? undefined : "{}",
    });
    expect(`${method} ${path} → ${res.status}`).toBe(`${method} ${path} → 404`);
  }

  // And the Free half of the same module still answers, so the gate is not a
  // blanket 404 over everything Invoicing registers.
  const items = await free.request("http://localhost/api/invoicing/items", {
    headers,
  });
  expect(items.status).toBe(200);
});

/**
 * Pay early, pay less — and the books still balance.
 *
 * The saving is not a payment: no money arrived. It reduces what the invoice
 * asks for, and the part that never came is a sales discount rather than
 * income that quietly went missing. Getting that wrong leaves either a debt
 * nobody owes on the aging report or a journal entry that does not balance.
 */
test("an invoice can offer a discount for paying early, and taking it settles it", async () => {
  const created = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      lines: [{ description: "Work", quantity: 1, unitPriceCents: 100_000 }],
      // 2% if paid within 10 days.
      earlyDiscountType: "percent",
      earlyDiscountValue: 200,
      earlyDiscountDays: 10,
    }),
  });
  expect(created.status).toBe(201);
  const { invoice } = (await created.json()) as {
    invoice: { id: string; totalCents: number };
  };
  expect(invoice.totalCents).toBe(100_000);

  // 2% of 1,000.00 is 20.00, so 980.00 settles it in full.
  const paid = await app.request(
    `http://localhost/api/invoices/${invoice.id}/payments`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ amountCents: 98_000, applyEarlyDiscount: true }),
    },
  );
  expect(paid.status).toBe(201);
  const settled = (await paid.json()) as {
    status: string;
    balanceDue: number;
  };
  expect(settled.status).toBe("paid");
  expect(settled.balanceDue).toBe(0);

  // Taking it twice would forgive the saving twice.
  const again = await app.request(
    `http://localhost/api/invoices/${invoice.id}/payments`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ amountCents: 100, applyEarlyDiscount: true }),
    },
  );
  expect(again.status).toBe(400);
});

test("the offer is refused once the window has closed", async () => {
  const created = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      lines: [{ description: "Work", quantity: 1, unitPriceCents: 50_000 }],
      earlyDiscountType: "amount",
      earlyDiscountValue: 5_000,
      earlyDiscountDays: 5,
    }),
  });
  const { invoice } = (await created.json()) as { invoice: { id: string } };

  // Money that arrived a fortnight after issue is outside a five-day offer.
  const late = new Date();
  late.setDate(late.getDate() + 14);
  const res = await app.request(
    `http://localhost/api/invoices/${invoice.id}/payments`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        amountCents: 45_000,
        applyEarlyDiscount: true,
        receivedAt: late.toISOString(),
      }),
    },
  );
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("closed");
});

test("an invoice offering nothing refuses the discount rather than inventing one", async () => {
  const created = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      lines: [{ description: "Work", quantity: 1, unitPriceCents: 1_000 }],
    }),
  });
  const { invoice } = (await created.json()) as { invoice: { id: string } };

  const res = await app.request(
    `http://localhost/api/invoices/${invoice.id}/payments`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ amountCents: 900, applyEarlyDiscount: true }),
    },
  );
  expect(res.status).toBe(400);
});

test("a half-written offer is refused where it is typed", async () => {
  // A percentage with no number of days is a discount with no deadline.
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      lines: [{ description: "Work", quantity: 1, unitPriceCents: 1_000 }],
      earlyDiscountType: "percent",
      earlyDiscountValue: 200,
    }),
  });
  expect(res.status).toBe(400);
});

/**
 * The list as a spreadsheet, filtered the way the screen is.
 *
 * An export that ignored the filters would hand somebody the whole table when
 * they had asked for nine rows, with nothing on screen to say so — which is
 * the mistake the CRM's exports were fixed for, and worth not repeating.
 */
test("invoices export as a spreadsheet, honouring the filter", async () => {
  const only = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      lines: [
        {
          description: 'Fence, "the big one"',
          quantity: 2,
          unitPriceCents: 2_500,
        },
      ],
    }),
  });
  const { invoice } = (await only.json()) as {
    invoice: { id: string; number: string };
  };

  const res = await app.request(
    `http://localhost/api/invoices/export.csv?q=${encodeURIComponent(invoice.number)}`,
    { headers },
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/csv");
  expect(res.headers.get("content-disposition")).toContain("invoices.csv");

  const body = await res.text();
  const lines = body.trim().split("\r\n");
  expect(lines[0]).toContain("Number,Status,Customer");
  // The filter was a search for one number, so one row came back.
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain(invoice.number);
  // The customer by name, not a uuid nobody can read.
  expect(lines[1]).toContain("Acme Ltd");
  // 2 × 25.00 = 50.00, written the way a spreadsheet reads money.
  expect(lines[1]).toContain("50.00");
});

/**
 * A description with a comma and quotes in it.
 *
 * This is the whole reason the writer is shared rather than written per
 * module: a file that is silently wrong from one row down is found weeks later
 * by somebody whose phone-number column contains names.
 */
test("a quote export survives text that would break a naive writer", async () => {
  const made = await app.request("http://localhost/api/quotes", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      lines: [{ description: "Anything", quantity: 1, unitPriceCents: 100 }],
      notes: 'He said "yes, do it"\nand then left',
    }),
  });
  expect(made.status).toBe(201);

  const res = await app.request("http://localhost/api/quotes/export.csv", {
    headers,
  });
  expect(res.status).toBe(200);
  const body = await res.text();
  // Header plus one row per quote: no row was split by the newline in a note.
  const rows = body.trim().split("\r\n");
  expect(rows.length).toBeGreaterThan(1);
  expect(rows[0]).toContain("Valid until");
});

/**
 * Five drafts for one customer, sent as one invoice.
 *
 * The constraints are the feature. Each refusal below is a way to produce a
 * document nobody can reconcile: two claims for the same money, or a total
 * that adds euros to dollars.
 */
test("drafts for one customer merge into a single invoice", async () => {
  const draft = async (cents: number) => {
    const res = await app.request("http://localhost/api/invoices", {
      method: "POST",
      headers,
      body: JSON.stringify({
        contactId,
        status: "draft",
        lines: [{ description: "A visit", quantity: 1, unitPriceCents: cents }],
      }),
    });
    return ((await res.json()) as { invoice: { id: string; number: string } })
      .invoice;
  };

  const first = await draft(10_000);
  const second = await draft(25_000);

  const res = await app.request("http://localhost/api/invoices/consolidate", {
    method: "POST",
    headers,
    body: JSON.stringify({ invoiceIds: [first.id, second.id] }),
  });
  expect(res.status).toBe(201);
  const { invoice, mergedFrom } = (await res.json()) as {
    invoice: { id: string; subtotalCents: number; totalCents: number };
    mergedFrom: string[];
  };

  // The merged total is the exact sum of the sources, to the cent.
  expect(invoice.subtotalCents).toBe(35_000);
  expect(mergedFrom).toEqual([first.number, second.number]);

  // Each line still says which invoice it came from, so the customer's copy
  // reads as the several jobs it actually was.
  const lines = await db
    .select()
    .from(schema.invoiceLines)
    .where(eq(schema.invoiceLines.invoiceId, invoice.id));
  expect(lines).toHaveLength(2);
  expect(lines.map((l) => l.sourceNumber).sort()).toEqual(
    [first.number, second.number].sort(),
  );

  /**
   * And the sources are in the trash, not gone.
   *
   * Somebody merges the wrong five and wants to look. Soft delete is how every
   * other document leaves this module, and Restore already reads it.
   */
  const sources = await db
    .select()
    .from(schema.invoices)
    .where(inArray(schema.invoices.id, [first.id, second.id]));
  expect(sources.every((s) => s.deletedAt !== null)).toBe(true);
});

test("the merged document reads as the jobs it was made of", async () => {
  const draft = async (cents: number) => {
    const res = await app.request("http://localhost/api/invoices", {
      method: "POST",
      headers,
      body: JSON.stringify({
        contactId,
        status: "draft",
        lines: [{ description: "A visit", quantity: 1, unitPriceCents: cents }],
      }),
    });
    return ((await res.json()) as { invoice: { id: string; number: string } })
      .invoice;
  };
  const first = await draft(10_000);
  const second = await draft(25_000);

  const made = await app.request("http://localhost/api/invoices/consolidate", {
    method: "POST",
    headers,
    body: JSON.stringify({ invoiceIds: [first.id, second.id] }),
  });
  const { invoice } = (await made.json()) as { invoice: { id: string } };

  // Publish it, then read the page the customer opens.
  await app.request(`http://localhost/api/invoices/${invoice.id}/share`, {
    method: "POST",
    headers,
  });
  const [row] = await db
    .select({ shareToken: schema.invoices.shareToken })
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoice.id));
  const page = await app.request(
    `http://localhost/share/invoice/${row?.shareToken}`,
  );
  const html = await page.text();

  // Each source is named, with its own subtotal under it.
  expect(html).toContain(first.number);
  expect(html).toContain(second.number);
  expect(html).toContain(`${first.number} subtotal`);
  expect(html).toContain(`${second.number} subtotal`);
});

test("an invoice that has been issued cannot be merged into another", async () => {
  const drafted = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      status: "draft",
      lines: [{ description: "A visit", quantity: 1, unitPriceCents: 1_000 }],
    }),
  });
  const a = ((await drafted.json()) as { invoice: { id: string } }).invoice;

  // This one is issued, so the customer already has a claim for that money.
  const issued = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      lines: [{ description: "A visit", quantity: 1, unitPriceCents: 1_000 }],
    }),
  });
  const b = ((await issued.json()) as { invoice: { id: string } }).invoice;

  const res = await app.request("http://localhost/api/invoices/consolidate", {
    method: "POST",
    headers,
    body: JSON.stringify({ invoiceIds: [a.id, b.id] }),
  });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toContain("issued");
});

test("drafts in different currencies are refused rather than added up", async () => {
  // Both currencies need a rate, or the refusal under test never gets reached:
  // an invoice in a currency nobody has priced is refused at creation.
  const when = new Date();
  when.setDate(when.getDate() - 1);
  await db.insert(schema.exchangeRates).values({
    organizationId: orgId,
    code: "EUR",
    rateMicro: 1_100_000,
    asOf: when,
  });

  const make = async (currency: string) => {
    const res = await app.request("http://localhost/api/invoices", {
      method: "POST",
      headers,
      body: JSON.stringify({
        contactId,
        status: "draft",
        currency,
        lines: [
          { description: "A visit", quantity: 1, unitPriceCents: 40_000 },
        ],
      }),
    });
    return ((await res.json()) as { invoice: { id: string } }).invoice;
  };

  const usd = await make("USD");
  const eur = await make("EUR");
  const res = await app.request("http://localhost/api/invoices/consolidate", {
    method: "POST",
    headers,
    body: JSON.stringify({ invoiceIds: [usd.id, eur.id] }),
  });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toContain("currency");

  await db
    .delete(schema.exchangeRates)
    .where(eq(schema.exchangeRates.organizationId, orgId));
});

test("merging needs more than one draft to merge", async () => {
  const res = await app.request("http://localhost/api/invoices/consolidate", {
    method: "POST",
    headers,
    body: JSON.stringify({ invoiceIds: [] }),
  });
  expect(res.status).toBe(400);
});

/**
 * The CRM's tags, on an invoice.
 *
 * One list of labels for the whole platform, not a second one in this module —
 * otherwise renaming "Chase this" leaves half the records saying the old thing.
 */
test("an invoice wears the CRM's tags, and the list can be narrowed to one", async () => {
  const [tag] = await db
    .insert(schema.tags)
    .values({
      organizationId: orgId,
      name: `Chase ${suffix}`,
      color: "#ff0000",
    })
    .returning();
  if (!tag) throw new Error("could not create the tag");

  const made = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      lines: [{ description: "Work", quantity: 1, unitPriceCents: 4_200 }],
    }),
  });
  const { invoice } = (await made.json()) as { invoice: { id: string } };

  const attached = await app.request(
    `http://localhost/api/invoices/${invoice.id}/tags`,
    { method: "POST", headers, body: JSON.stringify({ tagId: tag.id }) },
  );
  expect(attached.status).toBe(201);

  // Twice is somebody clicking twice, not an error, and not a second label.
  const again = await app.request(
    `http://localhost/api/invoices/${invoice.id}/tags`,
    { method: "POST", headers, body: JSON.stringify({ tagId: tag.id }) },
  );
  expect(again.status).toBe(200);

  const listed = await app.request(
    `http://localhost/api/invoices?tagId=${tag.id}`,
    { headers },
  );
  const { invoices } = (await listed.json()) as {
    invoices: { id: string; tags: { id: string; name: string }[] }[];
  };
  expect(invoices).toHaveLength(1);
  expect(invoices[0]?.id).toBe(invoice.id);
  expect(invoices[0]?.tags[0]?.id).toBe(tag.id);

  // And off again.
  const removed = await app.request(
    `http://localhost/api/invoices/${invoice.id}/tags/${tag.id}`,
    { method: "DELETE", headers },
  );
  expect(removed.status).toBe(204);
  const after = await app.request(
    `http://localhost/api/invoices?tagId=${tag.id}`,
    { headers },
  );
  expect(
    ((await after.json()) as { invoices: unknown[] }).invoices,
  ).toHaveLength(0);

  await db.delete(schema.tags).where(eq(schema.tags.id, tag.id));
});

/**
 * A guessed tag id must not label another business's document.
 *
 * The CRM's own routes check this on the way in and on the way out; these have
 * to as well, or the check is only as good as the least careful caller.
 */
test("a tag from another organization cannot be attached", async () => {
  const [foreign] = await db
    .insert(schema.tags)
    .values({
      organizationId: `someone-else-${suffix}`,
      name: "Theirs",
      color: "#00ff00",
    })
    .returning();
  if (!foreign) throw new Error("could not create the foreign tag");

  const made = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      lines: [{ description: "Work", quantity: 1, unitPriceCents: 100 }],
    }),
  });
  const { invoice } = (await made.json()) as { invoice: { id: string } };

  const res = await app.request(
    `http://localhost/api/invoices/${invoice.id}/tags`,
    { method: "POST", headers, body: JSON.stringify({ tagId: foreign.id }) },
  );
  expect(res.status).toBe(404);

  await db.delete(schema.tags).where(eq(schema.tags.id, foreign.id));
});

/**
 * A foreign invoice reaches the books in the currency the books are kept in.
 *
 * The purchase side has converted since multi-currency shipped; this side did
 * not, so an invoice raised in euros posted its euro cents as though they were
 * dollars. A plausible, wrong number that nothing downstream would question —
 * the exact failure the ledger exists to prevent.
 */
test("an invoice in another currency posts at the rate, not at face value", async () => {
  // 1 EUR = 1.10 of the books' currency, recorded yesterday.
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  await db.insert(schema.exchangeRates).values({
    organizationId: orgId,
    code: "EUR",
    rateMicro: 1_100_000,
    asOf: yesterday,
  });

  const made = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "EUR",
      lines: [{ description: "Work", quantity: 1, unitPriceCents: 100_000 }],
    }),
  });
  expect(made.status).toBe(201);
  const { invoice } = (await made.json()) as {
    invoice: { id: string; totalCents: number; rateMicro: number };
  };

  // The document still says what the customer owes, in their currency.
  expect(invoice.totalCents).toBe(100_000);
  expect(invoice.rateMicro).toBe(1_100_000);

  // The ledger says what it is worth here: 1000.00 EUR at 1.10 = 1100.00.
  const lines = await db
    .select({
      debitCents: schema.journalLines.debitCents,
      creditCents: schema.journalLines.creditCents,
    })
    .from(schema.journalLines)
    .innerJoin(
      schema.journalEntries,
      eq(schema.journalEntries.id, schema.journalLines.entryId),
    )
    .where(eq(schema.journalEntries.source, `invoice:${invoice.id}`));
  const debits = lines.reduce((sum, l) => sum + l.debitCents, 0);
  const credits = lines.reduce((sum, l) => sum + l.creditCents, 0);
  expect(debits).toBe(110_000);
  // And it balances, which is the thing that must never stop being true.
  expect(credits).toBe(debits);

  await db
    .delete(schema.exchangeRates)
    .where(eq(schema.exchangeRates.organizationId, orgId));
});

/**
 * No rate is a refusal, not a guess.
 *
 * Posting a foreign invoice at 1:1 because nobody set a rate is how a wrong
 * number gets into the books wearing the shape of a right one.
 */
test("an invoice in a currency with no rate is refused", async () => {
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "JPY",
      lines: [{ description: "Work", quantity: 1, unitPriceCents: 100_000 }],
    }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("JPY");
});

/**
 * A foreign invoice paid after the rate has moved.
 *
 * Receivable was recorded at the rate the day the invoice was raised, so it
 * has to clear at that rate or the debt never fully leaves the balance sheet.
 * The cash that arrived is worth what it is worth today. The gap between them
 * is neither income the business earned nor a cost it chose — it is currency,
 * and it belongs in its own account.
 *
 * The purchase side has done this since multi-currency shipped. The sales side
 * had no answer at all, which meant cash was recorded at a rate it was never
 * received at.
 */
test("currency movement between raising and paying lands in its own account", async () => {
  const issued = new Date();
  issued.setDate(issued.getDate() - 30);
  await db.insert(schema.exchangeRates).values({
    organizationId: orgId,
    code: "GBP",
    rateMicro: 1_200_000,
    asOf: issued,
  });

  const made = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "GBP",
      lines: [{ description: "Work", quantity: 1, unitPriceCents: 100_000 }],
    }),
  });
  expect(made.status).toBe(201);
  const { invoice } = (await made.json()) as {
    invoice: { id: string; rateMicro: number };
  };
  expect(invoice.rateMicro).toBe(1_200_000);

  // The pound is worth more by the time they pay.
  const paidOn = new Date();
  await db.insert(schema.exchangeRates).values({
    organizationId: orgId,
    code: "GBP",
    rateMicro: 1_300_000,
    asOf: paidOn,
  });

  const paid = await app.request(
    `http://localhost/api/invoices/${invoice.id}/payments`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        amountCents: 100_000,
        receivedAt: paidOn.toISOString(),
      }),
    },
  );
  expect(paid.status).toBe(201);
  const settled = (await paid.json()) as { balanceDue: number };
  // The customer owed 1000.00 GBP and paid it: nothing is left.
  expect(settled.balanceDue).toBe(0);

  const lines = await db
    .select({
      debitCents: schema.journalLines.debitCents,
      creditCents: schema.journalLines.creditCents,
      accountId: schema.journalLines.accountId,
    })
    .from(schema.journalLines)
    .innerJoin(
      schema.journalEntries,
      eq(schema.journalEntries.id, schema.journalLines.entryId),
    )
    .where(
      eq(
        schema.journalEntries.memo,
        `Payment for ${
          (
            await db
              .select({ number: schema.invoices.number })
              .from(schema.invoices)
              .where(eq(schema.invoices.id, invoice.id))
          )[0]?.number
        }`,
      ),
    );

  const debits = lines.reduce((sum, l) => sum + l.debitCents, 0);
  const credits = lines.reduce((sum, l) => sum + l.creditCents, 0);
  // Cash came in at 1.30 — 130,000 — and receivable clears at 1.20 — 120,000.
  expect(debits).toBe(130_000);
  // Which only balances because the 10,000 difference went somewhere.
  expect(credits).toBe(debits);
  expect(lines.length).toBeGreaterThan(2);

  await db
    .delete(schema.exchangeRates)
    .where(eq(schema.exchangeRates.organizationId, orgId));
});

/**
 * The lists the invoice form offers.
 *
 * Payment terms and units were free-text boxes, which is how one business ends
 * up with "hour", "hours", "hr" and "Hrs" across four invoices, and with terms
 * saying thirty days beside a due date somebody set to next Tuesday.
 */
test("terms and units come with sensible defaults and can be replaced", async () => {
  const first = await app.request("http://localhost/api/invoicing/settings", {
    headers,
  });
  const before = (await first.json()) as {
    settings: {
      paymentTermOptions: { label: string; days: number }[];
      units: string[];
    };
  };
  // An instance that has never opened the settings screen still has to offer
  // something on the form.
  expect(before.settings.paymentTermOptions).toContainEqual({
    label: "Net 30",
    days: 30,
  });
  expect(before.settings.units).toContain("hour");

  const saved = await app.request("http://localhost/api/invoicing/settings", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      ...before.settings,
      paymentTermOptions: [
        { label: "On the day", days: 0 },
        { label: "Rubbish", days: 999 },
        { label: "", days: 5 },
      ],
      units: ["cubic yard", " Cubic Yard ", "", "load"],
    }),
  });
  expect(saved.status).toBe(200);
  const after = (await saved.json()) as typeof before;

  // 999 days is a typo, not a policy, and a term with no name cannot be
  // chosen from a list.
  expect(after.settings.paymentTermOptions).toEqual([
    { label: "On the day", days: 0 },
  ]);
  // "cubic yard" and "Cubic Yard" are one unit.
  expect(after.settings.units).toEqual(["cubic yard", "load"]);
});

/**
 * A quote that becomes a deposit and two stages.
 *
 * The arrangement is ordinary and the alternative is raising the deposit by
 * hand and remembering the rest, which is how a stage goes unbilled. What has
 * to hold: the invoices add up to the quote exactly, each carries its own
 * correctly-banded tax, and none of it reaches the books until it is issued.
 */
test("a quote splits into instalments that add back up to it", async () => {
  const { tax } = (await (
    await app.request("http://localhost/api/invoicing/taxes", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Instalment VAT", rateBp: 2000 }),
    })
  ).json()) as { tax: { id: string } };

  // Two lines, one taxed and one not, so the split has to handle both.
  const made = (await (
    await app.request("http://localhost/api/quotes", {
      method: "POST",
      headers,
      body: JSON.stringify({
        contactId,
        currency: "USD",
        lines: [
          {
            description: "Taxed work",
            quantity: 1,
            unitPrice: 10_001,
            taxDefinitionId: tax.id,
          },
          { description: "Untaxed work", quantity: 1, unitPrice: 5_000 },
        ],
      }),
    })
  ).json()) as { quote: { id: string; totalCents: number } };

  const res = await app.request(
    `http://localhost/api/quotes/${made.quote.id}/convert`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        instalments: [
          { shareBp: 3334, dueInDays: 0 },
          { shareBp: 3333, dueInDays: 30 },
          { shareBp: 3333, dueInDays: 60 },
        ],
      }),
    },
  );
  expect(res.status).toBe(201);
  const { invoices } = (await res.json()) as {
    invoices: {
      id: string;
      status: string;
      totalCents: number;
      subtotalCents: number;
      taxCents: number;
      dueDate: string;
    }[];
  };
  expect(invoices).toHaveLength(3);

  // Not a penny more or less than the quote. Thirds of an odd number are
  // exactly where a naive split loses one.
  const summed = invoices.reduce((sum, i) => sum + i.totalCents, 0);
  expect(summed).toBe(made.quote.totalCents);

  // Drafts. An instalment due in sixty days is not money owed yet, and
  // issuing it now would put the revenue in this month's books.
  expect(invoices.every((i) => i.status === "draft")).toBe(true);

  // Each one's tax is its own share, banded, and the lines agree with it.
  for (const instalment of invoices) {
    const bands = await db
      .select()
      .from(schema.documentTaxes)
      .where(
        and(
          eq(schema.documentTaxes.documentType, "invoice"),
          eq(schema.documentTaxes.documentId, instalment.id),
        ),
      );
    const banded = bands.reduce((sum, b) => sum + b.taxCents, 0);
    expect(banded).toBe(instalment.taxCents);

    const lines = await db
      .select()
      .from(schema.invoiceLines)
      .where(eq(schema.invoiceLines.invoiceId, instalment.id));
    // One line per band that has anything in it: taxed and untaxed.
    expect(lines).toHaveLength(2);
    expect(lines.reduce((sum, l) => sum + l.unitPriceCents, 0)).toBe(
      instalment.subtotalCents,
    );
  }

  // And it cannot be split a second time.
  const again = await app.request(
    `http://localhost/api/quotes/${made.quote.id}/convert`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        instalments: [
          { shareBp: 5000, dueInDays: 0 },
          { shareBp: 5000, dueInDays: 30 },
        ],
      }),
    },
  );
  expect(again.status).toBe(400);
});

test("instalments that do not add up to the whole are refused", async () => {
  const made = (await (
    await app.request("http://localhost/api/quotes", {
      method: "POST",
      headers,
      body: JSON.stringify({
        contactId,
        currency: "USD",
        lines: [{ description: "Work", quantity: 1, unitPrice: 20_000 }],
      }),
    })
  ).json()) as { quote: { id: string } };

  const res = await app.request(
    `http://localhost/api/quotes/${made.quote.id}/convert`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        instalments: [
          { shareBp: 5000, dueInDays: 0 },
          { shareBp: 4000, dueInDays: 30 },
        ],
      }),
    },
  );
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain(
    "add up to the whole quote",
  );

  // Refused means nothing happened: the quote is still convertible.
  const single = await app.request(
    `http://localhost/api/quotes/${made.quote.id}/convert`,
    { method: "POST", headers },
  );
  expect(single.status).toBe(201);
});

/**
 * Invoices that were issued before today.
 *
 * A business adopting Sentrello in June has invoices from January to put in.
 * Without a date of their own every one of them lands dated today, which
 * throws out the profit and loss, the tax summary and every report that groups
 * by month — the books are supposed to say when something happened.
 */
test("an invoice can be entered with the date it was actually issued", async () => {
  // Ten weeks back, which is the shape of the problem: a business adopting
  // mid-year entering what it billed before it arrived.
  const then = new Date(Date.now() - 70 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "USD",
      issueDate: then,
      lines: [
        {
          description: "Work done ten weeks ago",
          quantity: 1,
          unitPrice: 50_000,
        },
      ],
    }),
  });
  expect(res.status).toBe(201);
  const { invoice } = (await res.json()) as { invoice: { id: string } };

  const [row] = await db
    .select({ issueDate: schema.invoices.issueDate })
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoice.id));
  expect(row?.issueDate.toISOString().slice(0, 10)).toBe(then);
});

test("an invoice cannot be issued in the future", async () => {
  // It would sit outside every aging bucket while counting as income.
  const next = new Date(Date.now() + 30 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "USD",
      issueDate: next,
      lines: [
        { description: "Work not yet done", quantity: 1, unitPrice: 1000 },
      ],
    }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("future");
});

test("an invoice with no date given is dated today, as it always was", async () => {
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "USD",
      lines: [{ description: "Work done today", quantity: 1, unitPrice: 1000 }],
    }),
  });
  const { invoice } = (await res.json()) as { invoice: { id: string } };
  const [row] = await db
    .select({ issueDate: schema.invoices.issueDate })
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoice.id));
  expect(row?.issueDate.toISOString().slice(0, 10)).toBe(
    new Date().toISOString().slice(0, 10),
  );
});

test("a statement of account is Pro, and Free is told the endpoint is not there", async () => {
  // A statement is the document a customer asks for by phone. On Free the
  // endpoint does not exist at all — 404 rather than 403, matching
  // Subscriptions and the Pro dashboard, so nothing about an instance's
  // licence is inferable from the shape of the refusal.
  const free = new Hono<SentrelloEnv>();
  invoicing.register({
    app: free,
    entitled: (need) => !("tier" in need && need.tier === "pro"),
    registerNav: () => {},
    registerPermission: () => {},
    registerSummary: () => {},
    registerJob: () => {},
  });

  const refused = await free.request(
    `http://localhost/api/invoicing/statements/${contactId}`,
    { headers },
  );
  expect(refused.status).toBe(404);

  // And the same request on Pro reaches the statement, so the test above is
  // about the licence rather than about a route that never worked.
  const allowed = await app.request(
    `http://localhost/api/invoicing/statements/${contactId}`,
    { headers },
  );
  expect(allowed.status).toBe(200);
});

test("recurring invoicing is Pro, at the route as well as in the sidebar", async () => {
  // The screen being absent is not the gate. These four routes are, and a
  // bookmark from before a licence lapsed goes straight past a hidden nav.
  const free = new Hono<SentrelloEnv>();
  const navIds: string[] = [];
  invoicing.register({
    app: free,
    entitled: (need) => !("tier" in need && need.tier === "pro"),
    registerNav: (nav) => navIds.push(nav.id),
    registerPermission: () => {},
    registerSummary: () => {},
    registerJob: () => {},
  });

  expect(navIds).not.toContain("recurring");

  for (const [method, path] of [
    ["GET", "/api/invoicing/recurring"],
    ["POST", "/api/invoicing/recurring"],
    ["PATCH", "/api/invoicing/recurring/nothing"],
    ["DELETE", "/api/invoicing/recurring/nothing"],
  ] as const) {
    const res = await free.request(`http://localhost${path}`, {
      method,
      headers,
      ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }),
    });
    expect(`${method} ${res.status}`).toBe(`${method} 404`);
  }

  // And the same list answers on Pro, so the above is about the licence rather
  // than about routes that never worked.
  const allowed = await app.request(
    "http://localhost/api/invoicing/recurring",
    { headers },
  );
  expect(allowed.status).toBe(200);
});

test("a deal becomes a quote, carrying its customer, name and value", async () => {
  const [deal] = await db
    .insert(schema.deals)
    .values({
      organizationId: orgId,
      name: "Rewire the top floor",
      description: "Two circuits and a new consumer unit",
      amountCents: 240_000,
      contactIds: [contactId],
    })
    .returning();
  if (!deal) throw new Error("could not create the deal");

  const res = await app.request(`http://localhost/api/deals/${deal.id}/quote`, {
    method: "POST",
    headers,
  });
  expect(res.status).toBe(201);
  const { quote } = (await res.json()) as {
    quote: {
      id: string;
      contactId: string;
      dealId: string;
      totalCents: number;
      notes: string;
    };
  };

  // The three things a business would otherwise retype, and the three chances
  // to send a quote that does not match what was discussed.
  expect(quote.contactId).toBe(contactId);
  expect(quote.totalCents).toBe(240_000);
  expect(quote.notes).toBe("Two circuits and a new consumer unit");
  // So the deal can show what was quoted against it.
  expect(quote.dealId).toBe(deal.id);

  const lines = await db
    .select()
    .from(schema.quoteLines)
    .where(eq(schema.quoteLines.quoteId, quote.id));
  expect(lines).toHaveLength(1);
  expect(lines[0]?.description).toBe("Rewire the top floor");

  // It is a real quote, not a row that looks like one: it converts.
  const converted = await app.request(
    `http://localhost/api/quotes/${quote.id}/convert`,
    { method: "POST", headers, body: "{}" },
  );
  expect(converted.status).toBe(201);

  await db.delete(schema.deals).where(eq(schema.deals.id, deal.id));
});

test("a deal with nobody on it is refused rather than quoted to nobody", async () => {
  // A quote with no customer cannot be sent, shared or converted, and finding
  // that out after it is raised is worse than being told now.
  const [deal] = await db
    .insert(schema.deals)
    .values({
      organizationId: orgId,
      name: "Nobody's job",
      amountCents: 1000,
      contactIds: [],
    })
    .returning();
  if (!deal) throw new Error("could not create the deal");

  const res = await app.request(`http://localhost/api/deals/${deal.id}/quote`, {
    method: "POST",
    headers,
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("nobody");

  await db.delete(schema.deals).where(eq(schema.deals.id, deal.id));
});

test("another business's deal cannot be quoted", async () => {
  const [theirs] = await db
    .insert(schema.deals)
    .values({
      organizationId: `other-${suffix}`,
      name: "Not yours",
      amountCents: 5000,
      contactIds: [contactId],
    })
    .returning();
  if (!theirs) throw new Error("could not create the deal");

  const res = await app.request(
    `http://localhost/api/deals/${theirs.id}/quote`,
    { method: "POST", headers },
  );
  expect(res.status).toBe(404);

  await db.delete(schema.deals).where(eq(schema.deals.id, theirs.id));
});

test("a quote can be read on its own, and changed after it was raised", async () => {
  // Neither was possible: there was no route for one quote, so the number in
  // the list was styled as a link and did nothing, and a customer asking to
  // drop a line meant deleting the quote and starting again — losing its
  // number and its share link.
  const made = await app.request("http://localhost/api/quotes", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      lines: [
        { description: "Survey", quantityMilli: 1000, unitPriceCents: 40_000 },
        {
          description: "Second unit",
          quantityMilli: 1000,
          unitPriceCents: 60_000,
        },
      ],
    }),
  });
  expect(made.status).toBe(201);
  const { quote } = (await made.json()) as {
    quote: { id: string; totalCents: number };
  };
  expect(quote.totalCents).toBe(100_000);

  const read = await app.request(`http://localhost/api/quotes/${quote.id}`, {
    headers,
  });
  expect(read.status).toBe(200);
  const detail = (await read.json()) as {
    quote: { id: string };
    lines: { description: string }[];
    contact: { id: string } | null;
  };
  expect(detail.lines.map((l) => l.description)).toEqual([
    "Survey",
    "Second unit",
  ]);
  expect(detail.contact?.id).toBe(contactId);

  // "Drop the second unit."
  const edited = await app.request(`http://localhost/api/quotes/${quote.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      notes: "Revised after the site visit",
      lines: [
        { description: "Survey", quantityMilli: 1000, unitPriceCents: 40_000 },
      ],
    }),
  });
  expect(edited.status).toBe(200);

  const after = (await (
    await app.request(`http://localhost/api/quotes/${quote.id}`, { headers })
  ).json()) as {
    quote: { totalCents: number; notes: string; number: string };
    lines: { description: string }[];
  };
  // The total is recomputed from the lines, not trusted from the caller.
  expect(after.quote.totalCents).toBe(40_000);
  expect(after.lines.map((l) => l.description)).toEqual(["Survey"]);
  expect(after.quote.notes).toBe("Revised after the site visit");
});

test("a quote that has become an invoice can no longer be changed", async () => {
  // The invoice's lines were copied from these. Editing them afterwards would
  // leave two documents disagreeing about what was agreed, and the invoice is
  // the one that posted to the ledger.
  const made = await app.request("http://localhost/api/quotes", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      lines: [
        {
          description: "Agreed work",
          quantityMilli: 1000,
          unitPriceCents: 25_000,
        },
      ],
    }),
  });
  const { quote } = (await made.json()) as { quote: { id: string } };

  const converted = await app.request(
    `http://localhost/api/quotes/${quote.id}/convert`,
    { method: "POST", headers, body: "{}" },
  );
  expect(converted.status).toBe(201);

  const refused = await app.request(`http://localhost/api/quotes/${quote.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      lines: [
        {
          description: "Something else",
          quantityMilli: 1000,
          unitPriceCents: 1,
        },
      ],
    }),
  });
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { error: string }).error).toContain(
    "invoice",
  );

  // And nothing moved.
  const after = (await (
    await app.request(`http://localhost/api/quotes/${quote.id}`, { headers })
  ).json()) as { quote: { totalCents: number } };
  expect(after.quote.totalCents).toBe(25_000);
});

test("another business's quote can be neither read nor changed", async () => {
  const [theirs] = await db
    .insert(schema.quotes)
    .values({
      organizationId: `other-${suffix}`,
      number: `QUO-OTHER-${suffix}`,
      totalCents: 5000,
    })
    .returning();
  if (!theirs) throw new Error("could not create the quote");

  expect(
    (await app.request(`http://localhost/api/quotes/${theirs.id}`, { headers }))
      .status,
  ).toBe(404);
  expect(
    (
      await app.request(`http://localhost/api/quotes/${theirs.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ notes: "mine now" }),
      })
    ).status,
  ).toBe(404);

  await db.delete(schema.quotes).where(eq(schema.quotes.id, theirs.id));
});

test("a draft invoice is edited, and an issued one is refused", async () => {
  // The Edit action on a draft had existed in the menu since the screen was
  // written and did nothing: the form opened blank under the heading "Edit
  // invoice", and saving raised a *second* invoice.
  const made = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      // `status: "draft"` is what makes one; without it an invoice is issued
      // on creation and posts to the ledger immediately.
      status: "draft",
      contactId,
      lines: [
        {
          description: "First go",
          quantityMilli: 1000,
          unitPriceCents: 30_000,
        },
      ],
    }),
  });
  expect(made.status).toBe(201);
  const { invoice } = (await made.json()) as {
    invoice: { id: string; status: string };
  };
  expect(invoice.status).toBe("draft");

  const edited = await app.request(
    `http://localhost/api/invoices/${invoice.id}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        lines: [
          {
            description: "Corrected",
            quantityMilli: 2000,
            unitPriceCents: 30_000,
          },
        ],
      }),
    },
  );
  expect(edited.status).toBe(200);

  const after = (await (
    await app.request(`http://localhost/api/invoices/${invoice.id}`, {
      headers,
    })
  ).json()) as {
    invoice: { totalCents: number };
    lines: { description: string }[];
  };
  expect(after.lines.map((l) => l.description)).toEqual(["Corrected"]);
  expect(after.invoice.totalCents).toBe(60_000);

  // And no second invoice appeared. The old path POSTed, so editing a draft
  // raised another one and left the original untouched.
  const mine = await db
    .select({ id: schema.invoices.id })
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.organizationId, orgId),
        eq(schema.invoices.totalCents, 60_000),
      ),
    );
  expect(mine).toHaveLength(1);

  // Issuing posts to the ledger. After that the lines are what the books say.
  const issued = await app.request(
    `http://localhost/api/invoices/${invoice.id}/issue`,
    { method: "POST", headers, body: "{}" },
  );
  expect(issued.status).toBeLessThan(400);

  const refused = await app.request(
    `http://localhost/api/invoices/${invoice.id}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        lines: [
          { description: "Sneaky", quantityMilli: 1000, unitPriceCents: 1 },
        ],
      }),
    },
  );
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { error: string }).error).toContain(
    "credit note",
  );

  const untouched = (await (
    await app.request(`http://localhost/api/invoices/${invoice.id}`, {
      headers,
    })
  ).json()) as { invoice: { totalCents: number } };
  expect(untouched.invoice.totalCents).toBe(60_000);
});

/**
 * The screen is told about the offer, and told the same thing the route is.
 *
 * The discount could be set on an invoice and never taken: the payment form
 * had no way to say the customer paid early, so a business offering 2/10
 * net 30 either lost the discount or was short-paid and left showing a
 * balance nobody owed. The control that fixes that needs to know whether the
 * window is open — and if it worked that out in the browser there would be
 * two clocks and two implementations of "within ten days", so the answer
 * comes from the same helper the route uses.
 */
test("the invoice a screen reads carries its early-payment terms", async () => {
  const created = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      lines: [{ description: "Work", quantity: 1, unitPriceCents: 50_000 }],
      earlyDiscountType: "percent",
      earlyDiscountValue: 200,
      earlyDiscountDays: 10,
    }),
  });
  const { invoice } = (await created.json()) as { invoice: { id: string } };

  const detail = await app.request(
    `http://localhost/api/invoices/${invoice.id}`,
    { headers },
  );
  expect(detail.status).toBe(200);
  const read = (await detail.json()) as {
    earlyPayment: {
      deadline: string | null;
      savingCents: number;
      discountedTotalCents: number;
      open: boolean;
    };
    earlyDiscountTakenCents: number;
  };

  expect(read.earlyPayment.deadline).toBeTruthy();
  expect(read.earlyPayment.open).toBe(true);
  // 2% of 500.00.
  expect(read.earlyPayment.savingCents).toBe(1_000);
  expect(read.earlyPayment.discountedTotalCents).toBe(49_000);
  expect(read.earlyDiscountTakenCents).toBe(0);
});

test("an invoice offering nothing says so rather than a zero saving", async () => {
  const created = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      lines: [{ description: "Work", quantity: 1, unitPriceCents: 20_000 }],
    }),
  });
  const { invoice } = (await created.json()) as { invoice: { id: string } };

  const detail = await app.request(
    `http://localhost/api/invoices/${invoice.id}`,
    { headers },
  );
  const read = (await detail.json()) as {
    earlyPayment: { deadline: string | null; open: boolean };
  };
  // No deadline is what the screen keys on: an offer with no deadline is no
  // offer, and a checkbox saying "take 0.00 off" is worse than none.
  expect(read.earlyPayment.deadline).toBeNull();
  expect(read.earlyPayment.open).toBe(false);
});

/**
 * The early-payment discount, walked from the screen to the books.
 *
 * The route was tested and the numbers were right; nothing checked that the
 * *ledger* came out balanced when a discount is taken, and nothing walked the
 * path a person actually takes — read the invoice, see the offer, pay the
 * discounted total, and have the books agree afterwards.
 *
 * A discount that settles an invoice without recording where the money went
 * would pass every test above this one: the invoice says paid, the balance
 * says nought, and the accounts are quietly short by the saving.
 */
test("taking the discount settles the invoice and balances the books", async () => {
  const created = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      lines: [{ description: "Work", quantity: 1, unitPriceCents: 100_000 }],
      earlyDiscountType: "percent",
      earlyDiscountValue: 250,
      earlyDiscountDays: 10,
    }),
  });
  const { invoice } = (await created.json()) as {
    invoice: { id: string; number: string };
  };

  // 1. What the screen reads before it draws the offer.
  const detail = await app.request(
    `http://localhost/api/invoices/${invoice.id}`,
    { headers },
  );
  const read = (await detail.json()) as {
    earlyPayment: {
      open: boolean;
      savingCents: number;
      discountedTotalCents: number;
    };
  };
  expect(read.earlyPayment.open).toBe(true);
  expect(read.earlyPayment.savingCents).toBe(2_500);
  expect(read.earlyPayment.discountedTotalCents).toBe(97_500);

  // 2. Paying exactly what the box fills in when the offer is accepted.
  const paid = await app.request(
    `http://localhost/api/invoices/${invoice.id}/payments`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        amountCents: read.earlyPayment.discountedTotalCents,
        applyEarlyDiscount: true,
      }),
    },
  );
  expect(paid.status).toBe(201);
  const settled = (await paid.json()) as {
    status: string;
    balanceDue: number;
    payment: { id: string };
  };
  expect(settled.status).toBe("paid");
  expect(settled.balanceDue).toBe(0);

  // 3. And the books. Every financial event posts a balanced entry, and the
  //    saving has to appear as its own posting rather than vanishing.
  const [entry] = await db
    .select()
    .from(schema.journalEntries)
    .where(
      and(
        eq(schema.journalEntries.organizationId, orgId),
        eq(schema.journalEntries.source, `payment:${settled.payment.id}`),
      ),
    );
  expect(entry).toBeTruthy();
  if (!entry) throw new Error("no journal entry for the payment");
  expect(entry.memo).toContain("less early-payment discount");

  const lines = await db
    .select()
    .from(schema.journalLines)
    .where(eq(schema.journalLines.entryId, entry.id));

  const debits = lines.reduce((n, l) => n + l.debitCents, 0);
  const credits = lines.reduce((n, l) => n + l.creditCents, 0);
  expect(debits).toBe(credits);
  // Cash for what actually arrived, the saving written off as a discount, and
  // the whole invoice cleared from what customers owe.
  expect(debits).toBe(100_000);
  expect(lines.some((l) => l.debitCents === 97_500)).toBe(true);
  expect(lines.some((l) => l.debitCents === 2_500)).toBe(true);

  /*
   * Receivables are cleared in two postings, not one — 97,500 against the
   * payment and 2,500 against the discount — so what matters is the total
   * credited to the account, not a single line of it. Asserting one 100,000
   * line failed here first, and the assertion was wrong rather than the code:
   * two credits to one account is ordinary double-entry.
   */
  const creditedTo = new Map<string, number>();
  for (const line of lines) {
    if (line.creditCents > 0) {
      creditedTo.set(
        line.accountId,
        (creditedTo.get(line.accountId) ?? 0) + line.creditCents,
      );
    }
  }
  expect([...creditedTo.values()]).toContain(100_000);
});
