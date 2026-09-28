import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, schema } from "@sentrello/db";
import { postJournalEntry } from "@sentrello/db/ledger";
import { registerForTest } from "@sentrello/module-sdk";
import accounting from "./index";

/**
 * Who put the figure in the books.
 *
 * The ledger was already an audit trail — nothing is edited, nothing is
 * deleted, and a correction sits beside the thing it corrects — but it could
 * not say who. `postJournalEntry` is several calls below every route that
 * posts, so the answer is carried by the request rather than passed through
 * thirty functions that have no other reason to know about sessions.
 *
 * Which makes two things worth proving: that it is recorded at all, and that a
 * job posting with nobody signed in records nobody rather than the last person
 * who happened to be.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const app = registerForTest(accounting);

let headers: Headers;
let orgId: string;
let userId = "";
let cash = "";
/** The second person's business, cleaned up whatever happens. */
let theirOrgId: string | null = null;
let fuel = "";

const req = (path: string, init?: RequestInit) =>
  app.request(`http://localhost${path}`, { headers, ...init });
const post = (path: string, body: unknown) =>
  req(path, { method: "POST", body: JSON.stringify(body) });

async function account(code: string, name: string, type: string) {
  const res = await post("/api/accounts", { code, name, type });
  const { account: made } = (await res.json()) as { account: { id: string } };
  return made.id;
}

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email: `audit-${suffix}@x.test`,
    password: "correct-horse-battery-staple",
    name: "Ada Bookkeeper",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Audit ${suffix}`, slug: `audit-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  const [row] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, `audit-${suffix}@x.test`))
    .limit(1);
  if (!row) throw new Error("no user");
  userId = row.id;

  cash = await account("1000", "Cash", "asset");
  fuel = await account("6100", "Fuel", "expense");
});

afterAll(async () => {
  if (theirOrgId) {
    const theirs = await db
      .select({ id: schema.journalEntries.id })
      .from(schema.journalEntries)
      .where(eq(schema.journalEntries.organizationId, theirOrgId));
    for (const entry of theirs) {
      await db
        .delete(schema.journalLines)
        .where(eq(schema.journalLines.entryId, entry.id));
    }
    for (const t of [
      schema.transactions,
      schema.journalEntries,
      schema.accounts,
      schema.securityEvents,
      schema.ledgerSettings,
    ]) {
      await db.delete(t).where(eq(t.organizationId, theirOrgId));
    }
    await db
      .delete(schema.member)
      .where(eq(schema.member.organizationId, theirOrgId));
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, theirOrgId));
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
    schema.transactions,
    schema.journalEntries,
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
 * An entry posted through a route belongs to whoever made the request.
 *
 * Including the ones nobody types by hand — money in and out goes through the
 * same function, several calls down, with no form to add a field to.
 */
test("an entry records the person whose request posted it", async () => {
  const made = await post("/api/expenses", {
    amountCents: 2_500,
    accountId: fuel,
    paidThroughAccountId: cash,
    occurredAt: "2026-08-01T00:00:00Z",
    description: "Fuel",
  });
  expect(made.status).toBe(201);

  const [entry] = await db
    .select()
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId))
    .limit(1);
  expect(entry?.createdBy).toBe(userId);
});

/**
 * And the journal says so by name.
 *
 * A trail showing user ids is one somebody has to look up line by line, which
 * means nobody reads it.
 */
test("the journal says who, by name", async () => {
  const res = await req("/api/journal");
  const { lines } = (await res.json()) as {
    lines: { postedBy: string | null }[];
  };
  expect(lines.length).toBeGreaterThan(0);
  expect(lines[0]?.postedBy).toBe("Ada Bookkeeper");
});

/**
 * A job posts as nobody, not as whoever was last signed in.
 *
 * The failure this guards against is the worst kind of wrong answer: an audit
 * trail that names a person who did not do it. Depreciation runs at three in
 * the morning and a webhook posts a card payment; neither is a person.
 */
test("something posted outside a request belongs to nobody", async () => {
  const entry = await postJournalEntry(
    orgId,
    "Depreciation, posted by a job",
    `job:${crypto.randomUUID()}`,
    [
      { accountId: fuel, debitCents: 100 },
      { accountId: cash, creditCents: 100 },
    ],
  );

  const [row] = await db
    .select()
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.id, entry.id))
    .limit(1);
  expect(row?.createdBy).toBeNull();
});

/**
 * Two people's work does not get mixed up.
 *
 * The store is per-request, so a second request signed in as somebody else
 * must not take the first one's attribution — the failure mode of getting this
 * wrong is an audit trail that is confidently, silently mistaken.
 */
test("a second person's entry is theirs, not the first person's", async () => {
  const second = await signUpAsOwner({
    email: `audit2-${suffix}@x.test`,
    password: "correct-horse-battery-staple",
    name: "Bo Bookkeeper",
  });
  const cookie = second.headers.get("set-cookie");
  if (!cookie) throw new Error("no cookie for the second person");
  const [them] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, `audit2-${suffix}@x.test`))
    .limit(1);
  if (!them) throw new Error("no second user");

  /**
   * In their own business, which is the honest way to set this up.
   *
   * Adding them to ours would need a role granted through the access-control
   * machinery, and the thing under test has nothing to do with permissions:
   * it is whether one request's attribution can be taken by another.
   */
  const theirHeaders = new Headers({
    cookie,
    "content-type": "application/json",
  });
  const theirOrg = await auth.api.createOrganization({
    body: { name: `Audit2 ${suffix}`, slug: `audit2-${suffix}` },
    headers: theirHeaders,
  });
  if (!theirOrg) throw new Error("could not create their organization");
  theirOrgId = theirOrg.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: theirOrg.id },
    headers: theirHeaders,
  });

  const theirCash = await app.request("http://localhost/api/accounts", {
    method: "POST",
    headers: theirHeaders,
    body: JSON.stringify({ code: "1000", name: "Cash", type: "asset" }),
  });
  const { account: theirCashAccount } = (await theirCash.json()) as {
    account: { id: string };
  };
  const theirFuelRes = await app.request("http://localhost/api/accounts", {
    method: "POST",
    headers: theirHeaders,
    body: JSON.stringify({ code: "6100", name: "Fuel", type: "expense" }),
  });
  const { account: theirFuel } = (await theirFuelRes.json()) as {
    account: { id: string };
  };

  const made = await app.request("http://localhost/api/expenses", {
    method: "POST",
    headers: theirHeaders,
    body: JSON.stringify({
      amountCents: 700,
      accountId: theirFuel.id,
      paidThroughAccountId: theirCashAccount.id,
      occurredAt: "2026-08-03T00:00:00Z",
      description: "Theirs",
    }),
  });
  expect(made.status).toBe(201);

  const [theirs] = await db
    .select()
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, theirOrg.id))
    .limit(1);
  const ours = await db
    .select()
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));

  expect(theirs?.createdBy).toBe(them.id);
  // And ours did not become theirs on the way past.
  expect(ours.find((e) => e.memo?.includes("Fuel"))?.createdBy).toBe(userId);
});
