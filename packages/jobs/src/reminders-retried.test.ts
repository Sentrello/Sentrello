import { afterAll, beforeAll, expect, test } from "bun:test";
import { db, schema } from "@sentrello/db";
import { dropOrganization, makeOrganization } from "@sentrello/db/testing";
import { runReminders } from "./reminders";

/**
 * A chase that failed, tried again an hour later.
 *
 * A send that times out may still have reached the customer, and both
 * branches give the claim back on any failure so the next sweep tries again.
 * What stops that second try becoming a second letter is the provider seeing
 * the same key both times — so the key has to be the letter's, not the
 * attempt's.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const ruled = `retried-rule-${suffix}`;
const weekly = `retried-weekly-${suffix}`;
const saved = { resend: process.env.RESEND_API_KEY };

function morning(hour: number): Date {
  const at = new Date();
  at.setUTCHours(hour, 0, 0, 0);
  return at;
}

/** Times out on the first letter to each address, as a slow provider does. */
const keys = new Map<string, (string | undefined)[]>();
const mailer = {
  async send(m: { to: string; idempotencyKey?: string }) {
    const sent = keys.get(m.to) ?? [];
    sent.push(m.idempotencyKey);
    keys.set(m.to, sent);
    if (sent.length === 1) throw new Error("The operation timed out.");
  },
};

async function anOverdueInvoice(orgId: string, email: string) {
  const [contact] = await db
    .insert(schema.contacts)
    .values({ organizationId: orgId, name: "Ines Duarte", email })
    .returning();
  if (!contact) throw new Error("no contact");
  await db.insert(schema.invoices).values({
    organizationId: orgId,
    contactId: contact.id,
    number: `INV-${suffix}`,
    status: "open",
    currency: "USD",
    issueDate: new Date(Date.now() - 40 * 86_400_000),
    dueDate: new Date(Date.now() - 10 * 86_400_000),
    subtotalCents: 10_000,
    totalCents: 10_000,
  });
}

beforeAll(async () => {
  process.env.RESEND_API_KEY = "test-key-for-reminders";
  await makeOrganization(ruled);
  await makeOrganization(weekly);
  await db.insert(schema.reminderRules).values({
    organizationId: ruled,
    name: "Firm",
    daysOffset: 7,
    subject: "{{number}} is overdue",
    body: "Please pay {{amount}}.",
    active: true,
  });
  await anOverdueInvoice(ruled, `rule-${suffix}@example.test`);
  await anOverdueInvoice(weekly, `weekly-${suffix}@example.test`);
});

afterAll(async () => {
  process.env.RESEND_API_KEY = saved.resend ?? "";
  await dropOrganization(ruled);
  await dropOrganization(weekly);
});

test("a chase retried after a timeout asks under the same key", async () => {
  // Each sweep reads every business on the database, so both branches are
  // run by the same two sweeps rather than one test each.
  await runReminders(morning(10), { mailer });
  await runReminders(morning(11), { mailer });

  for (const email of [
    `rule-${suffix}@example.test`,
    `weekly-${suffix}@example.test`,
  ]) {
    const sent = keys.get(email) ?? [];
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBeTruthy();
    expect(sent[1]).toBe(sent[0]);
  }
}, 30_000);
