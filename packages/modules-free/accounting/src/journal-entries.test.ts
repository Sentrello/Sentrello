import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { and, db, eq, schema } from "@sentrello/db";
import { registerForTest } from "@sentrello/module-sdk";
import accounting from "./index";

/**
 * The most dangerous route in the module, and the rules that make it safe.
 *
 * It writes to the ledger with no invoice or payment behind it to check the
 * figure against, so every rule below is a refusal rather than a warning: it
 * balances or it does not post, every account belongs to this business, a line
 * is a debit or a credit, a closed period is closed, and nothing is ever
 * edited or deleted — a mistake is reversed.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const app = registerForTest(accounting);

let headers: Headers;
let orgId: string;
let cash = "";
let expenses = "";
/**
 * The second business, remembered rather than tidied where it is made.
 *
 * An organization left in the test database is not an untidy row: the sign-in
 * log resolves an attempt against an unknown address to the oldest
 * organization there is, so a leftover from here becomes the one that
 * `sign-in-events.test.ts` writes 19 events against and then cannot find. That
 * happened. Cleaning up on the way out of the test only works when the test
 * passes, which is the run where it matters least.
 */
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

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email: `journal-${suffix}@x.test`,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Journal ${suffix}`, slug: `journal-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  cash = await account("1000", "Cash", "asset");
  expenses = await account("5000", "Depreciation", "expense");
});

afterAll(async () => {
  await scrub(orgId);
  if (otherOrgId) await scrub(otherOrgId);
});

test("an accountant can post an adjusting entry", async () => {
  const res = await post("/api/journal/entries", {
    memo: "Depreciation, September",
    lines: [
      { accountId: expenses, debitCents: 12_500 },
      { accountId: cash, creditCents: 12_500 },
    ],
  });
  expect(res.status).toBe(201);

  const { entry } = (await res.json()) as { entry: { id: string } };
  const lines = await db
    .select()
    .from(schema.journalLines)
    .where(eq(schema.journalLines.entryId, entry.id));

  expect(lines).toHaveLength(2);
  expect(lines.reduce((n, l) => n + l.debitCents, 0)).toBe(12_500);
  expect(lines.reduce((n, l) => n + l.creditCents, 0)).toBe(12_500);
});

/**
 * The one rule the ledger is built on.
 *
 * Refused with the difference rather than the two totals: somebody staring at
 * an entry that will not post wants to know what it is out by and which way,
 * not to do the subtraction themselves.
 */
test("an entry that does not balance is refused, and says by how much", async () => {
  const res = await post("/api/journal/entries", {
    memo: "Wrong",
    lines: [
      { accountId: expenses, debitCents: 12_000 },
      { accountId: cash, creditCents: 11_500 },
    ],
  });
  expect(res.status).toBe(400);
  const { error } = (await res.json()) as { error: string };
  expect(error).toContain("does not balance");
  // The difference, in money, and which side is heavy.
  expect(error).toContain("5.00");
  expect(error).toContain("debits");
});

test("a line is a debit or a credit, never both and never neither", async () => {
  const both = await post("/api/journal/entries", {
    memo: "Both",
    lines: [
      { accountId: expenses, debitCents: 100, creditCents: 100 },
      { accountId: cash, creditCents: 100 },
    ],
  });
  expect(both.status).toBe(400);
  expect(((await both.json()) as { error: string }).error).toContain("line 1");

  const neither = await post("/api/journal/entries", {
    memo: "Neither",
    lines: [{ accountId: expenses, debitCents: 100 }, { accountId: cash }],
  });
  expect(neither.status).toBe(400);
  // Named, because the commonest mistake is a line left half-filled and the
  // person needs to know which one.
  expect(((await neither.json()) as { error: string }).error).toContain(
    "line 2",
  );
});

test("an entry cannot touch another business's accounts", async () => {
  const theirs = crypto.randomUUID();
  const res = await post("/api/journal/entries", {
    memo: "Somebody else's book",
    lines: [
      { accountId: expenses, debitCents: 100 },
      { accountId: theirs, creditCents: 100 },
    ],
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("line 2");
});

test("an entry needs two lines and a reason", async () => {
  const one = await post("/api/journal/entries", {
    memo: "Only one",
    lines: [{ accountId: cash, debitCents: 100 }],
  });
  expect(one.status).toBe(400);
  /**
   * For being one line, which is the reason.
   *
   * A single line cannot balance either, so a check on the status alone
   * passes whether or not this rule exists at all — and the person is told
   * their entry is out by a dollar when what they have is half an entry.
   */
  expect(((await one.json()) as { error: string }).error).toContain(
    "two lines",
  );

  const silent = await post("/api/journal/entries", {
    memo: "  ",
    lines: [
      { accountId: expenses, debitCents: 100 },
      { accountId: cash, creditCents: 100 },
    ],
  });
  // An unexplained entry is the one nobody can account for later, and this is
  // the kind of posting somebody gets asked about.
  expect(silent.status).toBe(400);
});

test("amounts are whole pennies", async () => {
  const res = await post("/api/journal/entries", {
    memo: "Fractions",
    lines: [
      { accountId: expenses, debitCents: 100.5 },
      { accountId: cash, creditCents: 100.5 },
    ],
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("pennies");
});

/**
 * A closed period is closed to this as much as to anything else.
 *
 * The lock exists so a business can say the year is done. An entry a person
 * types is exactly the kind that would otherwise slip behind it.
 */
test("a closed period refuses an entry dated inside it", async () => {
  await db.insert(schema.ledgerSettings).values({
    organizationId: orgId,
    closedThrough: new Date("2026-06-30T00:00:00Z"),
  });

  const inside = await post("/api/journal/entries", {
    memo: "Behind the lock",
    postedAt: "2026-06-15T00:00:00Z",
    lines: [
      { accountId: expenses, debitCents: 100 },
      { accountId: cash, creditCents: 100 },
    ],
  });
  expect(inside.status).toBe(409);

  // And the day after the lock is open.
  const after = await post("/api/journal/entries", {
    memo: "After the lock",
    postedAt: "2026-07-01T00:00:00Z",
    lines: [
      { accountId: expenses, debitCents: 100 },
      { accountId: cash, creditCents: 100 },
    ],
  });
  expect(after.status).toBe(201);

  await db
    .delete(schema.ledgerSettings)
    .where(eq(schema.ledgerSettings.organizationId, orgId));
});

/**
 * A mistake is reversed, not edited away.
 *
 * A ledger that can be changed after the fact is one nobody can rely on, and
 * an accountant explaining a figure needs to see both the mistake and the
 * correction. It is also how an accrual works: post at the month end, reverse
 * on the first.
 */
test("reversing posts the mirror and leaves the original alone", async () => {
  const made = await post("/api/journal/entries", {
    memo: "Accrued electricity",
    lines: [
      { accountId: expenses, debitCents: 8_000 },
      { accountId: cash, creditCents: 8_000 },
    ],
  });
  const { entry } = (await made.json()) as { entry: { id: string } };

  const undone = await post(`/api/journal/entries/${entry.id}/reverse`, {});
  expect(undone.status).toBe(201);
  const { entry: mirror } = (await undone.json()) as {
    entry: { id: string; memo: string };
  };
  expect(mirror.memo).toContain("Reversal of Accrued electricity");

  const original = await db
    .select()
    .from(schema.journalLines)
    .where(eq(schema.journalLines.entryId, entry.id));
  const reversed = await db
    .select()
    .from(schema.journalLines)
    .where(eq(schema.journalLines.entryId, mirror.id));

  // The original is untouched.
  expect(original.find((l) => l.accountId === expenses)?.debitCents).toBe(
    8_000,
  );

  /**
   * Per account, because the totals cannot tell the two apart.
   *
   * An entry copied line for line rather than mirrored is still balanced —
   * 8000 on each side — so a check on the totals passes for a reversal that
   * doubles the expense instead of cancelling it. The account that was
   * debited has to be the one now credited.
   */
  const back = new Map(reversed.map((l) => [l.accountId, l]));
  expect(back.get(expenses)?.creditCents).toBe(8_000);
  expect(back.get(expenses)?.debitCents).toBe(0);
  expect(back.get(cash)?.debitCents).toBe(8_000);
  expect(back.get(cash)?.creditCents).toBe(0);
});

/**
 * And only once.
 *
 * Two reversals cancel the correction and leave the books looking right while
 * being wrong by the amount twice over — found in an audit rather than on a
 * screen.
 */
test("an entry cannot be reversed twice", async () => {
  const made = await post("/api/journal/entries", {
    memo: "Only reversed once",
    lines: [
      { accountId: expenses, debitCents: 500 },
      { accountId: cash, creditCents: 500 },
    ],
  });
  const { entry } = (await made.json()) as { entry: { id: string } };

  expect(
    (await post(`/api/journal/entries/${entry.id}/reverse`, {})).status,
  ).toBe(201);
  const again = await post(`/api/journal/entries/${entry.id}/reverse`, {});
  expect(again.status).toBe(409);
});

/**
 * A real entry, in a real second business.
 *
 * Reversing an id that exists nowhere answers 404 whether the route is scoped
 * or not, so that version of this test held nothing. This one posts an entry
 * as another business and asks the first business to reverse it — which is
 * what a leak would actually look like.
 */
test("another business's entry cannot be reversed", async () => {
  const other = await auth.api.createOrganization({
    body: { name: `Other ${suffix}`, slug: `other-${suffix}` },
    headers,
  });
  if (!other) throw new Error("could not create the second organization");
  otherOrgId = other.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: other.id },
    headers,
  });

  const theirCash = await account("1000", "Cash", "asset");
  const theirCosts = await account("5000", "Costs", "expense");
  const made = await post("/api/journal/entries", {
    memo: "Theirs",
    lines: [
      { accountId: theirCosts, debitCents: 300 },
      { accountId: theirCash, creditCents: 300 },
    ],
  });
  expect(made.status).toBe(201);
  const { entry } = (await made.json()) as { entry: { id: string } };

  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  const res = await post(`/api/journal/entries/${entry.id}/reverse`, {});
  expect(res.status).toBe(404);

  // And nothing was posted into either set of books by the attempt.
  const theirs = await db
    .select()
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, other.id));
  expect(theirs).toHaveLength(1);
});

/** Everything one organization made, in the order the keys allow. */
async function scrub(id: string) {
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
    schema.journalEntries,
    schema.accounts,
    schema.securityEvents,
    schema.ledgerSettings,
  ]) {
    await db.delete(t).where(eq(t.organizationId, id));
  }
  await db.delete(schema.member).where(eq(schema.member.organizationId, id));
  await db.delete(schema.organizations).where(eq(schema.organizations.id, id));
}

/**
 * Who posted it, and when.
 *
 * These are the only writes to the books with nothing behind them to check the
 * figure against, which is exactly why they are the ones worth looking up.
 */
test("posting and reversing are written into the log", async () => {
  const events = await db
    .select()
    .from(schema.securityEvents)
    .where(
      and(
        eq(schema.securityEvents.organizationId, orgId),
        eq(schema.securityEvents.action, "journal.posted"),
      ),
    );
  expect(events.length).toBeGreaterThan(0);
  expect(events[0]?.actorId).toBeTruthy();
  expect(events[0]?.detail).toHaveProperty("totalCents");

  const reversals = await db
    .select()
    .from(schema.securityEvents)
    .where(
      and(
        eq(schema.securityEvents.organizationId, orgId),
        eq(schema.securityEvents.action, "journal.reversed"),
      ),
    );
  expect(reversals.length).toBeGreaterThan(0);
});
