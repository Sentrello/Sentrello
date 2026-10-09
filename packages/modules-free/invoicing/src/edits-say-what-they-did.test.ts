import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, schema } from "@sentrello/db";
import { dropOrganization } from "@sentrello/db/testing";
import { registerForTest } from "@sentrello/module-sdk";
import invoicing from "./index";

/**
 * An edit to a draft either saves what it was sent or says why not.
 *
 * Each of these answered 200 with nothing changed: a customer sent as `{}`, a
 * discount sent without the lines it is priced with, a currency other than the
 * one the document was raised in, a template sent as `{}` — and the form's own
 * `templateId: null` for "no letterhead", which left the old one on.
 *
 * Through `registerForTest`, so a refusal thrown by name is answered 400 as
 * the host answers it, rather than the bare app's 500.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const app = registerForTest(invoicing);

let orgId: string;
let headers: Headers;
let contactId: string;

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email: `edits-${suffix}@example.test`,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });
  const org = await auth.api.createOrganization({
    body: { name: `Edits ${suffix}`, slug: `edits-${suffix}` },
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
  await dropOrganization(orgId);
});

const send = (method: string, path: string, body: unknown) =>
  app.request(`http://localhost${path}`, {
    method,
    headers,
    body: JSON.stringify(body),
  });

test("a draft quote's edit is saved or refused, never answered 200 and dropped", async () => {
  const [letterhead] = await db
    .insert(schema.documentTemplates)
    .values({ organizationId: orgId, name: `Letterhead ${suffix}` })
    .returning();
  if (!letterhead) throw new Error("no template");

  const made = await send("POST", "/api/quotes", {
    contactId,
    templateId: letterhead.id,
    lines: [{ description: "A visit", quantity: 1, unitPriceCents: 10_000 }],
  });
  expect(made.status).toBe(201);
  const { quote } = (await made.json()) as {
    quote: { id: string; currency: string; templateId: string | null };
  };
  expect(quote.templateId).toBe(letterhead.id);

  const other = quote.currency === "EUR" ? "USD" : "EUR";
  for (const [wrong, says] of [
    [{ contactId: {} }, "contactId"],
    [{ templateId: ["x"] }, "templateId"],
    [{ discountType: "percent", discountValue: 1000 }, "lines"],
    [{ currency: other }, quote.currency],
  ] as const) {
    const res = await send("PATCH", `/api/quotes/${quote.id}`, wrong);
    expect(res.status, JSON.stringify(wrong)).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(says);
  }

  // The form's null for "no letterhead" takes it off.
  const cleared = await send("PATCH", `/api/quotes/${quote.id}`, {
    templateId: null,
  });
  expect(cleared.status).toBe(200);
  const [row] = await db
    .select({ templateId: schema.quotes.templateId })
    .from(schema.quotes)
    .where(eq(schema.quotes.id, quote.id));
  expect(row?.templateId).toBeNull();
});

test("the invoicing settings refuse a word or a number of the wrong kind", async () => {
  for (const wrong of [
    { overpaymentPolicy: "keep" },
    { lateFeeType: "daily" },
    { defaultDueDays: [] },
    { pricesIncludeTax: "yes" },
  ]) {
    const res = await send("PUT", "/api/invoicing/settings", wrong);
    expect(res.status, JSON.stringify(wrong)).toBe(400);
  }
});

/**
 * A field of the wrong type is refused by name, and what was stored stays.
 *
 * Each of these read the field only when it was already the right type, so a
 * list or an object where a name, a number of days or a customer belonged was
 * quietly skipped: nothing changed, and the answer was 200.
 */
test("an edit with a wrongly typed field is refused, not quietly skipped", async () => {
  const item = (await (
    await app.request("http://localhost/api/invoicing/items", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: `Typed ${suffix}`, unitPriceCents: 500 }),
    })
  ).json()) as { item: { id: string } };
  const renamed = await app.request(
    `http://localhost/api/invoicing/items/${item.item.id}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: ["Other"], sku: "X1" }),
    },
  );
  expect(renamed.status).toBe(400);
  expect(((await renamed.json()) as { error: string }).error).toContain("name");
  const [kept] = await db
    .select({ name: schema.billableItems.name })
    .from(schema.billableItems)
    .where(eq(schema.billableItems.id, item.item.id));
  expect(kept?.name).toBe(`Typed ${suffix}`);

  const rule = (await (
    await app.request("http://localhost/api/invoicing/reminders", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Nudge",
        subject: "A reminder",
        body: "It is due",
        daysOffset: 3,
      }),
    })
  ).json()) as { rule: { id: string } };
  const moved = await app.request(
    `http://localhost/api/invoicing/reminders/${rule.rule.id}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({ daysOffset: "three", name: "Renamed" }),
    },
  );
  expect(moved.status).toBe(400);
  const [still] = await db
    .select({ daysOffset: schema.reminderRules.daysOffset })
    .from(schema.reminderRules)
    .where(eq(schema.reminderRules.id, rule.rule.id));
  expect(still?.daysOffset).toBe(3);

  const quote = (await (
    await app.request("http://localhost/api/quotes", {
      method: "POST",
      headers,
      body: JSON.stringify({
        contactId,
        lines: [
          { description: "Typed", quantityMilli: 1000, unitPriceCents: 100 },
        ],
      }),
    })
  ).json()) as { quote: { id: string } };
  const reassigned = await app.request(
    `http://localhost/api/quotes/${quote.quote.id}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({ contactId: {}, notes: "Moved" }),
    },
  );
  expect(reassigned.status).toBe(400);
  const [same] = await db
    .select({ contactId: schema.quotes.contactId })
    .from(schema.quotes)
    .where(eq(schema.quotes.id, quote.quote.id));
  expect(same?.contactId).toBe(contactId);
});
