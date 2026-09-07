import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, schema } from "@sentrello/db";
import { registerForTest } from "@sentrello/module-sdk";
import accounting from "./index";

/**
 * The one thing a business is asked about that the product does not know.
 *
 * A purchase-order number, a job reference, which van the fuel went into.
 * Without somewhere to put it a bookkeeper keeps a spreadsheet beside the
 * product, which is the thing this is meant to replace.
 *
 * The rules are the platform's, shared with the CRM, and are tested there.
 * What is tested here is that the accounting module wires them to its own
 * records — and, above all, that a value is only ever stored against a field
 * somebody defined. The body of a request is not a schema.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const app = registerForTest(accounting);

let headers: Headers;
let orgId: string;
let fuel = "";
/**
 * The second business, remembered rather than tidied where it is made.
 *
 * An organization left behind becomes the oldest on the instance, and the
 * sign-in log resolves an attempt against an unknown address to that.
 */
let otherOrgId: string | null = null;
let cash = "";

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

const define = (fields: unknown) =>
  put("/api/accounting/custom-fields", { customFields: fields });

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email: `fields-${suffix}@x.test`,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Fields ${suffix}`, slug: `fields-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  fuel = await account("6100", "Fuel", "expense");
  cash = await account("1000", "Cash", "asset");
});

afterAll(async () => {
  if (otherOrgId) {
    for (const t of [schema.ledgerSettings, schema.securityEvents]) {
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
  const bills = await db
    .select({ id: schema.bills.id })
    .from(schema.bills)
    .where(eq(schema.bills.organizationId, orgId));
  for (const row of bills) {
    await db
      .delete(schema.billLines)
      .where(eq(schema.billLines.billId, row.id));
  }
  for (const t of [
    schema.bills,
    schema.transactions,
    schema.journalEntries,
    schema.accounts,
    schema.ledgerSettings,
    schema.securityEvents,
  ]) {
    await db.delete(t).where(eq(t.organizationId, orgId));
  }
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
});

test("a business defines its own fields and reads them back", async () => {
  const saved = await define([
    { label: "Purchase order", type: "text", appliesTo: "bill" },
    { label: "Job", type: "text", appliesTo: "transaction" },
  ]);
  expect(saved.status).toBe(200);

  const read = await req("/api/accounting/custom-fields");
  const { customFields } = (await read.json()) as {
    customFields: { id: string; label: string }[];
  };
  expect(customFields.map((f) => f.id)).toEqual(["purchase_order", "job"]);
});

/**
 * The period lock lives on the same row.
 *
 * Writing the settings row without keeping it would silently reopen a closed
 * year, and nothing on any screen would say so.
 */
test("defining fields does not disturb the closed period", async () => {
  await db
    .update(schema.ledgerSettings)
    .set({ closedThrough: new Date("2026-06-30T00:00:00Z") })
    .where(eq(schema.ledgerSettings.organizationId, orgId));

  await define([{ label: "Purchase order", type: "text", appliesTo: "bill" }]);

  const [row] = await db
    .select()
    .from(schema.ledgerSettings)
    .where(eq(schema.ledgerSettings.organizationId, orgId))
    .limit(1);
  expect(row?.closedThrough?.toISOString().slice(0, 10)).toBe("2026-06-30");

  await db
    .update(schema.ledgerSettings)
    .set({ closedThrough: null })
    .where(eq(schema.ledgerSettings.organizationId, orgId));
});

/**
 * The body of a request is not a schema.
 *
 * Storing whatever arrives means any caller can write any key onto any bill
 * for ever, and a form that is later removed leaves values nothing will ever
 * show or clean up.
 */
test("only a field somebody defined is stored on a bill", async () => {
  await define([
    { label: "Purchase order", type: "text", appliesTo: "bill" },
    { label: "Litres", type: "number", appliesTo: "bill" },
  ]);

  const made = await post("/api/bills", {
    billDate: "2026-08-01T00:00:00Z",
    lines: [
      {
        description: "Fuel",
        quantity: 1,
        unitPriceCents: 5_000,
        accountId: fuel,
      },
    ],
    custom: {
      purchase_order: "PO-4471",
      litres: "42.5",
      something_nobody_defined: "dropped",
    },
  });
  expect(made.status).toBe(201);
  const { bill } = (await made.json()) as {
    bill: { id: string; customValues: Record<string, unknown> };
  };

  expect(bill.customValues.purchase_order).toBe("PO-4471");
  // Coerced to what the field says it is, not left as the string a browser
  // sent — a number field holding "42.5" takes every total that touches it.
  expect(bill.customValues.litres).toBe(42.5);
  expect("something_nobody_defined" in bill.customValues).toBe(false);
});

test("a field defined for a bill is not written onto money in and out", async () => {
  await define([
    { label: "Purchase order", type: "text", appliesTo: "bill" },
    { label: "Job", type: "text", appliesTo: "transaction" },
  ]);

  const made = await post("/api/expenses", {
    amountCents: 1_200,
    accountId: fuel,
    paidThroughAccountId: cash,
    occurredAt: "2026-08-02T00:00:00Z",
    description: "Fuel",
    custom: { job: "Kitchen refit", purchase_order: "PO-1" },
  });
  expect(made.status).toBe(201);
  const body = (await made.json()) as {
    expense: { customValues: Record<string, unknown> };
  };
  expect(body.expense.customValues.job).toBe("Kitchen refit");
  // A bill's field on a transaction is a field nobody defined for it.
  expect("purchase_order" in body.expense.customValues).toBe(false);
});

test("a field for something the accounting module does not have is refused", async () => {
  const res = await define([
    { label: "Boiler model", type: "text", appliesTo: "contact" },
  ]);
  // A field against a subject nothing reads is one somebody fills in and never
  // sees again.
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("bill");
});

test("a list with nothing to choose is refused", async () => {
  const res = await define([
    { label: "Van", type: "select", options: [], appliesTo: "bill" },
  ]);
  expect(res.status).toBe(400);
});

test("only what is on the list is stored in a list field", async () => {
  await define([
    {
      label: "Van",
      type: "select",
      options: ["Transit", "Sprinter"],
      appliesTo: "bill",
    },
  ]);
  const made = await post("/api/bills", {
    billDate: "2026-08-01T00:00:00Z",
    lines: [
      {
        description: "Fuel",
        quantity: 1,
        unitPriceCents: 100,
        accountId: fuel,
      },
    ],
    custom: { van: "Something else" },
  });
  const { bill } = (await made.json()) as {
    bill: { customValues: Record<string, unknown> };
  };
  // A stale option left over from an old form is not quietly accepted.
  expect("van" in bill.customValues).toBe(false);
});

test("another business's definitions are not this one's", async () => {
  const other = await auth.api.createOrganization({
    body: { name: `Other ${suffix}`, slug: `other-fields-${suffix}` },
    headers,
  });
  if (!other) throw new Error("could not create the second organization");
  otherOrgId = other.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: other.id },
    headers,
  });

  const read = await req("/api/accounting/custom-fields");
  const { customFields } = (await read.json()) as { customFields: unknown[] };
  expect(customFields).toHaveLength(0);

  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });
});
