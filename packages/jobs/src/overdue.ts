import { db, schema } from "@sentrello/db";
import { invoiceStatus } from "@sentrello/db/money";
import { businessIdentity } from "@sentrello/db/portal";
import { emailAdapter, mailConfigured } from "@sentrello/email";
import { overdueReminderEmail } from "@sentrello/email/templates";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { isOverdue } from "./dates";

/** Don't nag: at most one reminder per invoice per this many hours. */
const REMINDER_INTERVAL_HOURS = 24 * 7;

export async function sendOverdueReminders(
  now = new Date(),
  /** Free credits the product; Pro sends under the business's own name. */
  options: { sentrelloCredit?: boolean } = {},
) {
  const candidates = await db
    .select()
    .from(schema.invoices)
    .where(
      and(
        inArray(schema.invoices.status, ["open", "partial"]),
        isNotNull(schema.invoices.dueDate),
      ),
    );

  /**
   * With no mail configured, chase nobody and mark nothing.
   *
   * The no-op adapter logs and returns rather than throwing, so this loop used
   * to "send" every overdue reminder into the void and then stamp each invoice
   * as chased. The throttle then held those invoices for days. A business that
   * had not set up mail — which the install treats as optional — believed its
   * customers were being reminded, the customers heard nothing, and configuring
   * mail later would not have chased them either, because they were all marked
   * as done.
   */
  if (!mailConfigured()) {
    const waiting = candidates.length;
    if (waiting > 0) {
      console.warn(
        `[overdue] ${waiting} invoice(s) may be overdue and no mail is configured, so nobody was chased`,
      );
    }
    return { sent: 0, skipped: waiting, reason: "no mail configured" as const };
  }

  const mailer = emailAdapter();
  let sent = 0;

  for (const invoice of candidates) {
    if (!invoice.dueDate) continue;

    const paid = await db
      .select({ amountCents: schema.payments.amountCents })
      .from(schema.payments)
      .where(eq(schema.payments.invoiceId, invoice.id));
    const paidCents = paid.reduce((s, p) => s + p.amountCents, 0);
    const { balanceDue } = invoiceStatus(invoice.totalCents, paidCents);

    if (!isOverdue(invoice.dueDate, balanceDue, now)) continue;

    const throttledUntil = invoice.lastReminderAt
      ? invoice.lastReminderAt.getTime() +
        REMINDER_INTERVAL_HOURS * 60 * 60 * 1000
      : 0;
    if (now.getTime() < throttledUntil) continue;

    const [contact] = invoice.contactId
      ? await db
          .select({ email: schema.contacts.email })
          .from(schema.contacts)
          .where(eq(schema.contacts.id, invoice.contactId))
          .limit(1)
      : [];
    if (!contact?.email) continue;

    // The chase most likely to be forwarded to somebody's accounts department,
    // where "who is this and where do we pay them" is the whole question.
    const mail = overdueReminderEmail({
      number: invoice.number,
      balanceDueCents: balanceDue,
      currency: invoice.currency,
      business: await businessIdentity(invoice.organizationId),
      sentrelloCredit: options.sentrelloCredit ?? true,
    });
    await mailer.send({ to: contact.email, ...mail });

    await db
      .update(schema.invoices)
      .set({ lastReminderAt: now })
      .where(eq(schema.invoices.id, invoice.id));
    sent++;
  }

  return { sent, skipped: 0 };
}
