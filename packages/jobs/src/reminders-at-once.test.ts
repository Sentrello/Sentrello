import { afterAll, beforeAll, expect, test } from "bun:test";
import { db, schema } from "@sentrello/db";
import { eq } from "@sentrello/db/orm";
import { dropOrganization, makeOrganization } from "@sentrello/db/testing";
import { runReminders } from "./reminders";

/**
 * Two sweeps over one overdue invoice at the same moment.
 *
 * The sweep is hourly, and a slow one still running when the next starts — or
 * two processes sharing a database — both read the invoice before either
 * wrote. The fee was charged on "not applied yet" as it was read, and the
 * weekly chase sent on "not chased this week" as it was read, so both runs did
 * both: the fee twice in the books and on the invoice, and the same letter to
 * the same customer twice in one minute.
 */
const orgId = `reminders-at-once-${crypto.randomUUID().slice(0, 8)}`;
const email = `at-once-${crypto.randomUUID().slice(0, 8)}@example.test`;
let invoiceId: string;

const saved = { resend: process.env.RESEND_API_KEY };
const outbox: { to: string }[] = [];
const mailer = {
  async send(m: { to: string; subject: string; html: string }) {
    outbox.push(m);
  },
};

function businessMorning(): Date {
  const at = new Date();
  at.setUTCHours(10, 0, 0, 0);
  return at;
}

beforeAll(async () => {
  process.env.RESEND_API_KEY = "test-key-for-reminders";
  await makeOrganization(orgId);
  await db.insert(schema.invoicingSettings).values({
    organizationId: orgId,
    lateFeeType: "fixed",
    lateFeeValue: 2_500,
    lateFeeGraceDays: 0,
  });
  const [contact] = await db
    .insert(schema.contacts)
    .values({ organizationId: orgId, name: "Ines Duarte", email })
    .returning();
  if (!contact) throw new Error("no contact");
  const [invoice] = await db
    .insert(schema.invoices)
    .values({
      organizationId: orgId,
      contactId: contact.id,
      number: "INV-AT-ONCE",
      status: "open",
      currency: "USD",
      issueDate: new Date(Date.now() - 40 * 86_400_000),
      dueDate: new Date(Date.now() - 10 * 86_400_000),
      subtotalCents: 40_000,
      totalCents: 40_000,
    })
    .returning();
  if (!invoice) throw new Error("no invoice");
  invoiceId = invoice.id;
});

afterAll(async () => {
  process.env.RESEND_API_KEY = saved.resend;
  await dropOrganization(orgId);
});

test("five sweeps at once charge the fee once and chase once", async () => {
  const now = businessMorning();
  await Promise.all(
    Array.from({ length: 5 }, () => runReminders(now, { mailer })),
  );

  const [after] = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoiceId));
  expect(after?.lateFeeCents).toBe(2_500);
  expect(after?.totalCents).toBe(42_500);

  const entries = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.source, `late-fee:${invoiceId}`));
  expect(entries).toHaveLength(1);

  expect(outbox.filter((m) => m.to === email)).toHaveLength(1);
}, 30_000);

test("five sweeps at once send the weekly chase once", async () => {
  // Its fee already charged, so only the chase is left to race for.
  const other = `chase-once-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const [contact] = await db
    .insert(schema.contacts)
    .values({ organizationId: orgId, name: "Tomasz Wolny", email: other })
    .returning();
  if (!contact) throw new Error("no contact");
  await db.insert(schema.invoices).values({
    organizationId: orgId,
    contactId: contact.id,
    number: "INV-CHASE-ONCE",
    status: "open",
    currency: "USD",
    issueDate: new Date(Date.now() - 40 * 86_400_000),
    dueDate: new Date(Date.now() - 10 * 86_400_000),
    subtotalCents: 10_000,
    totalCents: 10_000,
    lateFeeAppliedAt: new Date(),
  });

  const now = businessMorning();
  await Promise.all(
    Array.from({ length: 5 }, () => runReminders(now, { mailer })),
  );
  expect(outbox.filter((m) => m.to === other)).toHaveLength(1);
}, 30_000);
