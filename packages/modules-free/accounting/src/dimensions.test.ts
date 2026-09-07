import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, schema } from "@sentrello/db";
import { registerForTest } from "@sentrello/module-sdk";
import accounting from "./index";

/**
 * Whether the kitchen job made money.
 *
 * A chart of accounts says *what* was spent; a class says *which part of the
 * business* spent it. Without them a builder with two jobs invents "Fuel — Job
 * A" and "Fuel — Job B" and doubles the chart every time they win work, and a
 * shop with two branches can never see either branch on its own.
 *
 * They sit on the journal line rather than the entry, so one bill can cover
 * two jobs — and everything below is about that reaching the reports, because
 * a dimension the reports cannot read is a field somebody fills in for nothing.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const app = registerForTest(accounting);

let headers: Headers;
let orgId: string;
let fuel = "";
let cash = "";
let kitchen = "";
let bathroom = "";
let leeds = "";
let otherOrgId: string | null = null;

const req = (path: string, init?: RequestInit) =>
  app.request(`http://localhost${path}`, { headers, ...init });
const post = (path: string, body: unknown) =>
  req(path, { method: "POST", body: JSON.stringify(body) });

async function account(code: string, name: string, type: string) {
  const res = await post("/api/accounts", { code, name, type });
  const { account: made } = (await res.json()) as { account: { id: string } };
  return made.id;
}

async function dimension(kind: string, name: string) {
  const res = await post("/api/dimensions", { kind, name });
  const { dimension: made } = (await res.json()) as {
    dimension: { id: string };
  };
  return made.id;
}

/** An expense, optionally against a class and a location. */
const spend = (amountCents: number, tags: Record<string, string> = {}) =>
  post("/api/expenses", {
    amountCents,
    accountId: fuel,
    paidThroughAccountId: cash,
    occurredAt: "2026-08-02T00:00:00Z",
    description: "Fuel",
    ...tags,
  });

async function expensesOn(query: string) {
  const res = await req(`/api/reports/profit-and-loss${query}`);
  const body = (await res.json()) as { expenseCents: number };
  return body.expenseCents;
}

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email: `dims-${suffix}@x.test`,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Dims ${suffix}`, slug: `dims-${suffix}` },
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
  kitchen = await dimension("class", "Kitchen job");
  bathroom = await dimension("class", "Bathroom job");
  leeds = await dimension("location", "Leeds");
});

afterAll(async () => {
  for (const id of [orgId, otherOrgId].filter((x): x is string => !!x)) {
    const entries = await db
      .select({ id: schema.journalEntries.id })
      .from(schema.journalEntries)
      .where(eq(schema.journalEntries.organizationId, id));
    for (const entry of entries) {
      await db
        .delete(schema.journalLines)
        .where(eq(schema.journalLines.entryId, entry.id));
    }
    for (const t of [
      schema.transactions,
      schema.journalEntries,
      schema.dimensions,
      schema.accounts,
      schema.securityEvents,
      schema.ledgerSettings,
    ]) {
      await db.delete(t).where(eq(t.organizationId, id));
    }
    await db.delete(schema.member).where(eq(schema.member.organizationId, id));
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, id));
  }
});

/**
 * The whole point: a report for one job.
 *
 * Anything less and the classes are a field somebody fills in and never sees
 * again — which is worse than not having them, because the filling in is work.
 */
test("a profit and loss can be asked for one job at a time", async () => {
  await spend(5_000, { classId: kitchen });
  await spend(3_000, { classId: bathroom });
  await spend(1_000);

  expect(await expensesOn("")).toBe(9_000);
  expect(await expensesOn(`?classId=${kitchen}`)).toBe(5_000);
  expect(await expensesOn(`?classId=${bathroom}`)).toBe(3_000);
});

/**
 * Untagged spending is not somebody's job's.
 *
 * A business that tags most things and not everything must not have the rest
 * quietly folded into whichever job it asks about first.
 */
test("spending with no class belongs to no job", async () => {
  const both = await expensesOn(`?classId=${kitchen}`);
  const alone = await expensesOn(`?classId=${bathroom}`);
  // Nine thousand went out; only the tagged eight are in either job.
  expect(both + alone).toBe(8_000);
});

test("classes and locations narrow independently", async () => {
  await spend(2_000, { classId: kitchen, locationId: leeds });

  expect(await expensesOn(`?locationId=${leeds}`)).toBe(2_000);
  expect(await expensesOn(`?classId=${kitchen}&locationId=${leeds}`)).toBe(
    2_000,
  );
  expect(await expensesOn(`?classId=${bathroom}&locationId=${leeds}`)).toBe(0);
});

/**
 * The bank side of an entry carries no class.
 *
 * A job did not receive the cash — the business did. Tagging the bank line
 * would make every class's balance sheet claim a share of one bank account,
 * and the shares would add up to more than the account holds.
 */
test("only the income or expense line is tagged, never the bank", async () => {
  const lines = await db
    .select()
    .from(schema.journalLines)
    .innerJoin(
      schema.journalEntries,
      eq(schema.journalEntries.id, schema.journalLines.entryId),
    )
    .where(eq(schema.journalEntries.organizationId, orgId));
  const banked = lines.filter((row) => row.journal_lines.accountId === cash);
  expect(banked.length).toBeGreaterThan(0);
  for (const row of banked) expect(row.journal_lines.classId).toBeNull();
});

/**
 * One bill, two jobs.
 *
 * The reason these live on the line. A merchant's invoice covering two jobs is
 * one document, and a business forced to split it into two bills to report on
 * them stops bothering.
 */
test("one bill can be split across two jobs", async () => {
  const made = await post("/api/bills", {
    billDate: "2026-08-05T00:00:00Z",
    lines: [
      {
        description: "Timber",
        quantity: 1,
        unitPriceCents: 4_000,
        accountId: fuel,
        classId: kitchen,
      },
      {
        description: "Tiles",
        quantity: 1,
        unitPriceCents: 6_000,
        accountId: fuel,
        classId: bathroom,
      },
    ],
  });
  const { bill } = (await made.json()) as { bill: { id: string } };
  expect((await post(`/api/bills/${bill.id}/approve`, {})).status).toBe(200);

  // Both lines are on one expense account; only the class tells them apart.
  const kitchenNow = await expensesOn(`?classId=${kitchen}`);
  const bathroomNow = await expensesOn(`?classId=${bathroom}`);
  expect(kitchenNow).toBe(5_000 + 2_000 + 4_000);
  expect(bathroomNow).toBe(3_000 + 6_000);
});

test("a class that is not this business's is refused, and posts nothing", async () => {
  const before = await expensesOn("");
  const res = await spend(9_999, { classId: crypto.randomUUID() });
  expect(res.status).toBe(400);
  expect(await expensesOn("")).toBe(before);
});

/**
 * Refused as a pair.
 *
 * A request naming a location that is not this business's must not quietly
 * post with the class it did get right — the figure would land somewhere
 * nobody asked for and look correct.
 */
test("a bad location refuses the whole thing, not just the location", async () => {
  const before = await expensesOn(`?classId=${kitchen}`);
  const res = await spend(9_999, {
    classId: kitchen,
    locationId: crypto.randomUUID(),
  });
  expect(res.status).toBe(400);
  expect(await expensesOn(`?classId=${kitchen}`)).toBe(before);
});

test("a location cannot be used where a class is asked for", async () => {
  const res = await spend(100, { classId: leeds });
  // Leeds is a real dimension of this business and is not a class.
  expect(res.status).toBe(400);
});

test("two live classes cannot share a name", async () => {
  const res = await post("/api/dimensions", {
    kind: "class",
    name: "Kitchen job",
  });
  // A report split in half with no way to tell which half is which.
  expect(res.status).toBe(409);
});

/**
 * Retired, never deleted.
 *
 * A job that ended still has a year of figures against it, and deleting it
 * would leave every one of them pointing at nothing.
 */
test("a finished job is archived and its figures survive", async () => {
  const before = await expensesOn(`?classId=${kitchen}`);
  const res = await post(`/api/dimensions/${kitchen}/archive`, {});
  expect(res.status).toBe(200);

  const listed = await req("/api/dimensions");
  const { dimensions } = (await listed.json()) as {
    dimensions: { id: string }[];
  };
  expect(dimensions.map((d) => d.id)).not.toContain(kitchen);

  // The figures are still there and still ask-able.
  expect(await expensesOn(`?classId=${kitchen}`)).toBe(before);

  // And a correcting entry can still be posted against it, so nobody has to
  // un-archive a job to fix a typo.
  expect((await spend(50, { classId: kitchen })).status).toBe(201);

  await post(`/api/dimensions/${kitchen}/archive`, { archived: false });
});

test("another business's dimension cannot be archived", async () => {
  const other = await auth.api.createOrganization({
    body: { name: `Other ${suffix}`, slug: `other-dims-${suffix}` },
    headers,
  });
  if (!other) throw new Error("could not create the second organization");
  otherOrgId = other.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: other.id },
    headers,
  });
  const theirs = await dimension("class", "Theirs");

  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  const res = await post(`/api/dimensions/${theirs}/archive`, {});
  expect(res.status).toBe(404);

  const [after] = await db
    .select()
    .from(schema.dimensions)
    .where(eq(schema.dimensions.id, theirs))
    .limit(1);
  expect(after?.archivedAt).toBeNull();

  // Nor used: a class of theirs on an expense of ours would put our figures in
  // their report and theirs in ours.
  expect((await spend(100, { classId: theirs })).status).toBe(400);
});
