import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, inArray, schema } from "@sentrello/db";
import { registerForTest } from "@sentrello/module-sdk";
import invoicing from "./index";

/**
 * Merging drafts, and whose drafts they are.
 *
 * `/api/invoices/consolidate` takes invoice ids straight from the request
 * body. The only thing standing between that and another business's documents
 * is one `organizationId` predicate on the lookup, and nothing held it there —
 * deleting that line broke no test.
 *
 * What it would cost is not an error message: the route reads the sources,
 * copies their lines into a new invoice and voids the originals. Without the
 * predicate a caller who knows an id merges somebody else's drafts into their
 * own invoice and voids the other business's documents on the way out. The ids
 * are uuids, which is not a permission.
 *
 * The other business's invoice is written directly rather than through a
 * second session, because what is being tested is the lookup, not sign-up.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const email = `consolidate-${suffix}@example.test`;
const theirs = `consolidate-other-${suffix}`;

const app = registerForTest(invoicing);
let orgId: string;
let headers: Headers;
let theirInvoiceId: string;

/** A draft belonging to whoever is named, written straight in. */
async function draftFor(organizationId: string, number: string) {
  const [row] = await db
    .insert(schema.invoices)
    .values({
      organizationId,
      number,
      status: "draft",
      currency: "USD",
      subtotalCents: 5000,
      totalCents: 5000,
    })
    .returning({ id: schema.invoices.id });
  if (!row) throw new Error("could not write a draft");
  // A draft with no lines is not mergeable — the route says so, and a test
  // that never gets past that check is not testing the lookup.
  await db.insert(schema.invoiceLines).values({
    invoiceId: row.id,
    description: `Work for ${number}`,
    unitPriceCents: 5000,
  });
  return row.id;
}

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const set = signUp.headers.get("set-cookie");
  if (!set) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie: set, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Consolidate ${suffix}`, slug: `consolidate-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  await db.insert(schema.organizations).values({
    id: theirs,
    name: "Somebody else",
    slug: theirs,
    countryCode: "US",
    createdAt: new Date(),
  });
  theirInvoiceId = await draftFor(theirs, "THEIRS-0001");
});

afterAll(async () => {
  for (const org of [orgId, theirs]) {
    const rows = await db
      .select({ id: schema.invoices.id })
      .from(schema.invoices)
      .where(eq(schema.invoices.organizationId, org));
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      await db
        .delete(schema.invoiceLines)
        .where(inArray(schema.invoiceLines.invoiceId, ids));
      await db.delete(schema.invoices).where(inArray(schema.invoices.id, ids));
    }
  }
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(inArray(schema.organizations.id, [orgId, theirs]));
});

const consolidate = (invoiceIds: string[]) =>
  app.request("http://localhost/api/invoices/consolidate", {
    method: "POST",
    headers,
    body: JSON.stringify({ invoiceIds }),
  });

test("another business's draft cannot be merged into yours", async () => {
  const mine = await draftFor(orgId, `MINE-${suffix}-1`);
  const res = await consolidate([mine, theirInvoiceId]);

  expect(res.status, "a foreign invoice id was accepted for merging").toBe(404);

  // And it is still theirs, still a draft, still there.
  const [after] = await db
    .select({
      status: schema.invoices.status,
      org: schema.invoices.organizationId,
    })
    .from(schema.invoices)
    .where(eq(schema.invoices.id, theirInvoiceId));
  expect(after?.org).toBe(theirs);
  expect(after?.status, "the other business's draft was voided").toBe("draft");
});

test("an id nobody owns is refused the same way, with no hint", async () => {
  // The same answer as a foreign id: "one of those does not exist" tells a
  // caller nothing about whether it exists somewhere else.
  const mine = await draftFor(orgId, `MINE-${suffix}-2`);
  const res = await consolidate([mine, crypto.randomUUID()]);
  expect(res.status).toBe(404);
});

test("and two of your own drafts still merge", async () => {
  // The refusal above is only worth anything if the route otherwise works.
  const a = await draftFor(orgId, `MINE-${suffix}-3`);
  const b = await draftFor(orgId, `MINE-${suffix}-4`);
  const res = await consolidate([a, b]);
  expect(res.status, await res.clone().text()).toBe(201);
});

test("one draft is not a merge", async () => {
  const only = await draftFor(orgId, `MINE-${suffix}-5`);
  const res = await consolidate([only]);
  expect(res.status).toBe(400);
});
