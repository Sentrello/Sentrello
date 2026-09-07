import { db, schema } from "@sentrello/db";
import { invoiceStatus } from "@sentrello/db/money";
import { businessIdentity } from "@sentrello/db/portal";
import { emailAdapter, mailConfigured } from "@sentrello/email";
import { overdueReminderEmail } from "@sentrello/email/templates";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";

/**
 * Chasing by rule, and charging for being late.
 *
 * A business decides when it chases — a gentle note three days before the due
 * date reads very differently from a firm one fourteen days after — so the
 * schedule is rows in a table rather than a constant in this file. Each rule
 * is an offset from the due date, negative before and positive after.
 *
 * The two things that must not go wrong, and how each is prevented:
 *
 * **Nobody is chased twice for the same thing.** A rule firing once per
 * invoice is enforced by a unique key on the log, not by a timestamp
 * comparison — a scheduler that reruns, a clock that moves, or two processes
 * on the same minute all produce the same customer receiving the same firm
 * letter four times in a morning.
 *
 * **A late fee is charged once, and only when a business asked for it.** It is
 * off unless configured, it has a grace period, and the invoice records when
 * it was applied so a rerun cannot apply it again.
 */

/** With no rules configured, this is the fallback: one chase a week. */
const FALLBACK_INTERVAL_HOURS = 24 * 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from the due date to now. Negative means it is not due yet. */
export function daysPastDue(dueDate: Date, now: Date): number {
  return Math.floor((now.getTime() - dueDate.getTime()) / DAY_MS);
}

/**
 * Which rules apply to an invoice at this moment.
 *
 * A rule fires once its offset has been reached, not only on the exact day —
 * otherwise a job that fails to run on a Tuesday means that reminder is never
 * sent at all, and the log is what stops the backlog arriving at once.
 */
export function rulesDue(
  rules: { id: string; daysOffset: number }[],
  overdueBy: number,
): { id: string; daysOffset: number }[] {
  return rules
    .filter((rule) => overdueBy >= rule.daysOffset)
    .sort((a, b) => a.daysOffset - b.daysOffset);
}

/**
 * What a late fee comes to on a given balance.
 *
 * Rounded to whole cents like every other amount, and never larger than the
 * balance it is charged on — a fee bigger than the debt is a typed-in
 * percentage nobody meant.
 */
export function lateFeeFor(
  settings: { lateFeeType: string | null; lateFeeValue: number },
  balanceCents: number,
): number {
  if (!settings.lateFeeType || settings.lateFeeValue <= 0) return 0;
  const fee =
    settings.lateFeeType === "percent"
      ? Math.round((balanceCents * settings.lateFeeValue) / 10000)
      : settings.lateFeeValue;
  return Math.max(0, Math.min(fee, balanceCents));
}

interface Outcome {
  sent: number;
  feesApplied: number;
  skipped: number;
  reason?: "no mail configured";
}

export async function runReminders(
  now = new Date(),
  options: {
    /** Free credits the product; Pro sends under the business's own name. */
    sentrelloCredit?: boolean;
    /**
     * Where the mail goes.
     *
     * Injectable so the rules — which is what this file is actually about —
     * can be tested without a transport. Both real adapters do network I/O on
     * `send`, so without this the only testable path would be the one where
     * no mail is configured at all.
     */
    mailer?: {
      send: (m: { to: string; subject: string; html: string }) => Promise<void>;
    };
  } = {},
): Promise<Outcome> {
  const candidates = await db
    .select()
    .from(schema.invoices)
    .where(
      and(
        inArray(schema.invoices.status, ["open", "partial"]),
        isNotNull(schema.invoices.dueDate),
        isNull(schema.invoices.deletedAt),
      ),
    );

  /**
   * With no mail configured, chase nobody and mark nothing.
   *
   * The no-op adapter logs and returns rather than throwing, so this loop used
   * to "send" every reminder into the void and then stamp each invoice as
   * chased. A business that had not set up mail believed its customers were
   * being reminded, the customers heard nothing, and configuring mail later
   * would not have chased them either — they were all marked as done.
   */
  if (!mailConfigured()) {
    if (candidates.length > 0) {
      console.warn(
        `[reminders] ${candidates.length} invoice(s) may be overdue and no mail is configured, so nobody was chased`,
      );
    }
    return {
      sent: 0,
      feesApplied: 0,
      skipped: candidates.length,
      reason: "no mail configured",
    };
  }

  const mailer = options.mailer ?? emailAdapter();
  let sent = 0;
  let feesApplied = 0;

  /** Rules and settings are per business; read once per business, not per row. */
  const rulesByOrg = new Map<
    string,
    (typeof schema.reminderRules.$inferSelect)[]
  >();
  const settingsByOrg = new Map<
    string,
    typeof schema.invoicingSettings.$inferSelect | null
  >();

  /**
   * What has already been sent, for every invoice at once.
   *
   * This was a query per invoice inside the loop. A business with two hundred
   * overdue invoices made two hundred round trips on every run of a job that
   * runs daily — and the reminder log is small enough to read whole, so the
   * loop was paying a network cost to learn almost nothing.
   */
  const sentAlready = new Map<string, Set<string | null>>();
  if (candidates.length > 0) {
    const log = await db
      .select({
        invoiceId: schema.reminderLog.invoiceId,
        ruleId: schema.reminderLog.ruleId,
      })
      .from(schema.reminderLog)
      .where(
        inArray(
          schema.reminderLog.invoiceId,
          candidates.map((c) => c.id),
        ),
      );
    for (const row of log) {
      const set = sentAlready.get(row.invoiceId) ?? new Set();
      set.add(row.ruleId);
      sentAlready.set(row.invoiceId, set);
    }
  }

  for (const invoice of candidates) {
    if (!invoice.dueDate) continue;
    const orgId = invoice.organizationId;

    if (!rulesByOrg.has(orgId)) {
      rulesByOrg.set(
        orgId,
        await db
          .select()
          .from(schema.reminderRules)
          .where(
            and(
              eq(schema.reminderRules.organizationId, orgId),
              eq(schema.reminderRules.active, true),
            ),
          ),
      );
      const [found] = await db
        .select()
        .from(schema.invoicingSettings)
        .where(eq(schema.invoicingSettings.organizationId, orgId))
        .limit(1);
      settingsByOrg.set(orgId, found ?? null);
    }

    const paid = await db
      .select({ amountCents: schema.payments.amountCents })
      .from(schema.payments)
      .where(eq(schema.payments.invoiceId, invoice.id));
    const paidCents = paid.reduce((sum, p) => sum + p.amountCents, 0);
    const { balanceDue } = invoiceStatus(invoice.totalCents, paidCents);
    if (balanceDue <= 0) continue;

    const overdueBy = daysPastDue(invoice.dueDate, now);
    const rules = rulesByOrg.get(orgId) ?? [];
    const settings = settingsByOrg.get(orgId) ?? null;

    // ---------------------------------------------------------------
    // The late fee, before any chasing: the reminder should say the
    // figure the customer will actually be asked for.
    // ---------------------------------------------------------------
    if (
      settings?.lateFeeType &&
      !invoice.lateFeeAppliedAt &&
      overdueBy > settings.lateFeeGraceDays
    ) {
      const fee = lateFeeFor(settings, balanceDue);
      if (fee > 0) {
        await db
          .update(schema.invoices)
          .set({
            lateFeeCents: fee,
            lateFeeAppliedAt: now,
            totalCents: invoice.totalCents + fee,
            updatedAt: now,
          })
          .where(eq(schema.invoices.id, invoice.id));
        feesApplied += 1;
      }
    }

    const [contact] = invoice.contactId
      ? await db
          .select({ email: schema.contacts.email })
          .from(schema.contacts)
          .where(eq(schema.contacts.id, invoice.contactId))
          .limit(1)
      : [];
    if (!contact?.email) continue;

    const business = await businessIdentity(orgId);

    if (rules.length === 0) {
      /**
       * No rules: the built-in weekly chase, and only once it is actually
       * late. A business that has not configured anything still gets its
       * invoices chased, which is what most of them want.
       */
      if (overdueBy < 0) continue;
      const throttledUntil = invoice.lastReminderAt
        ? invoice.lastReminderAt.getTime() + FALLBACK_INTERVAL_HOURS * 3600_000
        : 0;
      if (now.getTime() < throttledUntil) continue;

      await mailer.send({
        to: contact.email,
        ...overdueReminderEmail({
          number: invoice.number,
          balanceDueCents: balanceDue + (invoice.lateFeeCents ?? 0),
          currency: invoice.currency,
          business,
          sentrelloCredit: options.sentrelloCredit ?? true,
        }),
      });
      await db
        .update(schema.invoices)
        .set({ lastReminderAt: now })
        .where(eq(schema.invoices.id, invoice.id));
      sent += 1;
      continue;
    }

    // ---------------------------------------------------------------
    // Rules. The earliest unsent one that has come due, and one per run:
    // a business that adds four rules to an invoice already sixty days
    // late should not send all four in the same minute.
    // ---------------------------------------------------------------
    const done = sentAlready.get(invoice.id) ?? new Set<string | null>();

    const next = rulesDue(rules, overdueBy).find((rule) => !done.has(rule.id));
    if (!next) continue;

    const rule = rules.find((r) => r.id === next.id);
    if (!rule) continue;

    /**
     * Written before the send, not after.
     *
     * The unique key on (invoice, rule) is what makes this safe: if two runs
     * overlap, the second insert fails and that run sends nothing. Sending
     * first and logging after would mean a crash between them chases the same
     * customer again on the next run.
     */
    try {
      await db.insert(schema.reminderLog).values({
        organizationId: orgId,
        invoiceId: invoice.id,
        ruleId: rule.id,
        sentAt: now,
        sentTo: contact.email,
      });
    } catch {
      // Another run got there first. Leave it to them.
      continue;
    }

    const owed = balanceDue + (invoice.lateFeeCents ?? 0);
    const filled = (text: string) =>
      text
        .replaceAll("{{number}}", invoice.number)
        .replaceAll("{{amount}}", (owed / 100).toFixed(2))
        .replaceAll("{{business}}", business.name)
        .replaceAll(
          "{{due}}",
          invoice.dueDate ? invoice.dueDate.toDateString() : "",
        )
        .replaceAll("{{days}}", String(Math.abs(overdueBy)));

    try {
      await mailer.send({
        to: contact.email,
        subject: filled(rule.subject),
        html: `<p>${filled(rule.body).replace(/\n/g, "<br>")}</p>`,
      });
    } catch (err) {
      /**
       * The claim is released, so the next run tries again.
       *
       * Keeping it would mean a mail server down for an hour loses that
       * reminder for ever — the rule is marked as fired and never fires
       * again. The cost of releasing it is a duplicate if the process dies
       * between the send and this delete, which is the rarer and the cheaper
       * of the two failures.
       */
      await db
        .delete(schema.reminderLog)
        .where(
          and(
            eq(schema.reminderLog.invoiceId, invoice.id),
            eq(schema.reminderLog.ruleId, rule.id),
          ),
        );
      console.error(
        `[reminders] rule ${rule.name} failed for ${invoice.number}`,
        err,
      );
      continue;
    }

    await db
      .update(schema.invoices)
      .set({ lastReminderAt: now })
      .where(eq(schema.invoices.id, invoice.id));
    sent += 1;
  }

  return { sent, feesApplied, skipped: 0 };
}
