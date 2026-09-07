import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, schema } from "@sentrello/db";
import {
  PeriodClosedError,
  ensureAccount,
  postJournalEntry,
} from "@sentrello/db/ledger";
import { registerForTest } from "@sentrello/module-sdk";
import accounting from "./index";
import { dayFrom } from "./period";

/**
 * Closing the books, which nothing in the platform could do until now.
 *
 * The thing that must be true: a business that has filed a return cannot have
 * that month changed underneath it. Everything else here is about not being so
 * strict that somebody works around the lock instead of using it.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const email = `period-${suffix}@example.test`;
const app = registerForTest(accounting);

let orgId: string;
let headers: Headers;

const put = (body: unknown) =>
  app.request("http://localhost/api/accounting/period", {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });

/** A minimal balanced entry, dated. */
const post = async (postedAt: Date) => {
  const cash = await ensureAccount(orgId, {
    code: "1000",
    name: "Cash",
    type: "asset",
  });
  const income = await ensureAccount(orgId, {
    code: "4000",
    name: "Sales",
    type: "income",
  });
  return postJournalEntry(
    orgId,
    `test ${postedAt.toISOString()}`,
    "test",
    [
      { accountId: cash, debitCents: 100 },
      { accountId: income, creditCents: 100 },
    ],
    postedAt,
  );
};

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
    body: { name: `Period ${suffix}`, slug: `period-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });
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
  await db
    .delete(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));
  await db
    .delete(schema.accounts)
    .where(eq(schema.accounts.organizationId, orgId));
  await db
    .delete(schema.ledgerSettings)
    .where(eq(schema.ledgerSettings.organizationId, orgId));
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  const [u] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email));
  if (u) {
    await db.delete(schema.session).where(eq(schema.session.userId, u.id));
    await db.delete(schema.account).where(eq(schema.account.userId, u.id));
    await db.delete(schema.user).where(eq(schema.user.id, u.id));
  }
});

test("an organization that has closed nothing posts as it always has", async () => {
  // Every existing instance is in this state, and an upgrade must not change
  // what it can do.
  const entry = await post(new Date("2020-01-01T12:00:00.000Z"));
  expect(entry.id).toBeTruthy();
});

test("nothing can be posted into a month that has been closed", async () => {
  expect((await put({ closedThrough: "2026-03-31" })).status).toBe(200);

  // The last day of the closed period is closed, not open — a lock that lets
  // in everything after breakfast on its final day is not a lock.
  await expect(post(new Date("2026-03-31T23:00:00.000Z"))).rejects.toThrow(
    PeriodClosedError,
  );
  await expect(post(new Date("2026-02-14T09:00:00.000Z"))).rejects.toThrow(
    PeriodClosedError,
  );
});

test("the day after the line is open", async () => {
  // The asymmetry is the test: a guard that refused everything would pass the
  // one above and fail this.
  const entry = await post(new Date("2026-04-01T00:00:01.000Z"));
  expect(entry.id).toBeTruthy();
});

test("the refusal says what is closed, so somebody can fix the date", async () => {
  const failed = await post(new Date("2026-01-05T12:00:00.000Z")).catch(
    (err) => err,
  );
  expect(failed).toBeInstanceOf(PeriodClosedError);
  expect((failed as Error).message).toContain("2026-03-31");
});

test("the books can be reopened", async () => {
  // Allowed on purpose: an accountant asking for a correction in a closed
  // month must be possible, or the lock is something people avoid using.
  expect((await put({ closedThrough: null })).status).toBe(200);
  const entry = await post(new Date("2026-02-14T09:00:00.000Z"));
  expect(entry.id).toBeTruthy();
});

test("the books cannot be closed into the future", async () => {
  const soon = new Date(Date.now() + 40 * 24 * 3600 * 1000);
  const res = await put({ closedThrough: soon.toISOString().slice(0, 10) });
  // Closing the future stops today's invoice being raised, and whoever did it
  // would have no idea why.
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("future");
});

test("something that is not a date is refused rather than clearing the lock", async () => {
  expect((await put({ closedThrough: "2026-03-31" })).status).toBe(200);
  const res = await put({ closedThrough: "last tuesday" });
  expect(res.status).toBe(400);

  const still = await app.request("http://localhost/api/accounting/period", {
    headers,
  });
  // Silently clearing a lock because the input was wrong is the worst of the
  // three possible outcomes.
  expect(
    ((await still.json()) as { closedThrough: string }).closedThrough,
  ).toBe("2026-03-31");
});

test("a date is a date", () => {
  expect(dayFrom("2026-03-31")?.toISOString()).toBe("2026-03-31T00:00:00.000Z");
  expect(dayFrom("31/03/2026")).toBeNull();
  expect(dayFrom("")).toBeNull();
  expect(dayFrom(null)).toBeNull();
});
