import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, schema } from "@sentrello/db";
import { registerForTest } from "@sentrello/module-sdk";
import accounting from "./index";

/**
 * The form a US business files in January about who it paid.
 *
 * Three rules decide what goes on it, and each of them is a wrong return if it
 * is missed: only what was actually paid inside the calendar year, never what
 * a card or a payment network settled, and only for suppliers the business
 * says are reportable. Everything below is one of those three.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const app = registerForTest(accounting);

let headers: Headers;
let orgId: string;
let fuel = "";
let cash = "";
let joiner = "";
let plasterer = "";
let acme = "";
/**
 * The second business, remembered rather than tidied where it is made.
 *
 * An organization left behind becomes the oldest on the instance, and the
 * sign-in log resolves an attempt against an unknown address to that.
 */
let otherOrgId: string | null = null;

const req = (path: string, init?: RequestInit) =>
  app.request(`http://localhost${path}`, { headers, ...init });
const post = (path: string, body: unknown) =>
  req(path, { method: "POST", body: JSON.stringify(body) });
const put = (path: string, body: unknown) =>
  req(path, { method: "PUT", body: JSON.stringify(body) });

async function account(code: string, name: string, type: string) {
  const res = await post("/api/accounts", { code, name, type });
  const { account: made } = (await res.json()) as { account: { id: string } };
  return made.id;
}

/** A supplier, which is a contact the CRM owns. */
async function contact(name: string) {
  const [row] = await db
    .insert(schema.contacts)
    .values({ organizationId: orgId, name })
    .returning();
  if (!row) throw new Error("the contact was not written");
  return row.id;
}

/** Money paid straight out to somebody, with no bill behind it. */
const payDirect = (
  contactId: string,
  amountCents: number,
  at: string,
  method?: string,
) =>
  post("/api/expenses", {
    amountCents,
    accountId: fuel,
    paidThroughAccountId: cash,
    occurredAt: at,
    contactId,
    description: "Work",
    ...(method ? { method } : {}),
  });

async function form(year: number) {
  const res = await req(`/api/reports/1099?year=${year}`);
  const body = (await res.json()) as {
    rows: {
      contactId: string;
      totalCents: number;
      excludedCents: number;
      reportable: boolean;
      missing: string[];
      taxIdLast4: string | null;
    }[];
  };
  return body.rows;
}

const rowFor = (rows: Awaited<ReturnType<typeof form>>, id: string) =>
  rows.find((row) => row.contactId === id);

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email: `ten99-${suffix}@x.test`,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Ten99 ${suffix}`, slug: `ten99-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  fuel = await account("6100", "Subcontractors", "expense");
  cash = await account("1000", "Cash", "asset");
  joiner = await contact("Sam the joiner");
  plasterer = await contact("Pat the plasterer");
  acme = await contact("Acme Supplies Inc");
});

afterAll(async () => {
  if (otherOrgId) {
    for (const t of [
      schema.contractorTaxDetails,
      schema.contacts,
      schema.securityEvents,
    ]) {
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
  for (const t of [
    schema.contractorTaxDetails,
    schema.transactions,
    schema.journalEntries,
    schema.contacts,
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

/**
 * A taxpayer number is a social security number for most sole traders.
 *
 * It is sealed in the database and never comes back out of any route. What a
 * screen gets is the last four, which is enough to recognise and useless to
 * anybody who reads it.
 */
test("a taxpayer number is sealed and never returned", async () => {
  const saved = await put(`/api/contractors/${joiner}`, {
    legalName: "Samuel Carpenter",
    entityType: "sole-proprietor",
    taxId: "123-45-6789",
    addressLine1: "1 High Street",
    city: "Leeds",
    region: "NY",
    postalCode: "10001",
  });
  expect(saved.status).toBe(200);

  const listed = await req("/api/contractors");
  const body = (await listed.clone().json()) as {
    contractors: Record<string, unknown>[];
  };
  const text = await listed.text();
  expect(text).not.toContain("123456789");
  expect(text).not.toContain("123-45-6789");
  expect(text).toContain("6789");

  /**
   * And the sealed value does not come out either.
   *
   * Checking only for the plaintext passes for a response that hands back the
   * ciphertext, which is a secret leaving the database on every page load and
   * needing only the key to read. The field is not there at all.
   */
  for (const row of body.contractors) {
    expect("taxId" in row).toBe(false);
  }

  const [row] = await db
    .select()
    .from(schema.contractorTaxDetails)
    .where(eq(schema.contractorTaxDetails.contactId, joiner))
    .limit(1);
  // Sealed at rest, not merely absent from the response.
  expect(row?.taxId).not.toContain("123456789");
  expect(row?.taxIdLast4).toBe("6789");

  // And somebody handling one is written down.
  const events = await db
    .select()
    .from(schema.securityEvents)
    .where(eq(schema.securityEvents.organizationId, orgId));
  expect(events.map((e) => e.action)).toContain("contractor.tax-id.set");
});

/**
 * An address change must not wipe the number it was never shown.
 *
 * The screen shows the last four and never the whole thing, so it cannot send
 * back what it does not have — and a save that treated "absent" as "clear it"
 * would quietly lose the identification every January depends on.
 */
test("saving without a taxpayer number leaves the one on file alone", async () => {
  await put(`/api/contractors/${joiner}`, {
    legalName: "Samuel Carpenter",
    addressLine1: "2 Low Street",
    city: "Leeds",
    region: "NY",
    postalCode: "10001",
  });
  const [row] = await db
    .select()
    .from(schema.contractorTaxDetails)
    .where(eq(schema.contractorTaxDetails.contactId, joiner))
    .limit(1);
  expect(row?.taxIdLast4).toBe("6789");
  expect(row?.addressLine1).toBe("2 Low Street");
});

test("a number that is not nine digits is refused", async () => {
  const res = await put(`/api/contractors/${plasterer}`, { taxId: "12345" });
  expect(res.status).toBe(400);
});

/**
 * The threshold, and the year.
 *
 * Six hundred dollars in a calendar year, counted from when the money moved. A
 * bill dated in December and paid in January is the January year's form, which
 * is why this reads payments and not bills.
 */
test("only what was paid inside the year counts, against the threshold", async () => {
  await put(`/api/contractors/${plasterer}`, {
    legalName: "Patricia Plaster",
    taxId: "987654321",
    addressLine1: "3 Mill Lane",
    city: "Leeds",
    region: "NY",
    postalCode: "10001",
  });

  await payDirect(plasterer, 40_000, "2026-11-30T00:00:00Z");
  await payDirect(plasterer, 30_000, "2027-01-04T00:00:00Z");

  const y2026 = rowFor(await form(2026), plasterer);
  expect(y2026?.totalCents).toBe(40_000);
  // Four hundred dollars is under six hundred: nothing is filed.
  expect(y2026?.reportable).toBe(false);

  const y2027 = rowFor(await form(2027), plasterer);
  expect(y2027?.totalCents).toBe(30_000);
});

test("six hundred dollars in a year is the line", async () => {
  await payDirect(plasterer, 20_000, "2026-12-01T00:00:00Z");
  const row = rowFor(await form(2026), plasterer);
  expect(row?.totalCents).toBe(60_000);
  // Exactly six hundred is reportable.
  expect(row?.reportable).toBe(true);
});

/**
 * Card and network payments are somebody else's form.
 *
 * The processor files a 1099-K for those. A business that reports them too has
 * the contractor's income declared twice by two different filers, which is a
 * letter from the IRS for a contractor who did nothing wrong.
 */
test("what a card settled is kept off the form, and shown", async () => {
  await payDirect(joiner, 90_000, "2026-05-01T00:00:00Z", "card");
  await payDirect(joiner, 70_000, "2026-06-01T00:00:00Z", "bank");

  const row = rowFor(await form(2026), joiner);
  expect(row?.totalCents).toBe(70_000);
  // Shown rather than hidden: somebody who knows they paid $1,600 needs to
  // see why the form says $700 or they assume the software is wrong.
  expect(row?.excludedCents).toBe(90_000);
});

test("a supplier the business does not report on is not on the form", async () => {
  await put(`/api/contractors/${acme}`, {
    legalName: "Acme Supplies Inc",
    entityType: "corporation",
    reportable: false,
  });
  await payDirect(acme, 500_000, "2026-04-01T00:00:00Z");

  expect(rowFor(await form(2026), acme)).toBeUndefined();
});

test("a supplier nobody has said anything about is not on the form", async () => {
  const stranger = await contact("Somebody else");
  await payDirect(stranger, 800_000, "2026-04-01T00:00:00Z");
  // The default for a supplier with no tax record is that there is no form.
  expect(rowFor(await form(2026), stranger)).toBeUndefined();
});

/**
 * What would stop the form being filed, said in December.
 *
 * Discovering in January that a contractor's number was never collected means
 * chasing somebody who has moved on.
 */
test("the report says what is missing before January", async () => {
  const late = await contact("Chris no-details");
  await put(`/api/contractors/${late}`, { reportable: true });
  await payDirect(late, 120_000, "2026-07-01T00:00:00Z");

  const row = rowFor(await form(2026), late);
  expect(row?.reportable).toBe(true);
  expect(row?.missing).toContain("taxpayer number");
  expect(row?.missing).toContain("legal name");
  expect(row?.missing).toContain("address");

  // And nothing is missing for the one that was filled in properly.
  expect(rowFor(await form(2026), joiner)?.missing).toEqual([]);
});

/**
 * Tax kept back is not money the contractor received.
 *
 * It is owed to the authority and belongs in a different box. Counting it as
 * paid overstates the contractor's income by the amount they never got.
 */
test("tax withheld from a payment is not what the contractor was paid", async () => {
  const withheld = await contact("Withheld Wendy");
  await put(`/api/contractors/${withheld}`, {
    legalName: "Wendy W",
    taxId: "111223333",
    addressLine1: "9 The Green",
    city: "Leeds",
    region: "NY",
    postalCode: "10001",
  });

  const made = await post("/api/bills", {
    vendorId: withheld,
    billDate: "2026-03-01T00:00:00Z",
    lines: [
      {
        description: "Work",
        quantity: 1,
        unitPriceCents: 100_000,
        accountId: fuel,
      },
    ],
  });
  const { bill } = (await made.json()) as { bill: { id: string } };
  await post(`/api/bills/${bill.id}/approve`, {});
  await post(`/api/bills/${bill.id}/payments`, {
    amountCents: 100_000,
    withheldCents: 20_000,
    paidThroughAccountId: cash,
    paidAt: "2026-03-15T00:00:00Z",
    method: "bank",
  });

  const row = rowFor(await form(2026), withheld);
  expect(row?.totalCents).toBe(80_000);
});

/**
 * A real contact, in a real second business.
 *
 * An id that exists nowhere answers 404 whether the route is scoped or not, so
 * that version of this test held nothing. This one uses a contact that exists
 * and belongs to somebody else — which is what a leak would look like, and
 * what would put another business's contractor's tax number in our database.
 */
test("another business's contact cannot be given tax details", async () => {
  const other = await auth.api.createOrganization({
    body: { name: `Other ${suffix}`, slug: `other-ten99-${suffix}` },
    headers,
  });
  if (!other) throw new Error("could not create the second organization");
  otherOrgId = other.id;

  /**
   * Back to our own business before asking.
   *
   * Creating an organization can make it the active one, and a request that
   * arrives as the second business is a request about its own contact — which
   * answers 200 and proves nothing.
   */
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  const [theirs] = await db
    .insert(schema.contacts)
    .values({ organizationId: other.id, name: "Their contractor" })
    .returning();
  if (!theirs) throw new Error("their contact was not written");

  const res = await put(`/api/contractors/${theirs.id}`, {
    legalName: "Theirs",
    taxId: "222334444",
  });
  expect(res.status).toBe(404);

  // And nothing was written against them.
  const rows = await db
    .select()
    .from(schema.contractorTaxDetails)
    .where(eq(schema.contractorTaxDetails.contactId, theirs.id));
  expect(rows).toHaveLength(0);
});

test("a year that is not a year is refused", async () => {
  expect((await req("/api/reports/1099?year=nineteen")).status).toBe(400);
});
