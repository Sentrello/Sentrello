import { afterAll, beforeAll, expect, test } from "bun:test";
import { db, eq, schema } from "@sentrello/db";
import { dayIn } from "./day";
import { raiseInvoice } from "./documents";
import { PeriodClosedError, ensureAccount, postJournalEntry } from "./ledger";
import { dropOrganization, makeOrganization } from "./testing";

/**
 * The period lock, for a business west of UTC.
 *
 * A day is stored as midnight UTC, and the lock read it as an instant: in New
 * York, midnight UTC on the 29th is eight in the evening on the 28th, so a
 * business closed through the 28th was refused an invoice dated the 29th —
 * the first open day. A day is now its own day; an instant is still read
 * where the business is.
 */
const orgId = `lock-days-${crypto.randomUUID().slice(0, 8)}`;
let cash = "";
let income = "";

beforeAll(async () => {
  await makeOrganization(orgId);
  await db
    .update(schema.organizations)
    .set({ timezone: "America/New_York" })
    .where(eq(schema.organizations.id, orgId));
  await db.insert(schema.ledgerSettings).values({
    organizationId: orgId,
    closedThrough: new Date("2026-09-28T00:00:00.000Z"),
  });
  cash = await ensureAccount(orgId, {
    code: "1000",
    name: "Cash",
    type: "asset",
  });
  income = await ensureAccount(orgId, {
    code: "4000",
    name: "Sales",
    type: "income",
  });
});

afterAll(async () => {
  await dropOrganization(orgId);
});

const post = (at: Date, day?: boolean) =>
  postJournalEntry(
    orgId,
    "probe",
    `probe:${crypto.randomUUID()}`,
    [
      { accountId: cash, debitCents: 100 },
      { accountId: income, creditCents: 100 },
    ],
    at,
    { day },
  );

test("a day-dated entry on the first open day posts", async () => {
  await expect(
    post(new Date("2026-09-29T00:00:00.000Z"), true),
  ).resolves.toBeDefined();
});

test("a day-dated entry on the last closed day is refused", async () => {
  await expect(
    post(new Date("2026-09-28T00:00:00.000Z"), true),
  ).rejects.toBeInstanceOf(PeriodClosedError);
  // An end-of-day stamp on the same UTC date is the same day.
  await expect(
    post(new Date("2026-09-28T23:59:59.000Z"), true),
  ).rejects.toBeInstanceOf(PeriodClosedError);
});

test("an instant at 23:30 New York time on the 28th is refused", async () => {
  // EDT is UTC-4: 23:30 on the 28th is 03:30 UTC on the 29th.
  await expect(
    post(new Date("2026-09-29T03:30:00.000Z")),
  ).rejects.toBeInstanceOf(PeriodClosedError);
});

test("an instant at 00:30 New York time on the 29th posts", async () => {
  await expect(
    post(new Date("2026-09-29T04:30:00.000Z")),
  ).resolves.toBeDefined();
});

test("a raised invoice dated the first open day posts", async () => {
  const today = dayIn(new Date(), "America/New_York");
  const day = (n: number) => new Date(today.getTime() - n * 86_400_000);
  await db
    .update(schema.ledgerSettings)
    .set({ closedThrough: day(11) })
    .where(eq(schema.ledgerSettings.organizationId, orgId));
  const line = { description: "x", quantity: 1, unitPriceCents: 100 };
  const invoice = await raiseInvoice(orgId, {
    contactId: null,
    issueDate: day(10),
    lines: [line],
  });
  expect(invoice?.issueDate.toISOString()).toBe(day(10).toISOString());
  await expect(
    raiseInvoice(orgId, { contactId: null, issueDate: day(11), lines: [line] }),
  ).rejects.toBeInstanceOf(PeriodClosedError);
});
