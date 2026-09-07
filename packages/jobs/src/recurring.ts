import { db, schema } from "@sentrello/db";
import { rateOn } from "@sentrello/db/currency";
import { copyInvoice } from "@sentrello/db/documents";
import {
  CORE_ACCOUNTS,
  ensureAccount,
  postInvoiceIssued,
  postJournalEntry,
} from "@sentrello/db/ledger";
import { MoneyError, lineTotals } from "@sentrello/db/money";
import { nextDocumentNumber } from "@sentrello/db/numbering";
import { businessIdentity, ensurePortalToken } from "@sentrello/db/portal";
import { emailAdapter, mailConfigured } from "@sentrello/email";
import { invoiceEmail } from "@sentrello/email/templates";
import { and, eq, lte } from "drizzle-orm";
import { type Interval, nextRun } from "./dates";

type TemplateLine = {
  description: string;
  quantity: number;
  unitPrice: number;
  taxRateBp: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Invoices that raise themselves.
 *
 * Every profile whose next run has passed produces an invoice, posts its own
 * balanced ledger entry, and moves its schedule on. The schedule advances in
 * the same transaction as the invoice, because a run that issues the document
 * and then fails to advance issues it again on the next tick — the same
 * customer billed twice for the same month.
 *
 * Two ways a profile says what to bill. A **template invoice** is the good
 * one: a real draft somebody can open, price and correct, copied in full each
 * period. **Inline lines** are the older shape, kept because profiles created
 * before templates existed still carry them.
 */
export async function runRecurringInvoices(
  now = new Date(),
  options: {
    /** Injectable so auto-send can be tested without a transport. */
    mailer?: {
      send: (m: { to: string; subject: string; html: string }) => Promise<void>;
    };
  } = {},
) {
  const due = await db
    .select()
    .from(schema.recurringProfiles)
    .where(
      and(
        eq(schema.recurringProfiles.active, true),
        lte(schema.recurringProfiles.nextRunAt, now),
      ),
    );

  let issued = 0;
  let sent = 0;
  let ended = 0;
  const skipped: { profileId: string; reason: string }[] = [];

  for (const profile of due) {
    const orgId = profile.organizationId;
    const every = profile.intervalCount ?? 1;
    const after = nextRun(
      profile.nextRunAt,
      profile.interval as Interval,
      every,
    );

    /**
     * A schedule that has run out stops before it bills again.
     *
     * Checked against this run's date rather than the next one: a profile
     * ending on the 30th should raise the invoice due on the 30th and then
     * stop, not stop one period early.
     */
    if (profile.endsOn && profile.nextRunAt > profile.endsOn) {
      await db
        .update(schema.recurringProfiles)
        .set({ active: false })
        .where(eq(schema.recurringProfiles.id, profile.id));
      ended += 1;
      continue;
    }

    /**
     * A subscription that is not billing today, and why.
     *
     * Paused is a customer who asked for a break and is coming back: the
     * schedule stands still rather than running up invoices nobody agreed to.
     * A trial bills nothing until it ends. And a cancellation takes effect at
     * the end of the period already paid for, not the moment it was asked
     * for — so the profile stops here rather than raising one more.
     */
    if (profile.kind === "subscription") {
      if (profile.status === "paused") continue;
      if (profile.status === "cancelled") {
        await db
          .update(schema.recurringProfiles)
          .set({ active: false })
          .where(eq(schema.recurringProfiles.id, profile.id));
        ended += 1;
        continue;
      }
      if (profile.trialEndsAt && profile.trialEndsAt > now) continue;
      if (profile.cancelAt && profile.nextRunAt >= profile.cancelAt) {
        await db
          .update(schema.recurringProfiles)
          .set({
            active: false,
            status: "cancelled",
            cancelledAt: profile.cancelledAt ?? now,
          })
          .where(eq(schema.recurringProfiles.id, profile.id));
        ended += 1;
        continue;
      }
    }

    let invoice: typeof schema.invoices.$inferSelect;
    let totals: { subtotal: number; tax: number; total: number };

    /**
     * What this profile's currency is worth today.
     *
     * Fixed onto the invoice so the books do not change when somebody re-reads
     * them next year. A currency the business has never priced is skipped
     * rather than billed at 1:1 — a plausible wrong number in the ledger is
     * worse than an invoice that did not go out, because the second one gets
     * noticed.
     */
    const rate = await rateOn(orgId, profile.currency ?? "USD", now);
    if (rate === null) {
      console.error(
        `[recurring] profile ${profile.id} bills in ${profile.currency} and no rate is recorded`,
      );
      skipped.push({
        profileId: profile.id,
        reason: `no exchange rate for ${profile.currency}`,
      });
      continue;
    }

    if (profile.kind === "subscription") {
      const billed = await billPlan(profile, now, after, rate);
      if ("reason" in billed) {
        console.error(
          `[recurring] subscription ${profile.id} could not be billed: ${billed.reason}`,
        );
        skipped.push({ profileId: profile.id, reason: billed.reason });
        continue;
      }
      invoice = billed.invoice;
      totals = billed.totals;
    } else if (profile.templateInvoiceId) {
      const copy = await copyInvoice(orgId, profile.templateInvoiceId, {
        status: "open",
        issueDate: now,
        dueDate: new Date(now.getTime() + 30 * DAY_MS),
        contactId: profile.contactId,
      });
      if (!copy) {
        // The template was deleted out from under the profile. One profile's
        // problem, not the run's: everybody else is due today too.
        console.error(
          `[recurring] profile ${profile.id} points at an invoice that is gone`,
        );
        skipped.push({ profileId: profile.id, reason: "template is missing" });
        continue;
      }
      invoice = copy;
      totals = {
        subtotal: copy.subtotalCents,
        tax: copy.taxCents,
        total: copy.totalCents,
      };
      await db
        .update(schema.recurringProfiles)
        .set(advanced(profile, after, now))
        .where(eq(schema.recurringProfiles.id, profile.id));
    } else {
      const lines = (profile.templateJson?.lines ?? []) as TemplateLine[];

      // One unusable template must not stop the run. The profile keeps its
      // nextRunAt, so it is retried once someone fixes it rather than being
      // silently skipped for ever.
      let t: ReturnType<typeof lineTotals>;
      try {
        t = lineTotals(lines);
      } catch (err) {
        if (!(err instanceof MoneyError)) throw err;
        console.error(
          `[recurring] profile ${profile.id} has an unusable template: ${err.message}`,
        );
        skipped.push({ profileId: profile.id, reason: err.message });
        continue;
      }
      totals = t;

      invoice = await db.transaction(async (tx) => {
        const [inv] = await tx
          .insert(schema.invoices)
          .values({
            organizationId: orgId,
            contactId: profile.contactId,
            number: await nextDocumentNumber(tx, orgId, "invoice"),
            status: "open",
            // What this currency was worth today, fixed onto the document so
            // the books do not change when somebody re-reads them next year.
            rateMicro: rate,
            // Recurring invoices had no due date, so overdue chasing — which
            // skips invoices without one — never saw them. These are the least
            // watched invoices a business has, which makes that the worst place
            // for them to go unasked-for. Thirty days, as elsewhere.
            dueDate: new Date(now.getTime() + 30 * DAY_MS),
            subtotalCents: t.subtotal,
            taxCents: t.tax,
            totalCents: t.total,
          })
          .returning();
        if (!inv) throw new Error("recurring invoice insert returned no row");
        if (lines.length > 0) {
          await tx.insert(schema.invoiceLines).values(
            lines.map((l) => ({
              invoiceId: inv.id,
              description: l.description,
              quantity: l.quantity,
              unitPriceCents: l.unitPrice,
              taxRateBp: l.taxRateBp,
            })),
          );
        }
        await tx
          .update(schema.recurringProfiles)
          .set(advanced(profile, after, now))
          .where(eq(schema.recurringProfiles.id, profile.id));
        return inv;
      });
    }

    /**
     * In the books, through the one function that knows how.
     *
     * This wrote its own entry until 2026-08-24, and had drifted: it credited
     * income with the subtotal, which does not balance once a discount is
     * taken off the total, and it posted face value whatever currency the
     * profile billed in — so a subscription in euros put euro cents into
     * dollar books.
     */
    await postInvoiceIssued(
      orgId,
      {
        id: invoice.id,
        number: invoice.number,
        taxCents: totals.tax,
        totalCents: totals.total,
        rateMicro: invoice.rateMicro,
      },
      `Recurring invoice ${invoice.number}`,
    );
    issued++;

    /**
     * Delivery, when the business asked for it.
     *
     * After the invoice exists and is in the books, never before: a send that
     * succeeds against a document that then fails to save is a customer
     * holding a bill the business has no record of. A failed send leaves the
     * invoice standing — it is raised and owed either way, and somebody can
     * send it by hand.
     */
    if (profile.autoSend && mailConfigured()) {
      const delivered = await deliver(
        orgId,
        invoice,
        options.mailer ?? emailAdapter(),
        // Never credited. Recurring invoicing is Pro, so anything this sends
        // goes out under the business's own name — there is no Free instance
        // for this job to run on.
        false,
      );
      if (delivered) sent += 1;
    }
  }

  return { issued, sent, ended, skipped };
}

/**
 * The invoice a subscription raises for one period.
 *
 * Built from the plan and the price this customer agreed to, not from a
 * template document: a subscription is one line — what they subscribed to,
 * how many, at their price — and inventing a template invoice for each
 * subscriber would be a draft nobody edits multiplying by the customer count.
 *
 * The plan is read for its name and nothing else. Price, tax and quantity live
 * on the subscription, so a plan renamed today still bills yesterday's figure.
 */
async function billPlan(
  profile: typeof schema.recurringProfiles.$inferSelect,
  now: Date,
  after: Date,
  rate: number,
): Promise<
  | {
      invoice: typeof schema.invoices.$inferSelect;
      totals: { subtotal: number; tax: number; total: number };
    }
  | { reason: string }
> {
  const orgId = profile.organizationId;
  if (profile.unitPriceCents === null) {
    return { reason: "no price was agreed for this subscription" };
  }

  const [plan] = profile.planItemId
    ? await db
        .select({ name: schema.billableItems.name })
        .from(schema.billableItems)
        .where(
          and(
            eq(schema.billableItems.id, profile.planItemId),
            eq(schema.billableItems.organizationId, orgId),
          ),
        )
        .limit(1)
    : [];
  if (profile.planItemId && !plan) {
    return { reason: "the plan this subscription bills has been deleted" };
  }

  const description = plan?.name ?? profile.name ?? "Subscription";
  const line = {
    description,
    quantity: profile.quantity ?? 1,
    unitPrice: profile.unitPriceCents,
    taxRateBp: profile.taxRateBp ?? 0,
  };

  let totals: ReturnType<typeof lineTotals>;
  try {
    totals = lineTotals([line]);
  } catch (err) {
    if (!(err instanceof MoneyError)) throw err;
    return { reason: err.message };
  }

  const invoice = await db.transaction(async (tx) => {
    const [inv] = await tx
      .insert(schema.invoices)
      .values({
        organizationId: orgId,
        contactId: profile.contactId,
        number: await nextDocumentNumber(tx, orgId, "invoice"),
        status: "open",
        currency: profile.currency ?? "USD",
        rateMicro: rate,
        dueDate: new Date(now.getTime() + 30 * DAY_MS),
        subtotalCents: totals.subtotal,
        taxCents: totals.tax,
        totalCents: totals.total,
        // The period this pays for, in words the customer will recognise on
        // the document rather than a date range they have to work out.
        notes: `${description} — ${profile.nextRunAt.toDateString()} to ${after.toDateString()}`,
      })
      .returning();
    if (!inv) throw new Error("subscription invoice insert returned no row");

    await tx.insert(schema.invoiceLines).values({
      invoiceId: inv.id,
      description: line.description,
      quantity: line.quantity,
      unitPriceCents: line.unitPrice,
      taxDefinitionId: profile.taxDefinitionId,
      taxRateBp: line.taxRateBp,
    });

    await tx
      .update(schema.recurringProfiles)
      .set({
        ...advanced(profile, after, now),
        // A subscription that has started is active, whatever it was before:
        // a trial that has ended bills, and the row should say so.
        status: profile.status === "trialing" ? "active" : profile.status,
        startedAt: profile.startedAt ?? now,
      })
      .where(eq(schema.recurringProfiles.id, profile.id));
    return inv;
  });

  return { invoice, totals };
}

/** What a profile looks like once this period has been billed. */
function advanced(
  profile: typeof schema.recurringProfiles.$inferSelect,
  after: Date,
  now: Date,
) {
  return {
    nextRunAt: after,
    generatedCount: (profile.generatedCount ?? 0) + 1,
    lastGeneratedAt: now,
    /**
     * The last one. A profile ending on the 30th and next due on the 30th
     * bills once more and then stops, so the following run has nothing to do
     * rather than having to decide again.
     */
    active: profile.endsOn ? after <= profile.endsOn : true,
  };
}

async function deliver(
  orgId: string,
  invoice: typeof schema.invoices.$inferSelect,
  mailer: {
    send: (m: { to: string; subject: string; html: string }) => Promise<void>;
  },
  sentrelloCredit: boolean,
): Promise<boolean> {
  if (!invoice.contactId) return false;
  const [contact] = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.id, invoice.contactId))
    .limit(1);
  if (!contact?.email) {
    console.warn(
      `[recurring] ${invoice.number} is set to send itself and its customer has no email address`,
    );
    return false;
  }

  const [org] = await db
    .select({ name: schema.organizations.name })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId))
    .limit(1);
  const base = process.env.SENTRELLO_BASE_URL ?? "";
  const token = await ensurePortalToken(contact);

  try {
    await mailer.send({
      to: contact.email,
      ...invoiceEmail({
        number: invoice.number,
        totalCents: invoice.totalCents,
        currency: invoice.currency,
        dueDate: invoice.dueDate,
        businessName: org?.name,
        business: await businessIdentity(orgId),
        sentrelloCredit,
        portalUrl: base ? `${base}/portal/${token}` : undefined,
      }),
    });
  } catch (err) {
    console.error(`[recurring] could not send ${invoice.number}`, err);
    return false;
  }

  await db
    .update(schema.invoices)
    .set({ published: true })
    .where(eq(schema.invoices.id, invoice.id));
  return true;
}
