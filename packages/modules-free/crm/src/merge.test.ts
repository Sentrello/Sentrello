import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import { postJournalEntry } from "@sentrello/db/ledger";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import crm from "./index";

const suffix = crypto.randomUUID().slice(0, 8);
const email = `crm-merge-${suffix}@example.test`;
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
    body: { name: `Merge ${suffix}`, slug: `merge-${suffix}` },
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
  // Journal lines carry no organizationId of their own — they hang from
  // their entry, so they go first, by the entries this organization owns.
  const entries = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));
  for (const entry of entries) {
    await db
      .delete(schema.journalLines)
      .where(eq(schema.journalLines.entryId, entry.id));
  }
  for (const [table, column] of [
    [schema.contactMerges, schema.contactMerges.organizationId],
    [
      schema.contactDuplicateDismissals,
      schema.contactDuplicateDismissals.organizationId,
    ],
    [schema.recordEvents, schema.recordEvents.organizationId],
    [schema.journalEntries, schema.journalEntries.organizationId],
    [schema.accounts, schema.accounts.organizationId],
    [schema.invoices, schema.invoices.organizationId],
    [schema.quotes, schema.quotes.organizationId],
    [schema.notes, schema.notes.organizationId],
    [schema.tasks, schema.tasks.organizationId],
    [schema.activities, schema.activities.organizationId],
    [schema.deals, schema.deals.organizationId],
    [schema.contacts, schema.contacts.organizationId],
    [schema.securityEvents, schema.securityEvents.organizationId],
    [schema.crmSettings, schema.crmSettings.organizationId],
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

/** The whole of this organization's books, as three figures. */
async function ledgerFigures() {
  return db
    .select({
      lines: sql<number>`count(*)::int`,
      debits: sql<number>`coalesce(sum(${schema.journalLines.debitCents}), 0)::int`,
      credits: sql<number>`coalesce(sum(${schema.journalLines.creditCents}), 0)::int`,
    })
    .from(schema.journalLines)
    .innerJoin(
      schema.journalEntries,
      eq(schema.journalLines.entryId, schema.journalEntries.id),
    )
    .where(eq(schema.journalEntries.organizationId, orgId));
}

async function makeContact(values: Record<string, unknown>) {
  const [row] = await db
    .insert(schema.contacts)
    .values({ organizationId: orgId, name: "X", ...values })
    .returning();
  if (!row) throw new Error("could not create contact");
  return row;
}

test("likely duplicates are proposed, with the reason, and nothing is merged", async () => {
  const a = await makeContact({
    name: "Ruth Adeyemi",
    email: "ruth@adeyemi.test",
  });
  const b = await makeContact({
    name: "R Adeyemi",
    email: "Ruth@Adeyemi.test", // same address, different case
  });
  const c = await makeContact({
    name: "Same Landline",
    phone: "+1 (555) 010-2000",
  });
  const d = await makeContact({
    name: "Same Landline", // and the same name — two reasons, email wins none
    phone: "555 010 2000",
  });

  const res = await app.request("http://localhost/api/contacts/duplicates", {
    headers,
  });
  expect(res.status).toBe(200);
  const { pairs } = (await res.json()) as {
    pairs: { a: { id: string }; b: { id: string }; reason: string }[];
  };

  const emailPair = pairs.find(
    (p) => [p.a.id, p.b.id].includes(a.id) && [p.a.id, p.b.id].includes(b.id),
  );
  expect(emailPair?.reason).toBe("same email");
  const phonePair = pairs.find(
    (p) => [p.a.id, p.b.id].includes(c.id) && [p.a.id, p.b.id].includes(d.id),
  );
  expect(phonePair?.reason).toBe("same phone");

  // Proposing is not merging: all four are still here.
  const all = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.organizationId, orgId));
  expect(all.length).toBeGreaterThanOrEqual(4);
});

test("a dismissed pair stops being proposed", async () => {
  const res = await app.request("http://localhost/api/contacts/duplicates", {
    headers,
  });
  const { pairs } = (await res.json()) as {
    pairs: { a: { id: string; name: string }; b: { id: string } }[];
  };
  const phonePair = pairs.find((p) => p.a.name === "Same Landline");
  if (!phonePair) throw new Error("the phone pair was not proposed");

  const dismissed = await app.request(
    "http://localhost/api/contacts/duplicates/dismiss",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ aId: phonePair.a.id, bId: phonePair.b.id }),
    },
  );
  expect(dismissed.status).toBe(200);

  const again = await app.request("http://localhost/api/contacts/duplicates", {
    headers,
  });
  const after = (await again.json()) as {
    pairs: { a: { name: string } }[];
  };
  expect(after.pairs.some((p) => p.a.name === "Same Landline")).toBe(false);
});

test("a merge re-points everything, changes no ledger figure, and writes itself down", async () => {
  const kept = await makeContact({
    name: "Dana Kept",
    email: "dana@kept.test",
    phone: null,
    title: null,
  });
  const merged = await makeContact({
    name: "Dana Merged",
    email: "dana@kept.test",
    phone: "555 300 4000",
    title: "Facilities Manager",
    doNotSell: true,
    doNotSellOn: new Date("2026-01-05T00:00:00Z"),
  });

  // Everything that can hang off a contact, hung off the one to be merged.
  await db.insert(schema.notes).values({
    organizationId: orgId,
    entityType: "contact",
    entityId: merged.id,
    text: "prefers email",
  });
  await db.insert(schema.tasks).values({
    organizationId: orgId,
    title: "call about renewal",
    contactId: merged.id,
  });
  await db.insert(schema.activities).values({
    organizationId: orgId,
    contactId: merged.id,
    type: "call",
    body: "spoke on Monday",
  });
  const [deal] = await db
    .insert(schema.deals)
    .values({
      organizationId: orgId,
      name: "Boiler replacement",
      contactIds: [merged.id, kept.id], // both on it — must not double up
      amountCents: 250_000,
    })
    .returning();
  const [invoice] = await db
    .insert(schema.invoices)
    .values({
      organizationId: orgId,
      contactId: merged.id,
      number: `INV-${suffix}-1`,
      totalCents: 120_000,
      status: "open",
    })
    .returning();
  await db.insert(schema.quotes).values({
    organizationId: orgId,
    contactId: merged.id,
    number: `Q-${suffix}-1`,
  });

  // The money behind that invoice, posted properly, so the books have
  // figures a merge could conceivably disturb.
  const [ar] = await db
    .insert(schema.accounts)
    .values({
      organizationId: orgId,
      code: "1100",
      name: "Accounts Receivable",
      type: "asset",
    })
    .returning();
  const [sales] = await db
    .insert(schema.accounts)
    .values({
      organizationId: orgId,
      code: "4000",
      name: "Sales",
      type: "income",
    })
    .returning();
  if (!ar || !sales || !invoice || !deal) throw new Error("seed failed");
  await postJournalEntry(orgId, "invoice raised", `invoice:${invoice.id}`, [
    { accountId: ar.id, debitCents: 120_000 },
    { accountId: sales.id, creditCents: 120_000 },
  ]);

  const ledgerBefore = await ledgerFigures();

  const res = await app.request(
    `http://localhost/api/contacts/${kept.id}/merge`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ mergedId: merged.id }),
    },
  );
  expect(res.status).toBe(200);
  const outcome = (await res.json()) as {
    contact: {
      id: string;
      phone: string | null;
      title: string | null;
      doNotSell: boolean;
    };
    moved: Record<string, number>;
  };

  // The kept contact drank in what it was missing, and the stricter legal
  // position survives the merge.
  expect(outcome.contact.id).toBe(kept.id);
  expect(outcome.contact.phone).toBe("555 300 4000");
  expect(outcome.contact.title).toBe("Facilities Manager");
  expect(outcome.contact.doNotSell).toBe(true);

  // Nothing anywhere still points at the merged contact.
  const [note] = await db
    .select()
    .from(schema.notes)
    .where(
      and(
        eq(schema.notes.entityType, "contact"),
        eq(schema.notes.entityId, kept.id),
      ),
    );
  expect(note?.text).toBe("prefers email");
  const [task] = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.contactId, kept.id));
  expect(task?.title).toBe("call about renewal");
  const [activity] = await db
    .select()
    .from(schema.activities)
    .where(eq(schema.activities.contactId, kept.id));
  expect(activity?.body).toBe("spoke on Monday");
  const [dealAfter] = await db
    .select()
    .from(schema.deals)
    .where(eq(schema.deals.id, deal.id));
  expect(dealAfter?.contactIds).toEqual([kept.id]);
  const [invoiceAfter] = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoice.id));
  expect(invoiceAfter?.contactId).toBe(kept.id);
  const [quoteAfter] = await db
    .select()
    .from(schema.quotes)
    .where(eq(schema.quotes.organizationId, orgId));
  expect(quoteAfter?.contactId).toBe(kept.id);

  for (const [table, column] of [
    [schema.tasks, schema.tasks.contactId],
    [schema.activities, schema.activities.contactId],
    [schema.invoices, schema.invoices.contactId],
    [schema.quotes, schema.quotes.contactId],
    [schema.notes, schema.notes.entityId],
  ] as const) {
    const orphans = await db.select().from(table).where(eq(column, merged.id));
    expect(orphans).toHaveLength(0);
  }

  // The merged row is gone, and the record of the merge says what happened.
  const [gone] = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.id, merged.id));
  expect(gone).toBeUndefined();
  const [written] = await db
    .select()
    .from(schema.contactMerges)
    .where(eq(schema.contactMerges.organizationId, orgId));
  expect(written?.keptId).toBe(kept.id);
  expect(written?.mergedId).toBe(merged.id);
  expect(written?.mergedRecord.name).toBe("Dana Merged");
  expect(outcome.moved.invoices).toBe(1);
  expect(outcome.moved.deals).toBe(1);

  // The books did not move by a cent.
  const ledgerAfter = await ledgerFigures();
  expect(ledgerAfter).toEqual(ledgerBefore);
  expect(ledgerAfter[0]?.debits).toBe(120_000);
});

test("merging refuses a contact from another organization", async () => {
  const kept = await makeContact({ name: "Local" });
  const [foreign] = await db
    .insert(schema.contacts)
    .values({ organizationId: `foreign-${suffix}`, name: "Foreign" })
    .returning();
  if (!foreign) throw new Error("could not create foreign contact");

  const res = await app.request(
    `http://localhost/api/contacts/${kept.id}/merge`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ mergedId: foreign.id }),
    },
  );
  expect(res.status).toBe(404);
  const [still] = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.id, foreign.id));
  expect(still).toBeDefined();
  await db
    .delete(schema.contacts)
    .where(eq(schema.contacts.organizationId, `foreign-${suffix}`));
});

test("a contact cannot be merged into itself", async () => {
  const one = await makeContact({ name: "Only One" });
  const res = await app.request(
    `http://localhost/api/contacts/${one.id}/merge`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ mergedId: one.id }),
    },
  );
  expect(res.status).toBe(400);
});

test("two contacts that both hold contractor tax details refuse to merge", async () => {
  const kept = await makeContact({ name: "Taxed Kept" });
  const merged = await makeContact({ name: "Taxed Merged" });
  await db.insert(schema.contractorTaxDetails).values([
    { organizationId: orgId, contactId: kept.id },
    { organizationId: orgId, contactId: merged.id },
  ]);

  const res = await app.request(
    `http://localhost/api/contacts/${kept.id}/merge`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ mergedId: merged.id }),
    },
  );
  expect(res.status).toBe(409);

  // Refused whole: both contacts still exist, nothing half-moved.
  const both = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.organizationId, orgId));
  expect(both.some((c) => c.id === merged.id)).toBe(true);

  await db
    .delete(schema.contractorTaxDetails)
    .where(eq(schema.contractorTaxDetails.organizationId, orgId));
});
