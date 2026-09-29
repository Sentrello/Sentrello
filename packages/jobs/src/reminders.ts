import { db, schema } from "@sentrello/db";
import { daysLate } from "@sentrello/db/day";
import { creditedAgainst } from "@sentrello/db/documents";
import {
  CORE_ACCOUNTS,
  ensureAccount,
  postJournalEntry,
} from "@sentrello/db/ledger";
import { invoiceState } from "@sentrello/db/money";
import {
  businessIdentity,
  ensurePortalToken,
  moneyLocale,
} from "@sentrello/db/portal";
import { timezoneFor } from "@sentrello/db/timezone";
import { emailAdapter, mailConfigured } from "@sentrello/email";
import {
  escapeHtml,
  formatMoney,
  overdueReminderEmail,
} from "@sentrello/email/templates";
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
  /** And where the business is, which decides what day it is for them. */
  const zoneByOrg = new Map<string, string | null>();

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
      zoneByOrg.set(orgId, await timezoneFor(orgId));
    }

    const paid = await db
      .select({ amountCents: schema.payments.amountCents })
      .from(schema.payments)
      .where(eq(schema.payments.invoiceId, invoice.id));
    const paidCents = paid.reduce((sum, p) => sum + p.amountCents, 0);
    // Credits settle debt beside the payments: a partly credited invoice is
    // chased for the uncredited remainder, not for money nobody is owed.
    const creditedCents =
      (await creditedAgainst(orgId, [invoice.id])).get(invoice.id) ?? 0;
    // The balance the customer's own portal shows them, worked out by the
    // same call — a chase for a figure their page disagrees with is worse
    // than no chase. The early-payment saving is part of that: it settles
    // the invoice without any money arriving.
    const { balanceDue } = invoiceState(invoice, paidCents, creditedCents);
    if (balanceDue <= 0) continue;

    /*
     * Days as the business counts them, in its own timezone.
     *
     * The offsets on the rules are read off a calendar — "three days before",
     * "on the day", "fourteen days after" — so the arithmetic has to be days
     * and not the difference between two instants. Against instants, a chase
     * set for the due date went out in the evening of the day before on every
     * host west of Greenwich.
     */
    const overdueBy = daysLate(
      invoice.dueDate,
      now,
      zoneByOrg.get(orgId) ?? null,
    );
    const rules = rulesByOrg.get(orgId) ?? [];
    const settings = settingsByOrg.get(orgId) ?? null;

    // ---------------------------------------------------------------
    // The late fee, before any chasing: the reminder should say the
    // figure the customer will actually be asked for.
    // ---------------------------------------------------------------
    /*
     * What this run added, and nothing the runs before it added.
     *
     * `balanceDue` above was worked out from the invoice as it was read,
     * so on the run that applies a fee it does not include it yet — and on
     * every run afterwards it does, because the fee is in `totalCents`.
     * One number, set in one place, so the chase cannot charge a fee twice.
     */
    let appliedNow = 0;

    if (
      settings?.lateFeeType &&
      !invoice.lateFeeAppliedAt &&
      overdueBy > settings.lateFeeGraceDays
    ) {
      const fee = lateFeeFor(settings, balanceDue);
      if (fee > 0) {
        /*
         * The fee is money the business is now owed, so it is posted.
         *
         * Until 2026-09-28 this raised `totalCents` and told the ledger
         * nothing. The invoice then asked for more than Accounts Receivable
         * said was owed, for ever, and no report could see the fee at all —
         * a straight breach of the rule that every financial event posts a
         * balanced entry. It was found by a parity walk rather than by
         * anybody's books, because the feature is off by default and nobody
         * had turned it on.
         *
         * Dr Accounts Receivable, Cr Other Income, and nothing to Tax
         * Payable: in the United Kingdom and the EU a late-payment charge is
         * compensation for being kept out of your money, which is outside
         * the scope of VAT.
         *
         * In one transaction with the invoice, so a failure to post cannot
         * leave a total nobody can explain. `postJournalEntry` refuses a
         * date inside a closed period, and that refusal should stop the fee
         * rather than strand it.
         */
        /*
         * The accounts are found before the transaction opens, not inside
         * it. `ensureAccount` uses the pool, and a transaction that calls a
         * pool helper needs a second connection to finish the first — ten
         * of those at once and the pool is gone, which is how this instance
         * was lost twice in September. Creating an account is idempotent
         * and has nothing to gain from being in here.
         */
        const [receivable, otherIncome] = await Promise.all([
          ensureAccount(orgId, CORE_ACCOUNTS.accountsReceivable),
          ensureAccount(orgId, CORE_ACCOUNTS.otherIncome),
        ]);

        await db.transaction(async (tx) => {
          await tx
            .update(schema.invoices)
            .set({
              lateFeeCents: fee,
              lateFeeAppliedAt: now,
              totalCents: invoice.totalCents + fee,
              updatedAt: now,
            })
            .where(eq(schema.invoices.id, invoice.id));

          await postJournalEntry(
            orgId,
            `Late fee on ${invoice.number}`,
            `late-fee:${invoice.id}`,
            [
              { accountId: receivable, debitCents: fee },
              { accountId: otherIncome, creditCents: fee },
            ],
            now,
            { tx },
          );
        });
        feesApplied += 1;
        appliedNow = fee;
      }
    }

    const owedNow = balanceDue + appliedNow;

    const [contact] = invoice.contactId
      ? await db
          .select({
            id: schema.contacts.id,
            email: schema.contacts.email,
            // For the link in the chase. The token they already have, never
            // a fresh one: rotating here would break every link already sent.
            portalToken: schema.contacts.portalToken,
          })
          .from(schema.contacts)
          .where(eq(schema.contacts.id, invoice.contactId))
          .limit(1)
      : [];
    if (!contact?.email) continue;

    /*
     * The page they can settle it on. Best effort — an instance with no
     * base address still gets chased, it just has nothing to press.
     */
    let portalUrl: string | undefined;
    try {
      const base = process.env.SENTRELLO_BASE_URL;
      if (base) {
        portalUrl = `${base}/portal/${await ensurePortalToken(contact)}`;
      }
    } catch (error) {
      console.error("[reminders] could not mint a portal link", error);
    }

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

      /**
       * One address that will not take mail is one invoice, not the sweep.
       *
       * The rule-driven branch below already catches its own send and carries
       * on; this one did not, so a single rejected recipient — a customer
       * whose domain has gone, a mailbox over quota — threw out of the whole
       * run. Every invoice after it in the list went unchased, in every
       * business on the instance, and pg-boss's retry produced the same
       * failure at the same invoice the next time.
       *
       * Nothing is stamped when the send fails, so the next run tries this
       * one again — the throttle only starts once a reminder has actually
       * gone out.
       */
      try {
        await mailer.send({
          to: contact.email,
          ...overdueReminderEmail({
            number: invoice.number,
            /*
             * `balanceDue` already contains the fee.
             *
             * It is derived from `totalCents`, and applying the fee raises
             * that. Adding `lateFeeCents` on top was right on the single run
             * that applied it — the invoice in hand was read before the
             * update — and wrong on every run after, where it charged the
             * customer the fee twice, then three times, then four.
             */
            balanceDueCents: owedNow,
            currency: invoice.currency,
            portalUrl,
            business,
            sentrelloCredit: options.sentrelloCredit ?? true,
          }),
        });
      } catch (err) {
        console.error(
          `[reminders] the weekly chase for ${invoice.number} could not be sent`,
          err,
        );
        continue;
      }
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

    const owed = owedNow;

    /*
     * The same figures the rest of the product writes, in the same words.
     *
     * This path is a business's own chase, written on a settings screen, and
     * it was filling its placeholders by hand: `{{amount}}` came out as
     * "1450.00" with no currency and no thousands separator, and `{{due}}`
     * as "Sat Oct 10 2026" — JavaScript's `toDateString`, in whatever
     * timezone the server happens to be set to, which is the fault fixed in
     * ten other places this morning.
     *
     * Money goes through `formatMoney` with the seller's own locale, the
     * same as every other message; the date is a calendar date and is read
     * in UTC, because a due date has no time in it.
     */
    const filled = (text: string) =>
      text
        .replaceAll("{{number}}", escapeHtml(invoice.number))
        .replaceAll(
          "{{amount}}",
          escapeHtml(
            formatMoney(
              owed,
              invoice.currency,
              moneyLocale(business.countryCode),
            ),
          ),
        )
        .replaceAll("{{business}}", escapeHtml(business.name))
        .replaceAll(
          "{{due}}",
          invoice.dueDate
            ? escapeHtml(
                new Intl.DateTimeFormat(moneyLocale(business.countryCode), {
                  dateStyle: "medium",
                  timeZone: "UTC",
                }).format(invoice.dueDate),
              )
            : "",
        )
        .replaceAll("{{days}}", String(Math.abs(overdueBy)))
        /*
         * And the thing to press, which this path had no way to offer.
         *
         * A business writing its own chase could say what was owed and not
         * how to settle it — every other money message carries the link.
         * Empty when the instance has not been told its own address, so a
         * template that uses it degrades to a sentence rather than to the
         * word "undefined".
         */
        .replaceAll("{{link}}", portalUrl ? escapeHtml(portalUrl) : "");

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
