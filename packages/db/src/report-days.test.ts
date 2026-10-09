import { afterAll, beforeAll, expect, test } from "bun:test";
import { db, eq, schema } from "@sentrello/db";
import {
  cashBasisEntries,
  ensureAccount,
  ledgerRows,
  periodFrom,
  postJournalEntry,
} from "./ledger";
import { dropOrganization, makeOrganization } from "./testing";

/**
 * Reports read an entry on its own day, where the business is.
 *
 * A bill dated the 1st is stored at midnight UTC, which in New York is the
 * evening of the 31st — so every daily and monthly report put it in the month
 * before. A day-dated entry now carries `posted_on` and is that day
 * everywhere; an instant is still read on the day the business was having.
 */
const NY = `report-days-ny-${crypto.randomUUID().slice(0, 8)}`;
const BERLIN = `report-days-be-${crypto.randomUUID().slice(0, 8)}`;
const ids: Record<string, string> = {};

async function business(orgId: string, zone: string) {
  await makeOrganization(orgId);
  await db
    .update(schema.organizations)
    .set({ timezone: zone })
    .where(eq(schema.organizations.id, orgId));
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
  return async (name: string, at: Date, day?: boolean) => {
    const entry = await postJournalEntry(
      orgId,
      name,
      `probe:${crypto.randomUUID()}`,
      [
        { accountId: cash, debitCents: 100 },
        { accountId: income, creditCents: 100 },
      ],
      at,
      { day },
    );
    ids[`${orgId}:${name}`] = entry.id;
    return entry;
  };
}

beforeAll(async () => {
  const ny = await business(NY, "America/New_York");
  await ny("bill on the 1st", new Date("2026-10-01T00:00:00.000Z"), true);
  // EDT is UTC-4: 23:30 on the 31st is 03:30 UTC on 1 November.
  await ny("sale at 23:30 on the 31st", new Date("2026-11-01T03:30:00.000Z"));
  // Written before entries knew their day: midnight UTC, no `posted_on`.
  await ny("old row", new Date("2026-10-01T00:00:00.000Z"));

  const berlin = await business(BERLIN, "Europe/Berlin");
  await berlin("bill on the 1st", new Date("2026-10-01T00:00:00.000Z"), true);
  // CEST is UTC+2: 00:30 on the 1st is 22:30 UTC on 30 September.
  await berlin(
    "sale at 00:30 on the 1st",
    new Date("2026-09-30T22:30:00.000Z"),
  );
  await berlin("old row", new Date("2026-09-30T21:00:00.000Z"));
});

afterAll(async () => {
  await dropOrganization(NY);
  await dropOrganization(BERLIN);
});

/** The probes a report over these days sees, by name. */
async function seen(
  orgId: string,
  zone: string | null,
  from: string,
  to: string,
) {
  const period = periodFrom(
    (name) => (name === "from" ? from : name === "to" ? to : undefined),
    zone,
  );
  const entries = new Set(
    (await ledgerRows(orgId, period)).map((r) => r.entryId),
  );
  return Object.entries(ids)
    .filter(([key, id]) => key.startsWith(`${orgId}:`) && entries.has(id))
    .map(([key]) => key.slice(orgId.length + 1))
    .sort();
}

test("a day-dated entry stores its day", async () => {
  const [row] = await db
    .select({ postedOn: schema.journalEntries.postedOn })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.id, ids[`${NY}:bill on the 1st`] ?? ""));
  expect(row?.postedOn).toBe("2026-10-01");
  const [instant] = await db
    .select({ postedOn: schema.journalEntries.postedOn })
    .from(schema.journalEntries)
    .where(
      eq(
        schema.journalEntries.id,
        ids[`${NY}:sale at 23:30 on the 31st`] ?? "",
      ),
    );
  expect(instant?.postedOn).toBeNull();
});

test("New York: a bill dated the 1st is October's and the 1st's", async () => {
  const z = "America/New_York";
  expect(await seen(NY, z, "2026-10-01", "2026-10-31")).toEqual([
    "bill on the 1st",
    "sale at 23:30 on the 31st",
  ]);
  expect(await seen(NY, z, "2026-10-01", "2026-10-01")).toEqual([
    "bill on the 1st",
  ]);
  // Not the 30th of September, which is where its instant falls there.
  expect(await seen(NY, z, "2026-09-30", "2026-09-30")).toEqual(["old row"]);
});

test("New York: an instant at 23:30 on the 31st is the 31st's", async () => {
  const z = "America/New_York";
  expect(await seen(NY, z, "2026-10-31", "2026-10-31")).toEqual([
    "sale at 23:30 on the 31st",
  ]);
  expect(await seen(NY, z, "2026-11-01", "2026-11-30")).toEqual([]);
});

test("New York: a row without its day is read as before", async () => {
  // Midnight UTC on the 1st, read as an instant: 20:00 on 30 September.
  expect(
    await seen(NY, "America/New_York", "2026-09-01", "2026-09-30"),
  ).toEqual(["old row"]);
});

test("Berlin: the 1st is the 1st, by day and by instant", async () => {
  const z = "Europe/Berlin";
  expect(await seen(BERLIN, z, "2026-10-01", "2026-10-01")).toEqual([
    "bill on the 1st",
    "sale at 00:30 on the 1st",
  ]);
  // 21:00 UTC on the 30th is 23:00 there, and stays the 30th's.
  expect(await seen(BERLIN, z, "2026-09-30", "2026-09-30")).toEqual([
    "old row",
  ]);
});

test("days given without a zone, or written by hand, are the same days", async () => {
  // A period parsed with no zone, as a caller that never asked for one does,
  // names the days that were typed, and a business in New York still sees
  // its own entries on their own days.
  expect(await seen(NY, null, "2026-10-01", "2026-10-31")).toEqual([
    "bill on the 1st",
    "sale at 23:30 on the 31st",
  ]);
  // Bounds built with Date.UTC, as a quarter or a budget month is.
  const rows = await ledgerRows(NY, {
    from: new Date(Date.UTC(2026, 9, 1)),
    to: new Date(Date.UTC(2026, 9, 31)),
  });
  expect(new Set(rows.map((r) => r.entryId))).toEqual(
    new Set([
      ids[`${NY}:bill on the 1st`] ?? "",
      ids[`${NY}:sale at 23:30 on the 31st`] ?? "",
    ]),
  );
});

test("the cash-basis stream places entries on the same days", async () => {
  const period = periodFrom(
    (name) =>
      name === "from" ? "2026-10-01" : name === "to" ? "2026-10-31" : undefined,
    "America/New_York",
  );
  const inside: string[] = [];
  for await (const entry of cashBasisEntries(NY, period)) {
    if (entry.inPeriod) inside.push(entry.id);
  }
  expect(inside.sort()).toEqual(
    [
      ids[`${NY}:bill on the 1st`],
      ids[`${NY}:sale at 23:30 on the 31st`],
    ].sort() as string[],
  );
});
