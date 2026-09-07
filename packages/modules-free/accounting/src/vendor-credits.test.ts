import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { and, db, eq, schema } from "@sentrello/db";
import { registerForTest } from "@sentrello/module-sdk";
import accounting from "./index";

/**
 * A credit note from a supplier, which is not a payment.
 *
 * Goods went back or a bill was overcharged: the business owes less and no
 * money moved. Recording it as a payment makes every future bank
 * reconciliation wrong; recording nothing leaves a liability that is never
 * settled and an aged-payables report saying the business is behind on a bill
 * it does not owe. Both of those are what this is here to make impossible.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const app = registerForTest(accounting);

let headers: Headers;
let orgId: string;
let fuel = "";
let cash = "";
let payable = "";

const req = (path: string, init?: RequestInit) =>
  app.request(`http://localhost${path}`, { headers, ...init });
const post = (path: string, body: unknown) =>
  req(path, { method: "POST", body: JSON.stringify(body) });

async function account(code: string, name: string, type: string) {
  const res = await post("/api/accounts", { code, name, type });
  const { account: made } = (await res.json()) as { account: { id: string } };
  return made.id;
}

/** An approved bill for a round amount, which is what a credit comes off. */
async function bill(totalCents: number) {
  const made = await post("/api/bills", {
    vendorId: null,
    billDate: "2026-08-01T00:00:00Z",
    lines: [
      {
        description: "Fuel",
        quantity: 1,
        unitPriceCents: totalCents,
        accountId: fuel,
      },
    ],
  });
  const { bill: row } = (await made.json()) as { bill: { id: string } };
  const approved = await post(`/api/bills/${row.id}/approve`, {});
  if (approved.status !== 200 && approved.status !== 201) {
    throw new Error(`could not approve the bill: ${approved.status}`);
  }
  return row.id;
}

async function credit(amountCents: number) {
  const res = await post("/api/vendor-credits", {
    amountCents,
    expenseAccountId: fuel,
    number: "CN-1",
  });
  const { credit: row } = (await res.json()) as { credit: { id: string } };
  return row.id;
}

async function billNow(id: string) {
  const res = await req(`/api/bills/${id}`);
  return (await res.json()) as {
    bill: { status: string; balanceDue: number; settledCents: number };
  };
}

/** Every line against one account, net. */
async function balanceOf(accountId: string) {
  const rows = await db
    .select()
    .from(schema.journalLines)
    .innerJoin(
      schema.journalEntries,
      eq(schema.journalEntries.id, schema.journalLines.entryId),
    )
    .where(eq(schema.journalEntries.organizationId, orgId));
  return rows
    .filter((row) => row.journal_lines.accountId === accountId)
    .reduce(
      (sum, row) =>
        sum + row.journal_lines.debitCents - row.journal_lines.creditCents,
      0,
    );
}

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email: `credits-${suffix}@x.test`,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Credits ${suffix}`, slug: `credits-${suffix}` },
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
  payable = await account("2000", "Accounts Payable", "liability");
});

afterAll(async () => {
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
    schema.vendorCreditApplications,
    schema.vendorCredits,
    schema.billPayments,
    schema.bills,
    schema.journalEntries,
    schema.accounts,
    schema.securityEvents,
  ]) {
    await db.delete(t).where(eq(t.organizationId, orgId));
  }
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
});

/**
 * The liability comes off the day the credit arrives.
 *
 * Waiting until it is put against a bill leaves the balance sheet claiming the
 * business owes money a supplier has already told it in writing that it does
 * not.
 */
test("issuing a credit takes what is owed off at once", async () => {
  const before = await balanceOf(payable);
  await credit(2_500);
  // A payable is a credit balance, so paying it down is a debit.
  expect(await balanceOf(payable)).toBe(before + 2_500);
  // And the expense it came back off, not a pool nobody can act on.
  expect(await balanceOf(fuel)).toBe(-2_500);
});

/**
 * And applying it moves nothing.
 *
 * The credit already took the liability off. Posting again would take it off
 * twice: a payables balance that goes negative and books saying the supplier
 * owes the business money.
 */
test("applying a credit to a bill posts nothing and settles the bill", async () => {
  const id = await bill(10_000);
  const note = await credit(10_000);
  const before = await balanceOf(payable);

  const applied = await post(`/api/vendor-credits/${note}/apply`, {
    billId: id,
  });
  expect(applied.status).toBe(201);
  expect(await balanceOf(payable)).toBe(before);

  const after = await billNow(id);
  expect(after.bill.status).toBe("paid");
  expect(after.bill.balanceDue).toBe(0);
  expect(after.bill.settledCents).toBe(10_000);
});

test("part of a credit can go on one bill and the rest on another", async () => {
  const first = await bill(3_000);
  const second = await bill(5_000);
  const note = await credit(8_000);

  expect(
    (
      await post(`/api/vendor-credits/${note}/apply`, {
        billId: first,
        amountCents: 3_000,
      })
    ).status,
  ).toBe(201);
  expect(
    (await post(`/api/vendor-credits/${note}/apply`, { billId: second }))
      .status,
  ).toBe(201);

  expect((await billNow(first)).bill.status).toBe("paid");
  expect((await billNow(second)).bill.status).toBe("paid");

  const listed = await req("/api/vendor-credits");
  const { credits } = (await listed.json()) as {
    credits: { id: string; remainingCents: number }[];
  };
  expect(credits.find((c) => c.id === note)?.remainingCents).toBe(0);
});

/**
 * Never more than the bill owes.
 *
 * Over-applying makes a bill look overpaid and quietly loses the rest of the
 * credit, which is money the business is entitled to.
 */
test("a credit cannot settle more than the bill has left", async () => {
  const id = await bill(1_000);
  const note = await credit(5_000);
  const res = await post(`/api/vendor-credits/${note}/apply`, {
    billId: id,
    amountCents: 5_000,
  });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toContain("10.00");
});

test("a credit used up cannot be used again", async () => {
  const first = await bill(4_000);
  const second = await bill(4_000);
  const note = await credit(4_000);
  await post(`/api/vendor-credits/${note}/apply`, { billId: first });

  const res = await post(`/api/vendor-credits/${note}/apply`, {
    billId: second,
  });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toContain("none");
});

/**
 * And a partly used one cannot be stretched.
 *
 * The case above is refused for being empty, which would pass whether or not
 * the amount is checked at all. This one still has money in it and is asked
 * for more than it holds — which is what somebody typing a figure does.
 */
test("a credit cannot hand out more than it has left", async () => {
  const first = await bill(1_000);
  const second = await bill(9_000);
  const note = await credit(4_000);
  await post(`/api/vendor-credits/${note}/apply`, {
    billId: first,
    amountCents: 1_000,
  });

  const res = await post(`/api/vendor-credits/${note}/apply`, {
    billId: second,
    amountCents: 4_000,
  });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toContain("30.00");

  // And the bill it was aimed at is untouched.
  expect((await billNow(second)).bill.balanceDue).toBe(9_000);
});

/**
 * Half a credit leaves the bill part paid, not paid.
 *
 * A bill marked paid on a partial credit is a supplier who never gets the rest
 * of their money and a business that believes it is square.
 */
test("a partial credit leaves the bill part paid", async () => {
  const id = await bill(6_000);
  const note = await credit(2_000);
  await post(`/api/vendor-credits/${note}/apply`, {
    billId: id,
    amountCents: 2_000,
  });

  const after = await billNow(id);
  expect(after.bill.status).toBe("partial");
  expect(after.bill.balanceDue).toBe(4_000);
});

/**
 * A credit and a payment together settle a bill.
 *
 * The over-payment guard has to count both, or a business that credited half a
 * bill is refused permission to pay the other half.
 */
test("a credit and a payment settle one bill between them", async () => {
  const id = await bill(9_000);
  const note = await credit(4_000);
  await post(`/api/vendor-credits/${note}/apply`, {
    billId: id,
    amountCents: 4_000,
  });

  const paid = await post(`/api/bills/${id}/payments`, {
    amountCents: 5_000,
    paidThroughAccountId: cash,
  });
  expect(paid.status).toBe(201);
  expect((await billNow(id)).bill.status).toBe("paid");

  // And paying the whole of it on top is refused, since only 5000 was owed.
  const again = await post(`/api/bills/${id}/payments`, {
    amountCents: 1,
    paidThroughAccountId: cash,
  });
  expect(again.status).toBe(400);
});

/**
 * Taking it off again, because it went on the wrong bill.
 *
 * The commonest mistake here, and it has to be an undo rather than a support
 * call. The credit is untouched — only where it sits changes.
 */
test("a credit taken off a bill leaves the bill owing again", async () => {
  const id = await bill(7_000);
  const note = await credit(7_000);
  const applied = await post(`/api/vendor-credits/${note}/apply`, {
    billId: id,
  });
  const { application } = (await applied.json()) as {
    application: { id: string };
  };
  expect((await billNow(id)).bill.status).toBe("paid");

  const removed = await req(
    `/api/vendor-credits/applications/${application.id}`,
    { method: "DELETE" },
  );
  expect(removed.status).toBe(200);

  const after = await billNow(id);
  expect(after.bill.status).toBe("open");
  expect(after.bill.balanceDue).toBe(7_000);

  // The credit itself is whole again, and was never in the ledger twice.
  const listed = await req("/api/vendor-credits");
  const { credits } = (await listed.json()) as {
    credits: { id: string; remainingCents: number }[];
  };
  expect(credits.find((c) => c.id === note)?.remainingCents).toBe(7_000);
});

/**
 * Cancelling one the supplier withdrew, and only while it is unused.
 *
 * Cancelling a credit that has settled a bill would make the bill outstanding
 * again with nothing on the screen to say why.
 */
test("a credit is cancelled by reversal, and not while it is in use", async () => {
  const note = await credit(1_500);
  const before = await balanceOf(payable);

  const voided = await post(`/api/vendor-credits/${note}/void`, {});
  expect(voided.status).toBe(200);
  // Put back exactly, as an entry of its own rather than by deleting one.
  expect(await balanceOf(payable)).toBe(before - 1_500);
  expect((await post(`/api/vendor-credits/${note}/void`, {})).status).toBe(409);

  const id = await bill(2_000);
  const used = await credit(2_000);
  await post(`/api/vendor-credits/${used}/apply`, { billId: id });
  const refused = await post(`/api/vendor-credits/${used}/void`, {});
  expect(refused.status).toBe(409);
  expect((await billNow(id)).bill.status).toBe("paid");
});

test("a cancelled credit cannot be applied to anything", async () => {
  const note = await credit(500);
  await post(`/api/vendor-credits/${note}/void`, {});
  const id = await bill(500);
  const res = await post(`/api/vendor-credits/${note}/apply`, { billId: id });
  expect(res.status).toBe(409);
});

test("a credit needs an expense account of this business's", async () => {
  const res = await post("/api/vendor-credits", {
    amountCents: 100,
    expenseAccountId: crypto.randomUUID(),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("expense");
});

test("a draft bill is not one a credit can be put against", async () => {
  const made = await post("/api/bills", {
    vendorId: null,
    billDate: "2026-08-01T00:00:00Z",
    lines: [
      {
        description: "Fuel",
        quantity: 1,
        unitPriceCents: 100,
        accountId: fuel,
      },
    ],
  });
  const { bill: draft } = (await made.json()) as { bill: { id: string } };
  const note = await credit(100);
  const res = await post(`/api/vendor-credits/${note}/apply`, {
    billId: draft.id,
  });
  // Nobody owes anything on a draft, so settling it settles nothing and hides
  // the credit.
  expect(res.status).toBe(409);
});

test("another business's credit cannot be applied or cancelled", async () => {
  const strangers = crypto.randomUUID();
  expect(
    (await post(`/api/vendor-credits/${strangers}/apply`, { billId: "x" }))
      .status,
  ).toBe(404);
  expect((await post(`/api/vendor-credits/${strangers}/void`, {})).status).toBe(
    404,
  );
});
