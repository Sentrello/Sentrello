import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, schema } from "@sentrello/db";
import { postJournalEntry } from "@sentrello/db/ledger";
import { registerForTest } from "@sentrello/module-sdk";
import accounting from "./index";

/**
 * Finding one entry in the books.
 *
 * The journal is the list a business arrives at knowing what it wants — a
 * figure it has to explain, on a date, against an account — and it offered a
 * page number and nothing else while every other list screen had search,
 * filters and a sort. These are the four questions it now answers, and the
 * three ways the answers go wrong when a list pages over one table and
 * renders rows from another.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const app = registerForTest(accounting);

let headers: Headers;
let orgId = "";
let cash = "";
let fuel = "";
let rent = "";

const req = (path: string) =>
  app.request(`http://localhost${path}`, { headers });

interface Body {
  lines: { id: string; memo: string; accountId: string; postedAt: string }[];
  total: number;
}
const journal = async (query: string) => {
  const res = await req(`/api/journal?${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Body;
};

/** The distinct entries in a response, in the order they were rendered. */
const entriesOf = (body: Body) => [...new Set(body.lines.map((l) => l.id))];
const memosOf = (body: Body) => {
  const seen = new Map<string, string>();
  for (const line of body.lines) seen.set(line.id, line.memo);
  return [...seen.values()];
};

async function account(code: string, name: string, type: string) {
  const res = await app.request("http://localhost/api/accounts", {
    headers,
    method: "POST",
    body: JSON.stringify({ code, name, type }),
  });
  const { account: made } = (await res.json()) as { account: { id: string } };
  return made.id;
}

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email: `journal-${suffix}@x.test`,
    password: "correct-horse-battery-staple",
    name: "Ada Bookkeeper",
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
  fuel = await account("6100", "Fuel", "expense");
  rent = await account("6200", "Rent", "expense");

  await postJournalEntry(
    orgId,
    "Diesel for the van",
    "expense",
    [
      { accountId: fuel, debitCents: 5_000 },
      { accountId: cash, creditCents: 5_000 },
    ],
    new Date("2026-03-01T09:00:00.000Z"),
  );
  await postJournalEntry(
    orgId,
    "March rent",
    "expense",
    [
      { accountId: rent, debitCents: 90_000 },
      { accountId: cash, creditCents: 90_000 },
    ],
    // The last day of the quarter, at the end of the working day: the entry a
    // date filter written as `<= 2026-03-31` silently drops.
    new Date("2026-03-31T17:30:00.000Z"),
  );
  await postJournalEntry(
    orgId,
    "April rent",
    "expense",
    [
      { accountId: rent, debitCents: 90_000 },
      { accountId: cash, creditCents: 90_000 },
    ],
    new Date("2026-04-01T09:00:00.000Z"),
  );
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

test("the whole ledger, newest first, when nothing is asked", async () => {
  const body = await journal("page=1&perPage=25");
  expect(memosOf(body)).toEqual([
    "April rent",
    "March rent",
    "Diesel for the van",
  ]);
  expect(body.total).toBe(3);
});

test("search narrows to the entries whose memo matches", async () => {
  const body = await journal("page=1&perPage=25&q=diesel");
  expect(memosOf(body)).toEqual(["Diesel for the van"]);
  // The count is of what was found, not of the ledger — a pager divides by it.
  expect(body.total).toBe(1);
});

/**
 * The bug this exists to catch: `postedAt` is a timestamp and the filter is a
 * date, so `<= 2026-03-31` excludes everything posted during the 31st — which
 * at a quarter end is every entry the quarter turns on.
 */
test("a date range keeps the whole of its last day", async () => {
  const body = await journal("page=1&perPage=25&from=2026-03-01&to=2026-03-31");
  expect(memosOf(body)).toEqual(["March rent", "Diesel for the van"]);
  expect(body.total).toBe(2);
});

test("an account filter finds the entries that touch it", async () => {
  const body = await journal(`page=1&perPage=25&accountId=${rent}`);
  expect(memosOf(body)).toEqual(["April rent", "March rent"]);
  expect(body.total).toBe(2);
});

/**
 * Every line of a matching entry, not only the matching ones.
 *
 * A ledger that shows one side of an entry is a ledger that does not balance
 * on screen, and somebody will try to work out what the other half was.
 */
test("a filtered entry still arrives whole", async () => {
  const body = await journal(`page=1&perPage=25&accountId=${rent}`);
  const first = entriesOf(body)[0];
  const lines = body.lines.filter((l) => l.id === first);
  expect(lines.length).toBe(2);
  expect(lines.some((l) => l.accountId === cash)).toBe(true);
});

/**
 * An entry with two lines on the filtered account takes one place, not two.
 *
 * A join to the lines would have counted it twice and spent two of the page's
 * twenty-five places on it — which is what a join here is for, and why this
 * is an `exists` instead.
 */
test("an entry counts once however many of its lines match", async () => {
  await postJournalEntry(
    orgId,
    "Rent, split across two months",
    "expense",
    [
      { accountId: rent, debitCents: 40_000 },
      { accountId: rent, debitCents: 50_000 },
      { accountId: cash, creditCents: 90_000 },
    ],
    new Date("2026-04-02T09:00:00.000Z"),
  );
  const body = await journal(`page=1&perPage=25&accountId=${rent}`);
  expect(body.total).toBe(3);
  expect(entriesOf(body).length).toBe(3);
});

test("oldest first is the same set in the other order", async () => {
  const body = await journal("page=1&perPage=25&sort=postedAt&order=asc");
  expect(memosOf(body).slice(0, 2)).toEqual([
    "Diesel for the van",
    "March rent",
  ]);
});

/**
 * A page of an ascending ledger has to read ascending inside itself.
 *
 * The page is taken over entries and the lines fetched separately, so the two
 * queries each carry an order of their own — and the second one was written
 * before there was a direction to respect.
 */
test("the rows within an ascending page are ascending too", async () => {
  const body = await journal("page=1&perPage=2&sort=postedAt&order=asc");
  const dates = memosOf(body);
  expect(dates).toEqual(["Diesel for the van", "March rent"]);
});

/**
 * The day an entry belongs to, not the instant it is stamped with.
 *
 * An entry dated the 15th is stored as midnight UTC on the 15th, which a
 * browser in New York formats as the evening of the 14th. The route says the
 * day, by the same rule every report files the entry by: the day it was dated
 * with where it has one, and otherwise the business's day of the instant.
 */
test("each entry arrives with its day, in the business's zone", async () => {
  await db
    .update(schema.organizations)
    .set({ timezone: "America/New_York" })
    .where(eq(schema.organizations.id, orgId));
  try {
    await postJournalEntry(
      orgId,
      "Dated bill",
      "expense",
      [
        { accountId: fuel, debitCents: 1_000 },
        { accountId: cash, creditCents: 1_000 },
      ],
      new Date("2026-05-15T00:00:00.000Z"),
      { day: true },
    );
    await postJournalEntry(
      orgId,
      "Late till close",
      "expense",
      [
        { accountId: fuel, debitCents: 1_000 },
        { accountId: cash, creditCents: 1_000 },
      ],
      // Two in the morning in London, ten the night before in New York.
      new Date("2026-06-01T02:00:00.000Z"),
    );
    const body = (await (
      await req("/api/journal?page=1&perPage=25&q=Dated%20bill")
    ).json()) as { lines: { postedOn: string }[] };
    expect(body.lines.map((l) => l.postedOn)).toEqual([
      "2026-05-15",
      "2026-05-15",
    ]);
    const late = (await (
      await req("/api/journal?page=1&perPage=25&q=Late%20till")
    ).json()) as { lines: { postedOn: string }[] };
    expect(late.lines[0]?.postedOn).toBe("2026-05-31");
  } finally {
    await db
      .update(schema.organizations)
      .set({ timezone: null })
      .where(eq(schema.organizations.id, orgId));
  }
});
