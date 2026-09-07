import { afterAll, beforeAll, expect, test } from "bun:test";
import { db, schema } from "@sentrello/db";
import { eq, inArray } from "@sentrello/db/orm";
import { sendOverdueReminders } from "./overdue";

/**
 * The chase, when nobody has set up mail.
 *
 * Found by running the daily job on an instance with no mail configured — the
 * common Free case, and the install treats mail as optional. The no-op adapter
 * logs and returns rather than throwing, so every overdue reminder was "sent"
 * into the void and each invoice was then stamped as chased. The throttle held
 * them for a week afterwards, and configuring mail later would not have chased
 * them either, because they were all marked as done.
 *
 * A business believing its customers are being reminded, while the customers
 * hear nothing, is worse than one that knows it has to phone them.
 */

const orgId = `overdue-test-${crypto.randomUUID().slice(0, 8)}`;
let invoiceId: string;

const saved = {
  resend: process.env.RESEND_API_KEY,
  smtp: process.env.SMTP_HOST,
};

beforeAll(async () => {
  const [contact] = await db
    .insert(schema.contacts)
    .values({
      organizationId: orgId,
      name: "Ade Balogun",
      email: "ade@balogun.test",
      kind: "customer",
    })
    .returning();

  const [invoice] = await db
    .insert(schema.invoices)
    .values({
      organizationId: orgId,
      contactId: contact?.id,
      number: "INV-OVERDUE",
      status: "open",
      currency: "USD",
      issueDate: new Date(Date.now() - 40 * 86_400_000),
      dueDate: new Date(Date.now() - 8 * 86_400_000),
      subtotalCents: 84_000,
      taxCents: 0,
      totalCents: 84_000,
    })
    .returning();
  if (!invoice) throw new Error("no invoice");
  invoiceId = invoice.id;
});

afterAll(async () => {
  process.env.RESEND_API_KEY = saved.resend;
  process.env.SMTP_HOST = saved.smtp;
  await db
    .delete(schema.invoices)
    .where(eq(schema.invoices.organizationId, orgId));
  await db
    .delete(schema.contacts)
    .where(eq(schema.contacts.organizationId, orgId));
});

test("with no mail configured, nobody is chased and nothing is marked", async () => {
  process.env.RESEND_API_KEY = undefined;
  process.env.SMTP_HOST = undefined;

  const result = await sendOverdueReminders(new Date(), {
    sentrelloCredit: true,
  });

  expect(result.sent).toBe(0);
  expect(result.reason).toBe("no mail configured");
  // The stamp is the part that mattered: an invoice marked as chased is one
  // the throttle will skip for a week, including after mail is set up.
  const [after] = await db
    .select({ lastReminderAt: schema.invoices.lastReminderAt })
    .from(schema.invoices)
    .where(inArray(schema.invoices.id, [invoiceId]));
  expect(after?.lastReminderAt).toBeNull();
});

test("it says how many were waiting, so the silence is explainable", async () => {
  process.env.RESEND_API_KEY = undefined;
  process.env.SMTP_HOST = undefined;

  const result = await sendOverdueReminders(new Date(), {
    sentrelloCredit: true,
  });
  expect(result.skipped ?? 0).toBeGreaterThan(0);
});
