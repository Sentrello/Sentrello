import { db, schema } from "@sentrello/db";
import { creditedAgainst } from "@sentrello/db/documents";
import { invoiceState } from "@sentrello/db/money";
import { businessIdentity } from "@sentrello/db/portal";
import { emailAdapter, mailConfigured } from "@sentrello/email";
import { overdueReminderEmail } from "@sentrello/email/templates";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";

/** Don't nag: at most one reminder per invoice per this many hours. */
const REMINDER_INTERVAL_HOURS = 24 * 7;

export async function sendOverdueReminders(
  now = new Date(),
  options: {
    /** Free credits the product; Pro sends under the business's own name. */
    sentrelloCredit?: boolean;
    /**
     * The mailer, so a test can be one that refuses.
     *
     * What this sweep does when a send throws is the whole of its behaviour
     * under an outage, and it cannot be exercised through the environment
     * without asking the test host for a mail server that fails in a
     * particular way.
     */
    mailer?: ReturnType<typeof emailAdapter>;
  } = {},
) {
  const candidates = await db
    .select()
    .from(schema.invoices)
    .where(
      and(
        inArray(schema.invoices.status, ["open", "partial"]),
        isNotNull(schema.invoices.dueDate),
        /*
         * Filed away is not chased.
         *
         * `DELETE /api/invoices/:id` does not delete: it sets `deletedAt` and
         * moves the document to the "deleted" tab, where nobody in the
         * business sees it again. This sweep read every open invoice with a
         * due date, so a document the business had put away kept emailing its
         * customer once a week for ever — and the business could not see the
         * invoice it was being asked about. The rule-driven sweep beside this
         * one already excluded them; two chasers disagreeing about what is
         * chaseable is how one of them ends up wrong.
         */
        isNull(schema.invoices.deletedAt),
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

  const mailer = options.mailer ?? emailAdapter();
  let sent = 0;

  for (const invoice of candidates) {
    if (!invoice.dueDate) continue;

    const paid = await db
      .select({ amountCents: schema.payments.amountCents })
      .from(schema.payments)
      .where(eq(schema.payments.invoiceId, invoice.id));
    const paidCents = paid.reduce((s, p) => s + p.amountCents, 0);
    // Credits settle debt beside the payments: a partly credited invoice is
    // chased for the uncredited remainder, not for money nobody is owed.
    const creditedCents =
      (await creditedAgainst(invoice.organizationId, [invoice.id])).get(
        invoice.id,
      ) ?? 0;
    // The same call the customer's own page reads, so nobody is chased for a
    // bill their portal says is settled — including the part of it given up
    // for paying early, which settles the invoice without any money arriving.
    const { balanceDue, badge } = invoiceState(
      invoice,
      paidCents,
      creditedCents,
      now,
    );

    if (badge !== "overdue") continue;

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
    /*
     * One address that will not take mail is one chase, not the rest of them.
     *
     * This sweep runs across every business on the instance, so an uncaught
     * throw here stops the chase for all of them — and the run after it starts
     * at the same invoice and throws again. Nothing is marked when the send
     * fails, so that invoice is tried again next time, which is what a
     * transient mailer outage deserves.
     */
    try {
      await mailer.send({ to: contact.email, ...mail });
    } catch (error) {
      console.error("[overdue] reminder mail failed", error);
      continue;
    }

    await db
      .update(schema.invoices)
      .set({ lastReminderAt: now })
      .where(eq(schema.invoices.id, invoice.id));
    sent++;
  }

  return { sent, skipped: 0 };
}
