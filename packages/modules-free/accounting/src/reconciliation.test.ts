import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, schema } from "@sentrello/db";
import { registerForTest } from "@sentrello/module-sdk";
import accounting from "./index";

/**
 * The one place in the module that will not take "close enough".
 *
 * Every other refusal here is about a mistake somebody made typing. This one
 * is about the outside world: the bank says the account closed at a figure,
 * the books say something else, and the difference is a payment that never
 * arrived, a fee nobody recorded, or a transaction entered twice. A
 * reconciliation that can be finished while it is out tells a business its
 * accounts are right when they are not, which is worse than not having one.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const app = registerForTest(accounting);

let headers: Headers;
let orgId: string;
let current = "";
let savings = "";
let importId = "";
/**
 * The second business, remembered rather than tidied where it is made.
 *
 * An organization left behind becomes the oldest one on the instance, and the
 * sign-in log resolves an attempt against an unknown address to that — so a
 * leftover here turns into events another module's tests cannot find.
 */
let otherOrgId: string | null = null;

const req = (path: string, init?: RequestInit) =>
  app.request(`http://localhost${path}`, { headers, ...init });
const post = (path: string, body: unknown) =>
  req(path, { method: "POST", body: JSON.stringify(body) });

async function bankAccount(code: string, name: string) {
  const res = await post("/api/accounts", { code, name, type: "asset" });
  const { account } = (await res.json()) as { account: { id: string } };
  await db
    .update(schema.accounts)
    .set({ isBank: true })
    .where(eq(schema.accounts.id, account.id));
  return account.id;
}

async function line(
  amountCents: number,
  date: string,
  extra: Partial<typeof schema.bankTransactions.$inferInsert> = {},
) {
  const [row] = await db
    .insert(schema.bankTransactions)
    .values({
      organizationId: orgId,
      importId,
      date: new Date(date),
      description: `line ${amountCents}`,
      amountCents,
      bankAccountId: current,
      ...extra,
    })
    .returning();
  if (!row) throw new Error("the statement line was not written");
  return row;
}

async function start(body: Record<string, unknown> = {}) {
  const res = await post("/api/reconciliations", {
    accountId: current,
    statementDate: "2026-08-31T00:00:00Z",
    statementBalanceCents: 0,
    ...body,
  });
  return res;
}

async function state(id: string) {
  const res = await req(`/api/reconciliations/${id}`);
  return (await res.json()) as {
    lines: { id: string; amountCents: number; cleared: boolean }[];
    clearedCents: number;
    differenceCents: number;
  };
}

const tick = (id: string, lineId: string, cleared = true) =>
  post(`/api/reconciliations/${id}/lines/${lineId}`, { cleared });

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email: `recon-${suffix}@x.test`,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Recon ${suffix}`, slug: `recon-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  current = await bankAccount("1000", "Current account");
  savings = await bankAccount("1010", "Savings");

  const [batch] = await db
    .insert(schema.bankImports)
    .values({ organizationId: orgId, filename: "statement.csv" })
    .returning();
  if (!batch) throw new Error("the statement was not created");
  importId = batch.id;
});

afterAll(async () => {
  if (otherOrgId) {
    for (const t of [
      schema.bankTransactions,
      schema.bankReconciliations,
      schema.accounts,
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
  for (const t of [
    schema.bankTransactions,
    schema.bankReconciliations,
    schema.bankImports,
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

/** Everything one test made, so the next one's arithmetic means something. */
async function clear() {
  await db
    .delete(schema.bankTransactions)
    .where(eq(schema.bankTransactions.organizationId, orgId));
  await db
    .delete(schema.bankReconciliations)
    .where(eq(schema.bankReconciliations.organizationId, orgId));
}

/**
 * The refusal is the feature.
 *
 * And it says by how much, because "out by 12.50" sends somebody looking for a
 * transaction of 12.50 and half the time they find it in a minute.
 */
test("a reconciliation that is out will not finish, and says by how much", async () => {
  const made = await start({ statementBalanceCents: 10_000 });
  const { reconciliation } = (await made.json()) as {
    reconciliation: { id: string };
  };
  const a = await line(6_000, "2026-08-10T00:00:00Z");
  await line(4_000, "2026-08-12T00:00:00Z");

  await tick(reconciliation.id, a.id);
  const half = await state(reconciliation.id);
  expect(half.clearedCents).toBe(6_000);
  expect(half.differenceCents).toBe(-4_000);

  const refused = await post(
    `/api/reconciliations/${reconciliation.id}/finish`,
    {},
  );
  expect(refused.status).toBe(409);
  const said = (await refused.json()) as {
    error: string;
    differenceCents: number;
  };
  expect(said.error).toContain("40.00");
  expect(said.differenceCents).toBe(-4_000);

  await clear();
});

test("it finishes at zero, and the lines it cleared are settled", async () => {
  const made = await start({ statementBalanceCents: 10_000 });
  const { reconciliation } = (await made.json()) as {
    reconciliation: { id: string };
  };
  const a = await line(6_000, "2026-08-10T00:00:00Z");
  const b = await line(4_000, "2026-08-12T00:00:00Z");
  await tick(reconciliation.id, a.id);
  await tick(reconciliation.id, b.id);

  expect((await state(reconciliation.id)).differenceCents).toBe(0);
  const done = await post(
    `/api/reconciliations/${reconciliation.id}/finish`,
    {},
  );
  expect(done.status).toBe(200);

  const rows = await db
    .select()
    .from(schema.bankTransactions)
    .where(eq(schema.bankTransactions.organizationId, orgId));
  for (const row of rows) expect(row.reconciliationId).toBe(reconciliation.id);

  // And it is written down as a thing a person did, on a date.
  const events = await db
    .select()
    .from(schema.securityEvents)
    .where(eq(schema.securityEvents.action, "bank.reconciled"));
  expect(events.length).toBeGreaterThan(0);

  await clear();
});

/**
 * A finished month does not move.
 *
 * Un-ticking a line inside one changes a figure two people agreed on, and the
 * way out of a wrong figure in a signed-off month is an adjusting entry rather
 * than quietly editing the evidence.
 */
test("a finished reconciliation refuses everything afterwards", async () => {
  const made = await start({ statementBalanceCents: 5_000 });
  const { reconciliation } = (await made.json()) as {
    reconciliation: { id: string };
  };
  const a = await line(5_000, "2026-08-10T00:00:00Z");
  await tick(reconciliation.id, a.id);
  expect(
    (await post(`/api/reconciliations/${reconciliation.id}/finish`, {})).status,
  ).toBe(200);

  expect((await tick(reconciliation.id, a.id, false)).status).toBe(409);
  expect(
    (await post(`/api/reconciliations/${reconciliation.id}/finish`, {})).status,
  ).toBe(409);
  expect(
    (
      await req(`/api/reconciliations/${reconciliation.id}`, {
        method: "DELETE",
      })
    ).status,
  ).toBe(409);

  const [after] = await db
    .select()
    .from(schema.bankTransactions)
    .where(eq(schema.bankTransactions.id, a.id))
    .limit(1);
  expect(after?.reconciliationId).toBe(reconciliation.id);

  await clear();
});

/**
 * The next month starts where the last one closed.
 *
 * Without the opening balance the second reconciliation asks the whole
 * account's history to add up to one month's closing figure, which is never
 * true after the first month and cannot be made true by ticking anything.
 */
test("the second month opens at the first month's closing balance", async () => {
  const first = await start({ statementBalanceCents: 5_000 });
  const one = (await first.json()) as { reconciliation: { id: string } };
  const a = await line(5_000, "2026-08-10T00:00:00Z");
  await tick(one.reconciliation.id, a.id);
  await post(`/api/reconciliations/${one.reconciliation.id}/finish`, {});

  const second = await start({
    statementDate: "2026-09-30T00:00:00Z",
    statementBalanceCents: 7_500,
  });
  const two = (await second.json()) as {
    reconciliation: { id: string; openingBalanceCents: number };
  };
  expect(two.reconciliation.openingBalanceCents).toBe(5_000);

  // August's line is settled and not offered again; only September's is.
  const b = await line(2_500, "2026-09-15T00:00:00Z");
  const shown = await state(two.reconciliation.id);
  expect(shown.lines.map((l) => l.id)).toEqual([b.id]);

  await tick(two.reconciliation.id, b.id);
  expect((await state(two.reconciliation.id)).differenceCents).toBe(0);
  // Finished too, so the opening balance is proved where it is enforced and
  // not only where it is displayed.
  expect(
    (await post(`/api/reconciliations/${two.reconciliation.id}/finish`, {}))
      .status,
  ).toBe(200);

  await clear();
});

/**
 * A line dated after the statement is on next month's.
 *
 * Offering it is offering somebody a way to make the difference come to zero
 * with a transaction the bank has not told them about yet — which produces a
 * reconciliation that balances and is wrong, the exact outcome this exists to
 * prevent.
 */
test("a transaction after the statement date is not offered", async () => {
  const made = await start({ statementBalanceCents: 1_000 });
  const { reconciliation } = (await made.json()) as {
    reconciliation: { id: string };
  };
  const inside = await line(1_000, "2026-08-31T09:00:00Z");
  const after = await line(9_999, "2026-09-01T00:00:00Z");

  const shown = await state(reconciliation.id);
  const ids = shown.lines.map((l) => l.id);
  // The statement's own last day counts; the day after does not.
  expect(ids).toContain(inside.id);
  expect(ids).not.toContain(after.id);

  await clear();
});

test("a line from another account is neither offered nor tickable", async () => {
  const made = await start({ statementBalanceCents: 0 });
  const { reconciliation } = (await made.json()) as {
    reconciliation: { id: string };
  };
  const elsewhere = await line(3_000, "2026-08-10T00:00:00Z", {
    bankAccountId: savings,
  });

  expect((await state(reconciliation.id)).lines).toHaveLength(0);
  const refused = await tick(reconciliation.id, elsewhere.id);
  expect(refused.status).toBe(409);

  await clear();
});

test("one account has one reconciliation open at a time", async () => {
  const first = await start({ statementBalanceCents: 0 });
  expect(first.status).toBe(201);
  const second = await start({ statementBalanceCents: 0 });
  // Two at once means two people ticking the same lines and both arriving at
  // zero, having each counted half of them.
  expect(second.status).toBe(409);

  await clear();
});

test("an overdrawn account reconciles like any other", async () => {
  const made = await start({ statementBalanceCents: -2_500 });
  expect(made.status).toBe(201);
  const { reconciliation } = (await made.json()) as {
    reconciliation: { id: string };
  };
  const a = await line(-2_500, "2026-08-10T00:00:00Z");
  await tick(reconciliation.id, a.id);
  expect(
    (await post(`/api/reconciliations/${reconciliation.id}/finish`, {})).status,
  ).toBe(200);

  await clear();
});

test("an unfinished one can be abandoned, and lets go of its lines", async () => {
  const made = await start({ statementBalanceCents: 100 });
  const { reconciliation } = (await made.json()) as {
    reconciliation: { id: string };
  };
  const a = await line(100, "2026-08-10T00:00:00Z");
  await tick(reconciliation.id, a.id);

  const gone = await req(`/api/reconciliations/${reconciliation.id}`, {
    method: "DELETE",
  });
  expect(gone.status).toBe(200);

  const [after] = await db
    .select()
    .from(schema.bankTransactions)
    .where(eq(schema.bankTransactions.id, a.id))
    .limit(1);
  // Free to be reconciled again, rather than held by something that is gone.
  expect(after?.reconciliationId).toBeNull();

  await clear();
});

test("another business's reconciliation cannot be read or finished", async () => {
  const other = await auth.api.createOrganization({
    body: { name: `Other ${suffix}`, slug: `other-recon-${suffix}` },
    headers,
  });
  if (!other) throw new Error("could not create the second organization");
  otherOrgId = other.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: other.id },
    headers,
  });
  const theirAccount = await bankAccount("1000", "Theirs");
  const theirs = await post("/api/reconciliations", {
    accountId: theirAccount,
    statementDate: "2026-08-31T00:00:00Z",
    statementBalanceCents: 0,
  });
  const { reconciliation } = (await theirs.json()) as {
    reconciliation: { id: string };
  };

  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  expect((await req(`/api/reconciliations/${reconciliation.id}`)).status).toBe(
    404,
  );
  expect(
    (await post(`/api/reconciliations/${reconciliation.id}/finish`, {})).status,
  ).toBe(404);

  const [still] = await db
    .select()
    .from(schema.bankReconciliations)
    .where(eq(schema.bankReconciliations.id, reconciliation.id))
    .limit(1);
  expect(still?.completedAt).toBeNull();

  await clear();
});
