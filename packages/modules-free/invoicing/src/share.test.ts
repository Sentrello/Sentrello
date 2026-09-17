import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import { dropOrganization, dropUsers } from "@sentrello/db/testing";
import { registerForTest } from "@sentrello/module-sdk";
import { eq } from "drizzle-orm";
import invoicing from "./index";

/**
 * The page a customer opens does not ask for money that is not owed.
 *
 * It worked the balance out longhand — total, less payments, less credits —
 * which is wrong in the two cases that matter most to whoever reads it. A
 * **void** invoice showed a live balance and offered a discount for settling
 * it today, under a pill saying "Void". And an invoice settled in full under
 * its own early-payment terms showed the saving as "Still due", because the
 * saving settles the debt without any money arriving and nothing here knew.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const email = `invoicing-share-${suffix}@example.test`;
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
    body: { name: `Share ${suffix}`, slug: `share-${suffix}` },
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
    .values({ organizationId: orgId, name: "Okonkwo Joinery" })
    .returning();
  if (!contact) throw new Error("could not create test contact");
  contactId = contact.id;
});

afterAll(async () => {
  await dropOrganization(orgId);
  await dropUsers(email);
});

async function invoiceWith(body: Record<string, unknown>) {
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      lines: [{ description: "Fitting", quantity: 1, unitPrice: 100_000 }],
      ...body,
    }),
  });
  if (res.status >= 400) throw new Error(`invoice answered ${res.status}`);
  const { invoice } = (await res.json()) as { invoice: { id: string } };
  return invoice;
}

async function sharedPage(invoiceId: string) {
  const share = await app.request(
    `http://localhost/api/invoices/${invoiceId}/share`,
    { method: "POST", headers, body: "{}" },
  );
  const { url } = (await share.json()) as { url: string };
  const token = url.split("/").pop() as string;
  const page = await app.request(`http://localhost/share/invoice/${token}`, {
    headers: new Headers({ "x-real-ip": `10.0.0.${Math.random() * 200}` }),
  });
  expect(page.status).toBe(200);
  return page.text();
}

test("a voided invoice's page neither asks for money nor offers a discount", async () => {
  const invoice = await invoiceWith({
    earlyDiscountType: "percent",
    earlyDiscountValue: 200,
    earlyDiscountDays: 30,
  });
  const live = await sharedPage(invoice.id);
  expect(live).toContain("Pay by");

  const voided = await app.request(
    `http://localhost/api/invoices/${invoice.id}/void`,
    { method: "POST", headers, body: "{}" },
  );
  expect(voided.status).toBe(200);

  const page = await sharedPage(invoice.id);
  expect(page).toContain("Void");
  expect(page).not.toContain("Pay by");
  expect(page).not.toContain("Still due");
});

test("an invoice settled under its early-payment terms reads as settled", async () => {
  const invoice = await invoiceWith({
    earlyDiscountType: "percent",
    earlyDiscountValue: 200,
    earlyDiscountDays: 30,
  });
  const paid = await app.request(
    `http://localhost/api/invoices/${invoice.id}/payments`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ amountCents: 98_000, applyEarlyDiscount: true }),
    },
  );
  expect(paid.status).toBe(201);

  const [after] = await db
    .select({
      status: schema.invoices.status,
      taken: schema.invoices.earlyDiscountTakenCents,
    })
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoice.id));
  expect(after?.status).toBe("paid");
  expect(after?.taken).toBe(2_000);

  const page = await sharedPage(invoice.id);
  // The £20 it gave away is not a debt, and the page used to bill for it.
  expect(page).toContain("Settled");
  expect(page).not.toContain("Still due");
});
