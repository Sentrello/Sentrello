import { afterAll, beforeAll, expect, test } from "bun:test";
import { db, schema } from "@sentrello/db";
import { eq, inArray } from "@sentrello/db/orm";
import { dropOrganization, makeOrganization } from "@sentrello/db/testing";
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
  // The invoice and its customer belong to a business that exists: every
  // business table has named one with a foreign key since 2026-09-27.
  await makeOrganization(orgId);

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
  await dropOrganization(orgId);
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

/**
 * An invoice the business has filed away.
 *
 * `DELETE /api/invoices/:id` is a soft delete — the document goes to the
 * "deleted" tab and out of every screen. This sweep read it anyway and kept
 * chasing the customer weekly for a bill the business could no longer see.
 */
test("an invoice that has been filed away is not chased", async () => {
  process.env.RESEND_API_KEY = undefined;
  process.env.SMTP_HOST = undefined;

  const before = await sendOverdueReminders(new Date(), {});
  await db
    .update(schema.invoices)
    .set({ deletedAt: new Date() })
    .where(eq(schema.invoices.id, invoiceId));

  const after = await sendOverdueReminders(new Date(), {});
  expect(after.skipped).toBe((before.skipped ?? 0) - 1);

  await db
    .update(schema.invoices)
    .set({ deletedAt: null })
    .where(eq(schema.invoices.id, invoiceId));
});

test("it says how many were waiting, so the silence is explainable", async () => {
  process.env.RESEND_API_KEY = undefined;
  process.env.SMTP_HOST = undefined;

  const result = await sendOverdueReminders(new Date(), {
    sentrelloCredit: true,
  });
  expect(result.skipped ?? 0).toBeGreaterThan(0);
});

test("one address that will not take mail does not stop the rest", async () => {
  /*
   * This sweep runs across every business on the instance, so an uncaught
   * throw from the mailer ended the whole run: every invoice after the bad
   * address went unchased, and the next run started at the same invoice and
   * threw again. Nothing is marked when a send fails, so that one is tried
   * again next time — which is what a transient outage deserves.
   */
  process.env.SMTP_HOST = "localhost";

  const tried: string[] = [];
  const refusing = {
    send: async ({ to }: { to: string }) => {
      tried.push(to);
      if (to === "ade@balogun.test") throw new Error("mailbox unavailable");
    },
  } as unknown as NonNullable<
    Parameters<typeof sendOverdueReminders>[1]
  >["mailer"];

  const result = await sendOverdueReminders(new Date(), {
    mailer: refusing,
  });

  expect(tried).toContain("ade@balogun.test");
  // The run finished rather than throwing, and the refused invoice is not
  // marked, so it will be chased again.
  const [after] = await db
    .select({ lastReminderAt: schema.invoices.lastReminderAt })
    .from(schema.invoices)
    .where(inArray(schema.invoices.id, [invoiceId]));
  expect(after?.lastReminderAt).toBeNull();
  expect(result.sent).toBe(0);
});

/**
 * The chase carries a way to pay.
 *
 * Every other money email in the set links to the customer's own page —
 * the invoice, the receipt, the portal link. The overdue reminder, whose
 * entire purpose is to be acted on, carried a figure and a business name
 * and nothing to press. The invoice email says why that is wrong in its
 * own comment: an invoice somebody has to reply to in order to pay is an
 * invoice that waits.
 */
test("the reminder carries the page they can settle it on", async () => {
  process.env.SMTP_HOST = "localhost";
  process.env.SENTRELLO_BASE_URL = "https://books.example.test";

  const sent: { to: string; html: string }[] = [];
  const catching = {
    send: async (mail: { to: string; html: string }) => {
      sent.push(mail);
    },
  } as unknown as NonNullable<
    Parameters<typeof sendOverdueReminders>[1]
  >["mailer"];

  await sendOverdueReminders(new Date(), { mailer: catching });

  expect(sent.length).toBeGreaterThan(0);
  const chase = sent[0]?.html ?? "";
  expect(chase).toContain("https://books.example.test/portal/");
  expect(chase).toContain("View and pay this invoice");
  // And the warning that goes with a link anybody holding it can open.
  expect(chase).toContain("private to you");
});

/**
 * And an instance that cannot make a link still chases.
 *
 * `SENTRELLO_BASE_URL` is how an instance knows its own address, and one
 * that has not been told it is a misconfiguration rather than a reason to
 * stop asking for money.
 */
test("no address configured is still a chase, just without the link", async () => {
  process.env.SMTP_HOST = "localhost";
  const had = process.env.SENTRELLO_BASE_URL;
  process.env.SENTRELLO_BASE_URL = "";

  /*
   * The stamp from the test above, cleared.
   *
   * A chase that has gone out is not chased again for a day — which is the
   * point of the throttle and, in a file where these run in order, the
   * reason this saw nothing at all the first time it was written.
   */
  await db
    .update(schema.invoices)
    .set({ lastReminderAt: null })
    .where(eq(schema.invoices.organizationId, orgId));

  const sent: { html: string }[] = [];
  const catching = {
    send: async (mail: { html: string }) => {
      sent.push(mail);
    },
  } as unknown as NonNullable<
    Parameters<typeof sendOverdueReminders>[1]
  >["mailer"];

  try {
    await sendOverdueReminders(new Date(), { mailer: catching });
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0]?.html).toContain("Outstanding balance");
    expect(sent[0]?.html).not.toContain("View and pay this invoice");
  } finally {
    if (had === undefined) process.env.SENTRELLO_BASE_URL = "";
    else process.env.SENTRELLO_BASE_URL = had;
  }
});
