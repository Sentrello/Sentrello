import { clientIp } from "@sentrello/auth";
import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, schema } from "@sentrello/db";
import { creditFor } from "@sentrello/db/credit";
import {
  RATE_SCALE,
  baseCurrency,
  rateOn,
  toBaseCents,
} from "@sentrello/db/currency";
import {
  creditBalanceFor,
  recordCreditMovement,
} from "@sentrello/db/customer-credit";
import {
  convertQuoteToInstalments,
  convertQuoteToInvoice,
  defaultDueDate,
} from "@sentrello/db/documents";
import {
  CORE_ACCOUNTS,
  ensureAccount,
  exchangeAccount,
  ownedContact,
  postInvoiceIssued,
  postJournalEntry,
} from "@sentrello/db/ledger";
import {
  MoneyError,
  earlyPaymentTerms,
  invoiceState,
  invoiceStatus,
  lineTotals,
} from "@sentrello/db/money";
import { nextDocumentNumber } from "@sentrello/db/numbering";
import {
  businessIdentity,
  contactByPortalToken,
  ensurePortalToken,
} from "@sentrello/db/portal";
import { emailAdapter, mailConfigured } from "@sentrello/email";
import {
  invoiceEmail,
  portalLinkEmail,
  quoteEmail,
  receiptEmail,
} from "@sentrello/email/templates";
import { defineModule, rateLimit } from "@sentrello/module-sdk";
import { and, eq, isNotNull, isNull, notInArray } from "drizzle-orm";
import { registerInvoicingAccountSection } from "./account-section";
import { registerBillingRules, registerCatalogue } from "./catalogue";
import { registerConsolidate } from "./consolidate";
import { registerDistanceSelling } from "./distance-selling";
import {
  type IncomingLine,
  creditedAgainst,
  parseDiscount,
  parseEarlyPayment,
  prepareDocument,
  quotesGross,
  writeTaxBands,
} from "./documents";
import { registerEInvoice } from "./einvoice-route";
import {
  ExemptionError,
  ensureExemptDefinition,
  exemptLines,
  exemptionForInvoice,
  registerExemptions,
} from "./exemptions";
import { registerLifecycle } from "./lifecycle";
import { registerLists } from "./lists";
import { registerOssReturn } from "./oss-return";
import { registerInvoicingPersonalData } from "./personal-data";
import { portalPage } from "./portal";
import { registerShare } from "./share";
import { registerInvoiceSearch, registerInvoicingSummary } from "./summary";
import { registerDocumentTags, tagsFor } from "./tags";
import { ownedTemplateId, registerTemplates } from "./templates";
import { registerUsFiling } from "./us-filing";
import { registerUsNexus } from "./us-nexus";
import { registerUsRates } from "./us-rates";

/**
 * Tells the customer their payment landed.
 *
 * A payment that produces silence leaves someone wondering whether it went
 * through, which is the moment they email to ask. Never allowed to fail the
 * payment: the money is recorded either way.
 */
async function sendReceipt(
  orgId: string,
  invoice: {
    id: string;
    number: string;
    currency: string;
    contactId: string | null;
  },
  amountCents: number,
  balanceCents: number,
  requestUrl: string,
  /** False on Pro: a paying business sends under its own name. */
  sentrelloCredit = true,
): Promise<void> {
  try {
    if (!invoice.contactId) return;
    const [contact] = await db
      .select()
      .from(schema.contacts)
      // Org-filtered: a receipt must never mail another business's contact,
      // however the id got onto the invoice.
      .where(
        and(
          eq(schema.contacts.id, invoice.contactId),
          eq(schema.contacts.organizationId, orgId),
        ),
      )
      .limit(1);
    if (!contact?.email) return;

    const token = await ensurePortalToken(contact);
    const base = process.env.SENTRELLO_BASE_URL ?? new URL(requestUrl).origin;
    const business = await businessIdentity(orgId);

    await emailAdapter().send({
      to: contact.email,
      ...receiptEmail({
        number: invoice.number,
        amountCents,
        currency: invoice.currency,
        balanceCents,
        businessName: business.name,
        business,
        sentrelloCredit,
        portalUrl: `${base}/portal/${token}`,
        // Same token, same recipient, same email — already theirs to have.
        accountUrl: `${base}/account/${token}`,
      }),
    });
  } catch (err) {
    console.error("[invoicing] sending the receipt failed", err);
  }
}

/** Generous for a customer reading their own bill, hostile to a flood. */
const PORTAL_LIMIT = 30;
const PORTAL_WINDOW_MS = 60_000;

/**
 * Issuing an invoice is an accounting event: Dr AR / Cr Income + Tax.
 *
 * Its own function because it happens twice — when an invoice is raised
 * outright, and when a draft is issued later. Two copies of a journal entry is
 * two chances for the books to disagree with the document.
 *
 * The discount never gets its own line. It has already come off the subtotal,
 * and posting it separately would record revenue the business never earned and
 * then contra it, which reads as a refund on every report that counts them.
 */
/**
 * The invoice in the books.
 *
 * `postIssuedInvoice` does the work, in `@sentrello/db/ledger`, because three
 * other places raise an invoice too — the recurring job for a repeat, the same
 * job for a subscription, and a booking that charges. They had already drifted
 * apart on currency once.
 */
async function postIssued(
  orgId: string,
  invoice: { id: string; number: string; rateMicro?: number },
  amounts: {
    subtotalCents: number;
    discountCents: number;
    taxCents: number;
    totalCents: number;
  },
  /**
   * The date the entry belongs to, which is the invoice's own issue date.
   *
   * This argument was missing, and the create route is where most invoices are
   * raised — it already accepted a back-dated `issueDate` for a business
   * loading its catalogue, and then posted every one of those entries with
   * today's date. So the document said June and the ledger said today, and
   * every report that groups by month — the income chart, the profit and loss,
   * the tax summary — collapsed a whole year of trading into whichever month
   * the loading happened in.
   */
  postedAt?: Date,
): Promise<void> {
  await postInvoiceIssued(
    orgId,
    { ...invoice, ...amounts },
    undefined,
    postedAt,
  );
}

export default defineModule({
  id: "invoicing",
  tier: "free",
  register(ctx) {
    registerInvoicingPersonalData(ctx);
    registerInvoiceSearch(ctx);
    registerEInvoice(ctx);
    registerDistanceSelling(ctx);
    registerOssReturn(ctx);
    registerUsNexus(ctx);
    registerUsRates(ctx);
    registerUsFiling(ctx);
    registerExemptions(ctx);
    ctx.registerNav({
      id: "invoicing",
      label: "Invoices",
      order: 20,
      group: "Money",
      icon: "receipt",
      requires: { invoicing: ["read"] },
    });
    ctx.registerNav({
      id: "quotes",
      label: "Quotes",
      order: 19,
      group: "Sales",
      icon: "file-text",
      requires: { invoicing: ["read"] },
    });
    /*
     * No "recurring" entry here. Billing the same customer the same thing
     * every month is the paid half of Invoicing, and its routes, its screen
     * and the door onto them all live in the `pro-accounting` bundle now — a
     * nav entry's module is what tells the browser which bundle draws the
     * screen, so the offer moved with the thing offered.
     */
    /*
     * Its own page, for the same reason the VAT return has one: knowing
     * where you stand against a state's threshold, and what a period's
     * filing figures are, is a deliberate act with money on it — not a
     * panel to hunt for.
     */
    ctx.registerNav({
      id: "invoicing-oss",
      label: "EU OSS return",
      order: 20.6,
      group: "Money",
      icon: "landmark",
      requires: { invoicing: ["read"] },
    });
    ctx.registerNav({
      id: "invoicing-us-tax",
      label: "US sales tax",
      order: 20.5,
      group: "Money",
      icon: "landmark",
      requires: { invoicing: ["read"] },
    });
    ctx.registerNav({
      id: "invoicing-settings",
      label: "Invoice settings",
      order: 21,
      group: "Money",
      icon: "settings",
      // Read to see them; changing one is guarded on the route itself.
      requires: { invoicing: ["read"] },
    });
    for (const p of ["read", "create", "update", "delete", "send"]) {
      ctx.registerPermission(`invoicing:${p}`);
    }

    registerCatalogue(ctx);
    registerBillingRules(ctx);
    registerLifecycle(ctx);
    registerLists(ctx);
    registerConsolidate(ctx);
    registerDocumentTags(ctx);
    registerShare(ctx);
    registerTemplates(ctx);
    registerInvoicingSummary(ctx);
    registerInvoicingAccountSection(ctx);

    ctx.app.post(
      "/api/invoices",
      requireSession(),
      requirePermission({ invoicing: ["create"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const body = (await c.req.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        const { contactId, currency, dueDate } = body as {
          contactId?: string;
          currency?: string;
          dueDate?: string;
        };

        // A customer may be left off a draft, but a named one has to be this
        // business's — an unverified id here becomes a read of, and an email
        // to, another organisation's contact further down the line.
        if (contactId && !(await ownedContact(orgId, contactId))) {
          return c.json({ error: "no such customer" }, 404);
        }

        /**
         * Everything worked out before anything is written, so a malformed
         * line is the client's mistake rather than a half-written invoice.
         * Say which line and what is wrong with it, not 500.
         */
        /**
         * What this currency was worth today, fixed onto the document.
         *
         * Refused rather than guessed when the business has never recorded a
         * rate for it: posting at 1:1 puts a plausible and wrong figure in the
         * books, and nothing downstream would question it. The same refusal
         * the purchase side makes.
         */
        const rateMicro = await rateOn(
          orgId,
          String(currency ?? "USD"),
          new Date(),
        );
        if (rateMicro === null) {
          return c.json(
            {
              error: `no exchange rate recorded for ${currency} — set one under Accounting first`,
            },
            400,
          );
        }

        /**
         * Whether the prices on these lines already contain the tax.
         *
         * The business's setting at the moment the document is raised, copied
         * onto it below. A UK business that quotes £120 inc. VAT types 120,
         * and 120 is what the invoice asks for.
         */
        const pricesIncludeTax = await quotesGross(orgId);

        let prepared: Awaited<ReturnType<typeof prepareDocument>>;
        let early: ReturnType<typeof parseEarlyPayment>;
        try {
          prepared = await prepareDocument(
            orgId,
            (body.lines ?? []) as IncomingLine[],
            parseDiscount(body),
            pricesIncludeTax,
          );
          early = parseEarlyPayment(body);
        } catch (err) {
          if (err instanceof MoneyError) {
            return c.json({ error: err.message }, 400);
          }
          throw err;
        }

        /**
         * A draft is not an accounting event.
         *
         * The reference lets an invoice be drafted, corrected and only then
         * sent, which is how people actually work — and posting a journal
         * entry for something nobody has seen puts revenue in the books that
         * may never be earned. `status` decides: a draft writes nothing to the
         * ledger, and issuing it later does.
         */
        const asDraft = body.status === "draft";

        /**
         * The day the work was billed, when it was not today.
         *
         * A business adopting Sentrello in June has invoices from January to
         * put in, and without this every one of them lands dated today —
         * which throws out the profit and loss, the tax summary and every
         * report that groups by month. The books are supposed to say when
         * something happened.
         *
         * A future date is refused. An invoice dated next month is a document
         * that does not exist yet, and it would sit outside every aging bucket
         * while quietly counting as income.
         */
        const issued = body.issueDate ? new Date(String(body.issueDate)) : null;
        if (issued && Number.isNaN(issued.getTime())) {
          return c.json({ error: "unreadable issue date" }, 400);
        }
        if (issued && issued.getTime() > Date.now() + 86_400_000) {
          return c.json(
            { error: "an invoice cannot be issued in the future" },
            400,
          );
        }

        /**
         * An exempt sale, if the customer's certificate says so.
         *
         * Validated against the issue date — the day of the sale is the day
         * the auditor asks about — and refused out loud when the certificate
         * has expired or been revoked, because silently charging no tax under
         * a dead certificate is the mistake that costs the business the tax
         * plus penalties, years later. When it holds, every line is charged
         * at Exempt whatever the browser put on it, and the invoice records
         * which certificate excused it.
         */
        let exemptionCertificateId: string | null = null;
        try {
          exemptionCertificateId = await exemptionForInvoice(
            orgId,
            contactId,
            body.exemptionCertificateId,
            issued ?? new Date(),
          );
        } catch (err) {
          if (err instanceof ExemptionError) {
            return c.json({ error: err.message }, 422);
          }
          throw err;
        }
        if (exemptionCertificateId) {
          try {
            prepared = await prepareDocument(
              orgId,
              exemptLines(
                (body.lines ?? []) as IncomingLine[],
                await ensureExemptDefinition(orgId),
              ),
              parseDiscount(body),
              pricesIncludeTax,
            );
          } catch (err) {
            if (err instanceof MoneyError) {
              return c.json({ error: err.message }, 400);
            }
            throw err;
          }
        }

        const invoice = await db.transaction(async (tx) => {
          const [inv] = await tx
            .insert(schema.invoices)
            .values({
              organizationId: orgId,
              contactId,
              currency,
              ...(issued ? { issueDate: issued } : {}),
              // Defaulted rather than left null: overdue chasing skips an
              // invoice with no due date, so one created without a date is
              // money the business is never reminded to ask for.
              dueDate: dueDate ? new Date(dueDate) : defaultDueDate(),
              number: await nextDocumentNumber(tx, orgId, "invoice"),
              status: asDraft ? "draft" : "open",
              notes: String(body.notes ?? "").trim() || null,
              paymentTerms: String(body.paymentTerms ?? "").trim() || null,
              // BT-10 on the e-invoice: the customer's PO or reference, or a
              // German public body's Leitweg-ID.
              buyerReference: String(body.buyerReference ?? "").trim() || null,
              templateId: await ownedTemplateId(orgId, body.templateId),
              discountType:
                (body.discountType as string) === "percent" ||
                (body.discountType as string) === "amount"
                  ? (body.discountType as string)
                  : null,
              discountValue: Number.isInteger(body.discountValue)
                ? (body.discountValue as number)
                : 0,
              discountCents: prepared.discountCents,
              pricesIncludeTax,
              rateMicro,
              earlyDiscountType: early.type,
              earlyDiscountValue: early.value,
              earlyDiscountDays: early.days,
              exemptionCertificateId,
              subtotalCents: prepared.subtotalCents,
              taxCents: prepared.taxCents,
              totalCents: prepared.totalCents,
            })
            .returning();
          if (!inv) throw new Error("invoice insert returned no row");

          await tx
            .insert(schema.invoiceLines)
            .values(prepared.lines.map((l) => ({ invoiceId: inv.id, ...l })));
          await writeTaxBands(tx, orgId, "invoice", inv.id, prepared.bands);
          return inv;
        });

        if (!asDraft) {
          await postIssued(orgId, invoice, prepared, issued ?? undefined);
        }

        return c.json({ invoice }, 201);
      },
    );

    // Record a payment (full or partial): posts Dr Cash / Cr AR and recomputes
    // the invoice status from the ledger-backed payment total.
    ctx.app.post(
      "/api/invoices/:id/payments",
      requireSession(),
      requirePermission({ invoicing: ["update"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const invoiceId = c.req.param("id");
        const {
          amountCents,
          method,
          gatewayRef,
          receivedAt,
          applyEarlyDiscount,
        } = await c.req.json();
        /**
         * When the money actually arrived, which is not always today.
         *
         * A cheque that cleared on Friday and is entered on Monday belongs to
         * Friday, in the ledger as much as on the invoice — otherwise a
         * period's figures depend on when somebody got to their desk.
         */
        const received = receivedAt ? new Date(receivedAt) : new Date();
        if (Number.isNaN(received.getTime())) {
          return c.json({ error: "unreadable date" }, 400);
        }
        if (!Number.isInteger(amountCents) || amountCents <= 0) {
          return c.json(
            { error: "amountCents must be a positive integer" },
            400,
          );
        }

        const [invoice] = await db
          .select()
          .from(schema.invoices)
          .where(
            and(
              eq(schema.invoices.id, invoiceId),
              eq(schema.invoices.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!invoice) return c.json({ error: "not found" }, 404);

        /**
         * What is already settled, read before this payment joins the total —
         * the only way to tell whether *this* payment is the one that goes
         * over, rather than discovering it after the row already exists.
         */
        const before = await db
          .select({ amountCents: schema.payments.amountCents })
          .from(schema.payments)
          .where(
            and(
              eq(schema.payments.invoiceId, invoiceId),
              eq(schema.payments.organizationId, orgId),
            ),
          );
        const paidBeforeCents = before.reduce((s, p) => s + p.amountCents, 0);
        const creditedBeforeCents =
          (await creditedAgainst(orgId, [invoiceId])).get(invoiceId) ?? 0;

        /**
         * Taking the early-payment offer, if there is one and it still stands.
         *
         * Refused rather than ignored when the window has closed. Silently
         * charging the full amount would settle the invoice for less than it
         * asks and leave the difference outstanding for ever, which is the one
         * outcome nobody would notice until an aging report showed a debt that
         * is not real.
         */
        const terms = earlyPaymentTerms(
          {
            type: invoice.earlyDiscountType,
            value: invoice.earlyDiscountValue,
            days: invoice.earlyDiscountDays,
            issueDate: invoice.issueDate,
            totalCents: invoice.totalCents,
          },
          received,
        );
        const takingIt = applyEarlyDiscount === true;
        if (takingIt && !terms.deadline) {
          return c.json(
            { error: "this invoice offers no early-payment discount" },
            400,
          );
        }
        if (takingIt && !terms.open) {
          return c.json({ error: "the early-payment window has closed" }, 400);
        }
        // Already taken once. A second application would forgive the saving
        // twice and settle an invoice that is still owed money.
        if (takingIt && invoice.earlyDiscountTakenCents > 0) {
          return c.json(
            { error: "the early-payment discount is already applied" },
            400,
          );
        }

        /**
         * What is still owed, after anything given up for paying early.
         *
         * The saving is not a payment — no money arrived — so it cannot go in
         * the payments table. It reduces what the invoice asks for, which is
         * what "paid in full, less 2% for paying early" actually means.
         *
         * Credit notes count beside the payments: a customer who paid the
         * uncredited remainder owes nothing, and a status that only counted
         * the money would keep chasing them for the part that was credited.
         */
        const forgiven = takingIt
          ? terms.savingCents
          : invoice.earlyDiscountTakenCents;
        const creditedCents = creditedBeforeCents;
        const owedBeforeCents = Math.max(
          0,
          invoice.totalCents - forgiven - paidBeforeCents - creditedCents,
        );

        /**
         * More than is owed. The business decides what that means — see
         * `overpaymentPolicy` on `invoicingSettings` — but what it never
         * means is receivable quietly going negative, which is what happened
         * here before either behaviour existed.
         */
        let appliedCents = amountCents;
        let overCents = 0;
        if (amountCents > owedBeforeCents) {
          const [invSettings] = await db
            .select({
              overpaymentPolicy: schema.invoicingSettings.overpaymentPolicy,
            })
            .from(schema.invoicingSettings)
            .where(eq(schema.invoicingSettings.organizationId, orgId))
            .limit(1);
          const policy = invSettings?.overpaymentPolicy ?? "refuse";
          if (policy !== "credit") {
            return c.json(
              {
                error: `amountCents (${amountCents}) exceeds what is owed (${owedBeforeCents} cents). Reduce it, or switch to holding overpayments as credit under Invoice settings.`,
              },
              400,
            );
          }
          if (!invoice.contactId) {
            return c.json(
              {
                error:
                  "this invoice has no customer to hold a credit for — reduce the amount, or add a customer to the invoice first",
              },
              400,
            );
          }
          appliedCents = owedBeforeCents;
          overCents = amountCents - appliedCents;
        }

        const [payment] = await db
          .insert(schema.payments)
          .values({
            organizationId: orgId,
            invoiceId,
            // Only what actually settles this invoice — the excess is
            // recorded separately, as credit, never as a payment against a
            // debt that no longer exists once this clears it.
            amountCents: appliedCents,
            method: method ?? "manual",
            gatewayRef,
            receivedAt: received,
          })
          .returning();
        if (!payment) throw new Error("payment insert returned no row");

        const paidCents = paidBeforeCents + appliedCents;
        const { status, balanceDue } = invoiceStatus(
          invoice.totalCents - forgiven,
          paidCents,
          creditedCents,
        );

        await db
          .update(schema.invoices)
          .set(
            takingIt
              ? { status, earlyDiscountTakenCents: terms.savingCents }
              : { status },
          )
          .where(eq(schema.invoices.id, invoiceId));

        const [cash, ar] = await Promise.all([
          ensureAccount(orgId, CORE_ACCOUNTS.cash),
          ensureAccount(orgId, CORE_ACCOUNTS.accountsReceivable),
        ]);
        /**
         * Cash for what arrived, and the saving where a saving belongs.
         *
         * Receivable is credited with the whole of what the customer owed,
         * because that debt is settled and has to leave the balance sheet. The
         * part that never arrived is a sales discount — a contra-revenue
         * account, so a business can see what it gave away rather than only a
         * smaller income figure it cannot explain.
         */
        /**
         * Two rates, and the gap between them.
         *
         * Receivable was recorded at the rate the day the invoice was raised,
         * so it has to clear at that rate or the debt never fully leaves the
         * balance sheet. The cash that actually arrived is worth what it is
         * worth *today*. When the rate has moved between those two days the
         * two figures differ, and the difference is neither income the
         * business earned nor a cost it chose — it is currency.
         *
         * It goes to the same exchange account the purchase side uses. The
         * sales side had no answer to this at all until now, which meant cash
         * was recorded at a rate it was never received at; the purchase side
         * has done it properly since multi-currency shipped, and two halves of
         * one ledger answering the same question differently is how a business
         * ends up unable to explain its own bank balance.
         */
        const issuedRate = invoice.rateMicro ?? RATE_SCALE;
        const paidRate =
          (await rateOn(orgId, invoice.currency, received)) ?? issuedRate;
        /**
         * Receivable clears by what was actually applied to it, not by the
         * full cash received — an overpayment held as credit never touched
         * this invoice's debt, so it must not appear to clear it.
         */
        const clearedCents = toBaseCents(appliedCents, issuedRate);
        const cashCents = toBaseCents(amountCents, paidRate);
        /**
         * The FX gain or loss is computed off what today's rate makes the
         * *applied* portion worth, not the whole cash amount — the
         * overpaid portion was never valued at the invoice's issued rate to
         * begin with, so there is no drift to record for it. The credit
         * liability below takes whatever is left of `cashCents`, which keeps
         * the entry balanced by construction rather than by a second
         * rounding argument.
         */
        const appliedCashCents = toBaseCents(appliedCents, paidRate);
        const drift = appliedCashCents - clearedCents;
        const overCentsBase = cashCents - appliedCashCents;

        const postings = [
          { accountId: cash, debitCents: cashCents },
          { accountId: ar, creditCents: clearedCents },
          ...(drift !== 0
            ? [
                drift > 0
                  ? // Worth more than the debt: a gain, credited.
                    {
                      accountId: await exchangeAccount(orgId),
                      creditCents: drift,
                    }
                  : // Worth less: a loss, debited.
                    {
                      accountId: await exchangeAccount(orgId),
                      debitCents: -drift,
                    },
              ]
            : []),
          // The overpaid portion: cash the business now holds against this
          // customer's next invoice, not income — a liability until it is
          // spent. See `overpaymentPolicy` above and `customerCredits`.
          ...(overCentsBase !== 0
            ? [
                {
                  accountId: await ensureAccount(
                    orgId,
                    CORE_ACCOUNTS.customerCredits,
                  ),
                  creditCents: overCentsBase,
                },
              ]
            : []),
        ];
        if (takingIt && terms.savingCents > 0) {
          const discounts = await ensureAccount(
            orgId,
            CORE_ACCOUNTS.salesDiscounts,
          );
          const savedCents = toBaseCents(terms.savingCents, issuedRate);
          postings.push({
            accountId: discounts,
            debitCents: savedCents,
          });
          postings.push({ accountId: ar, creditCents: savedCents });
        }
        /*
         * The entry and the subsidiary ledger behind it, together.
         *
         * The credit row says which customer the liability posted above is
         * held for, so a later invoice can offer it back. Written in a commit
         * of its own, a crash between the two leaves the books owing money to
         * nobody in particular, or a customer holding credit the books never
         * heard of.
         */
        await db.transaction(async (tx) => {
          await postJournalEntry(
            orgId,
            takingIt
              ? `Payment for ${invoice.number}, less early-payment discount`
              : `Payment for ${invoice.number}`,
            `payment:${payment.id}`,
            postings,
            received,
            { tx },
          );
          if (overCentsBase !== 0 && invoice.contactId) {
            await recordCreditMovement(
              {
                organizationId: orgId,
                contactId: invoice.contactId,
                cents: overCentsBase,
                paymentId: payment.id,
                invoiceId: invoice.id,
                reason: `Overpayment on invoice ${invoice.number}`,
              },
              { tx },
            );
          }
        });

        await sendReceipt(
          orgId,
          invoice,
          amountCents,
          balanceDue,
          c.req.url,
          !ctx.entitled({ tier: "pro" }),
        );

        return c.json(
          { payment, status, balanceDue, creditGrantedCents: overCents },
          201,
        );
      },
    );

    /**
     * Spending a customer's held credit against a later invoice.
     *
     * Offered, not automatic: applying it is a click a business makes, not
     * something that happens to an invoice the moment it is raised. A
     * business may want to ask the customer first, or hold the credit for a
     * different invoice entirely — automatic application takes that choice
     * away the moment the credit exists.
     *
     * Applies as much as covers the balance or empties the credit, whichever
     * is less — no partial-amount form, the way a "paid in full" shortcut
     * already works on the payments box.
     */
    ctx.app.post(
      "/api/invoices/:id/apply-credit",
      requireSession(),
      requirePermission({ invoicing: ["update"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const invoiceId = c.req.param("id");
        const [invoice] = await db
          .select()
          .from(schema.invoices)
          .where(
            and(
              eq(schema.invoices.id, invoiceId),
              eq(schema.invoices.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!invoice) return c.json({ error: "not found" }, 404);
        if (!invoice.contactId) {
          return c.json(
            { error: "this invoice has no customer to hold credit for" },
            400,
          );
        }

        /*
         * ponytail: credit is tracked in the organization's base currency
         * (see `@sentrello/db/customer-credit`); applying it against an
         * invoice raised in a different currency would need a second FX
         * decision on top of the one already made when the credit was
         * granted, so it is refused here rather than guessed at. Upgrade
         * path: convert at today's rate if a business asks for this.
         */
        const base = await baseCurrency(orgId);
        if (invoice.currency !== base) {
          return c.json(
            {
              error: `credit is held in ${base} and cannot be applied to an invoice in ${invoice.currency}`,
            },
            400,
          );
        }

        const paid = await db
          .select({ amountCents: schema.payments.amountCents })
          .from(schema.payments)
          .where(
            and(
              eq(schema.payments.invoiceId, invoiceId),
              eq(schema.payments.organizationId, orgId),
            ),
          );
        const paidCents = paid.reduce((s, p) => s + p.amountCents, 0);
        const creditedCents =
          (await creditedAgainst(orgId, [invoiceId])).get(invoiceId) ?? 0;
        const owed = Math.max(
          0,
          invoice.totalCents -
            invoice.earlyDiscountTakenCents -
            paidCents -
            creditedCents,
        );
        if (owed <= 0) {
          return c.json({ error: "nothing is owed on this invoice" }, 400);
        }

        const available = await creditBalanceFor(orgId, invoice.contactId);
        if (available <= 0) {
          return c.json(
            { error: "this customer has no credit available" },
            400,
          );
        }

        const applied = Math.min(available, owed);
        const { status, balanceDue } = invoiceStatus(
          invoice.totalCents - invoice.earlyDiscountTakenCents,
          paidCents + applied,
          creditedCents,
        );

        // Before the transaction: creating an account is a write of its own,
        // on its own connection, and it would sit behind the locks this
        // transaction is about to take.
        const [ar, liability] = await Promise.all([
          ensureAccount(orgId, CORE_ACCOUNTS.accountsReceivable),
          ensureAccount(orgId, CORE_ACCOUNTS.customerCredits),
        ]);

        /*
         * Four writes that are one event, so they commit as one.
         *
         * Spending a credit is a payment recorded, the credit drawn down, the
         * invoice's status recomputed and the entry that moves a liability
         * into a settled receivable. Any of those alone is a business whose
         * credit ledger and whose books disagree — and the disagreement is
         * money, so nothing notices until somebody asks for theirs back.
         */
        const payment = await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(schema.payments)
            .values({
              organizationId: orgId,
              invoiceId,
              amountCents: applied,
              method: "credit",
              receivedAt: new Date(),
            })
            .returning();
          if (!row) throw new Error("payment insert returned no row");

          await recordCreditMovement(
            {
              organizationId: orgId,
              contactId: invoice.contactId as string,
              cents: -applied,
              paymentId: row.id,
              invoiceId: invoice.id,
              reason: `Applied to invoice ${invoice.number}`,
            },
            { tx },
          );

          await tx
            .update(schema.invoices)
            .set({ status })
            .where(eq(schema.invoices.id, invoiceId));

          // No cash moves and no FX applies: this reclassifies a liability the
          // business already owed the customer into a receivable it no longer
          // owes them for — one balanced entry, nothing new comes in.
          await postJournalEntry(
            orgId,
            `Credit applied to ${invoice.number}`,
            `payment:${row.id}`,
            [
              { accountId: liability, debitCents: applied },
              { accountId: ar, creditCents: applied },
            ],
            row.receivedAt,
            { tx },
          );
          return row;
        });

        return c.json({ payment, status, balanceDue, appliedCents: applied });
      },
    );

    ctx.app.post(
      "/api/quotes/:id/send",
      requireSession(),
      requirePermission({ invoicing: ["send"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const [quote] = await db
          .select()
          .from(schema.quotes)
          .where(
            and(
              eq(schema.quotes.id, c.req.param("id")),
              eq(schema.quotes.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!quote) return c.json({ error: "not found" }, 404);
        // Same refusal as the invoice: a quote flipped to "sent" through a
        // no-op mailer is a quote the customer was never shown.
        if (!mailConfigured()) {
          return c.json(
            {
              error:
                "no mail server is connected — connect one under Settings → Connections",
            },
            400,
          );
        }
        if (!quote.contactId) {
          return c.json({ error: "this quote has no customer" }, 400);
        }

        const [contact] = await db
          .select()
          .from(schema.contacts)
          // Org-filtered even though the write path now checks: a row written
          // before that check must not mail another business's customer.
          .where(
            and(
              eq(schema.contacts.id, quote.contactId),
              eq(schema.contacts.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!contact?.email) {
          return c.json({ error: "that customer has no email address" }, 400);
        }

        const token = await ensurePortalToken(contact);
        const base =
          process.env.SENTRELLO_BASE_URL ?? new URL(c.req.url).origin;
        const [org] = await db
          .select({ name: schema.organizations.name })
          .from(schema.organizations)
          .where(eq(schema.organizations.id, orgId))
          .limit(1);

        try {
          await emailAdapter().send({
            to: contact.email,
            ...quoteEmail({
              number: quote.number,
              totalCents: quote.totalCents,
              currency: quote.currency,
              businessName: org?.name,
              business: await businessIdentity(orgId),
              sentrelloCredit: !ctx.entitled({ tier: "pro" }),
              portalUrl: `${base}/portal/${token}`,
            }),
          });
        } catch (err) {
          console.error("[invoicing] sending the quote failed", err);
          return c.json({ error: "could not send it" }, 502);
        }

        // Only now: a quote the customer can see is one that actually went.
        const [updated] = await db
          .update(schema.quotes)
          .set({ status: "sent" })
          .where(eq(schema.quotes.id, quote.id))
          .returning();

        await db.insert(schema.activities).values({
          organizationId: orgId,
          contactId: contact.id,
          type: "note",
          body: `Sent quote ${quote.number} to ${contact.email}`,
          occurredAt: new Date(),
        });

        return c.json({ quote: updated, sent: true, to: contact.email });
      },
    );

    ctx.app.post(
      "/api/quotes",
      requireSession(),
      requirePermission({ invoicing: ["create"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const body = (await c.req.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        const { contactId, currency, validUntil } = body as {
          contactId?: string;
          currency?: string;
          validUntil?: string;
        };

        // Same rule as an invoice: a named customer has to be one of ours.
        if (contactId && !(await ownedContact(orgId, contactId))) {
          return c.json({ error: "no such customer" }, 404);
        }

        // The same path an invoice takes. A quote is the same document before
        // it is owed, and two sets of arithmetic is two answers.
        const pricesIncludeTax = await quotesGross(orgId);
        let prepared: Awaited<ReturnType<typeof prepareDocument>>;
        try {
          prepared = await prepareDocument(
            orgId,
            (body.lines ?? []) as IncomingLine[],
            parseDiscount(body),
            pricesIncludeTax,
          );
        } catch (err) {
          if (err instanceof MoneyError) {
            return c.json({ error: err.message }, 400);
          }
          throw err;
        }

        const quote = await db.transaction(async (tx) => {
          const [q] = await tx
            .insert(schema.quotes)
            .values({
              organizationId: orgId,
              contactId,
              currency,
              number: await nextDocumentNumber(tx, orgId, "quote"),
              validUntil: validUntil ? new Date(validUntil) : null,
              pricesIncludeTax,
              notes: String(body.notes ?? "").trim() || null,
              templateId: await ownedTemplateId(orgId, body.templateId),
              discountType:
                (body.discountType as string) === "percent" ||
                (body.discountType as string) === "amount"
                  ? (body.discountType as string)
                  : null,
              discountValue: Number.isInteger(body.discountValue)
                ? (body.discountValue as number)
                : 0,
              discountCents: prepared.discountCents,
              subtotalCents: prepared.subtotalCents,
              taxCents: prepared.taxCents,
              totalCents: prepared.totalCents,
            })
            .returning();
          if (!q) throw new Error("quote insert returned no row");

          await tx
            .insert(schema.quoteLines)
            .values(prepared.lines.map((l) => ({ quoteId: q.id, ...l })));
          await writeTaxBands(tx, orgId, "quote", q.id, prepared.bands);
          return q;
        });

        return c.json({ quote }, 201);
      },
    );

    /**
     * A deal becomes a quote.
     *
     * The step a business actually takes: somebody agrees the work is worth
     * having, and the next thing they send is a price. Doing it by hand means
     * retyping the customer, the description and the figure — three chances to
     * send a quote that does not match what was discussed.
     *
     * Registered by Invoicing rather than the CRM even though the URL names a
     * deal. Raising a quote correctly means the document numbering, the tax
     * bands and the line arithmetic, all of which live here; a second
     * implementation in the CRM would be a second set of answers about money.
     *
     * One line, from the deal's own name and value. Not an attempt to guess a
     * breakdown the deal does not hold — the quote opens in the editor
     * afterwards, and a business that wants three lines writes three lines.
     */
    ctx.app.post(
      "/api/deals/:id/quote",
      requireSession(),
      requirePermission({ invoicing: ["create"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));

        const [deal] = await db
          .select()
          .from(schema.deals)
          .where(
            and(
              eq(schema.deals.id, c.req.param("id")),
              eq(schema.deals.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!deal) return c.json({ error: "not found" }, 404);

        /**
         * Who it is for. A deal can name several people and a company; a quote
         * goes to one person, so the first named contact is used and the
         * company is left to the letterhead.
         *
         * A deal with nobody on it is refused rather than quoted to nobody: a
         * quote with no customer cannot be sent, shared or converted, and
         * finding that out after it is raised is worse than being told now.
         */
        const contactId = (deal.contactIds ?? [])[0];
        if (!contactId) {
          return c.json(
            {
              error:
                "This deal has nobody on it. Add the contact it is for, then quote it.",
              field: "contactIds",
            },
            400,
          );
        }

        const pricesIncludeTax = await quotesGross(orgId);
        let prepared: Awaited<ReturnType<typeof prepareDocument>>;
        try {
          prepared = await prepareDocument(
            orgId,
            [
              {
                description: deal.name,
                quantity: 1,
                unitPriceCents: deal.amountCents,
              },
            ] as IncomingLine[],
            parseDiscount({}),
            pricesIncludeTax,
          );
        } catch (err) {
          if (err instanceof MoneyError) {
            return c.json({ error: err.message }, 400);
          }
          throw err;
        }

        const quote = await db.transaction(async (tx) => {
          const [q] = await tx
            .insert(schema.quotes)
            .values({
              organizationId: orgId,
              contactId,
              dealId: deal.id,
              number: await nextDocumentNumber(tx, orgId, "quote"),
              pricesIncludeTax,
              notes: deal.description,
              subtotalCents: prepared.subtotalCents,
              discountCents: prepared.discountCents,
              taxCents: prepared.taxCents,
              totalCents: prepared.totalCents,
            })
            .returning();
          if (!q) throw new Error("quote insert returned no row");

          await tx
            .insert(schema.quoteLines)
            .values(prepared.lines.map((l) => ({ quoteId: q.id, ...l })));
          await writeTaxBands(tx, orgId, "quote", q.id, prepared.bands);
          return q;
        });

        return c.json({ quote }, 201);
      },
    );

    /**
     * Changing an invoice that has not been issued yet.
     *
     * The Edit action on a draft has existed in the menu since the screen was
     * written and did nothing: the form was handed an id, ignored it, opened
     * blank under the heading "Edit invoice", and saving raised a *second*
     * invoice. This is the endpoint it should always have called.
     *
     * **Drafts only.** Issuing posts a balanced journal entry; changing the
     * lines afterwards would leave the books describing a document that no
     * longer says that. The instrument for a mistake on an issued invoice is a
     * credit note, which this module already has.
     */
    ctx.app.patch(
      "/api/invoices/:id",
      requireSession(),
      requirePermission({ invoicing: ["update"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const id = c.req.param("id");
        const [invoice] = await db
          .select()
          .from(schema.invoices)
          .where(
            and(
              eq(schema.invoices.id, id),
              eq(schema.invoices.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!invoice) return c.json({ error: "not found" }, 404);
        if (invoice.status !== "draft") {
          return c.json(
            {
              error:
                "This invoice has been issued and is in the books. Raise a credit note rather than changing it.",
            },
            409,
          );
        }

        const body = (await c.req.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;

        // Same rule as creation: a reassigned customer has to be one of ours.
        if (
          typeof body.contactId === "string" &&
          !(await ownedContact(orgId, body.contactId))
        ) {
          return c.json({ error: "no such customer" }, 404);
        }

        /**
         * The certificate on a draft, changed or cleared.
         *
         * Same validation as creation, against the draft's own issue date and
         * its (possibly reassigned) customer. Setting one re-prices the
         * document exempt — from the lines being saved, or from the stored
         * ones when only the certificate changed — and an explicit null takes
         * the claim off without touching the lines, which the person is then
         * editing themselves.
         */
        let exemptionCertificateId: string | null | undefined;
        if (body.exemptionCertificateId !== undefined) {
          try {
            exemptionCertificateId = await exemptionForInvoice(
              orgId,
              typeof body.contactId === "string"
                ? body.contactId
                : invoice.contactId,
              body.exemptionCertificateId,
              invoice.issueDate,
            );
          } catch (err) {
            if (err instanceof ExemptionError) {
              return c.json({ error: err.message }, 422);
            }
            throw err;
          }
        }

        let incomingLines: IncomingLine[] | null = Array.isArray(body.lines)
          ? (body.lines as IncomingLine[])
          : null;
        if (exemptionCertificateId && !incomingLines) {
          const stored = await db
            .select()
            .from(schema.invoiceLines)
            .where(eq(schema.invoiceLines.invoiceId, id))
            .orderBy(schema.invoiceLines.sortOrder);
          incomingLines = stored.map((l) => ({
            billableItemId: l.billableItemId,
            description: l.description,
            quantityMilli: l.quantityMilli,
            unitPriceCents: l.unitPriceCents,
            unit: l.unit,
          }));
        }

        let prepared: Awaited<ReturnType<typeof prepareDocument>> | null = null;
        if (incomingLines) {
          try {
            prepared = await prepareDocument(
              orgId,
              exemptionCertificateId
                ? exemptLines(
                    incomingLines,
                    await ensureExemptDefinition(orgId),
                  )
                : incomingLines,
              parseDiscount(body),
              // The document's own answer, not the business's current setting:
              // a draft raised while quoting net stays net even if the setting
              // has been flipped since, or its total would change under it.
              invoice.pricesIncludeTax,
            );
          } catch (err) {
            if (err instanceof MoneyError) {
              return c.json({ error: err.message }, 400);
            }
            throw err;
          }
        }

        const updated = await db.transaction(async (tx) => {
          const values: Record<string, unknown> = { updatedAt: new Date() };
          if (typeof body.contactId === "string") {
            values.contactId = body.contactId;
          }
          if (body.notes !== undefined) {
            values.notes = String(body.notes ?? "").trim() || null;
          }
          if (body.dueDate !== undefined) {
            values.dueDate = body.dueDate
              ? new Date(String(body.dueDate))
              : null;
          }
          if (body.paymentTerms !== undefined) {
            values.paymentTerms =
              String(body.paymentTerms ?? "").trim() || null;
          }
          if (body.buyerReference !== undefined) {
            values.buyerReference =
              String(body.buyerReference ?? "").trim() || null;
          }
          if (typeof body.templateId === "string") {
            values.templateId = await ownedTemplateId(orgId, body.templateId);
          }
          if (exemptionCertificateId !== undefined) {
            values.exemptionCertificateId = exemptionCertificateId;
          }
          if (prepared) {
            values.discountType =
              body.discountType === "percent" || body.discountType === "amount"
                ? body.discountType
                : null;
            values.discountValue = Number.isInteger(body.discountValue)
              ? body.discountValue
              : 0;
            values.discountCents = prepared.discountCents;
            values.subtotalCents = prepared.subtotalCents;
            values.taxCents = prepared.taxCents;
            values.totalCents = prepared.totalCents;
          }

          const [saved] = await tx
            .update(schema.invoices)
            .set(values)
            .where(eq(schema.invoices.id, id))
            .returning();

          if (prepared) {
            await tx
              .delete(schema.invoiceLines)
              .where(eq(schema.invoiceLines.invoiceId, id));
            await tx
              .insert(schema.invoiceLines)
              .values(prepared.lines.map((l) => ({ invoiceId: id, ...l })));
            await tx
              .delete(schema.documentTaxes)
              .where(
                and(
                  eq(schema.documentTaxes.documentType, "invoice"),
                  eq(schema.documentTaxes.documentId, id),
                ),
              );
            await writeTaxBands(tx, orgId, "invoice", id, prepared.bands);
          }
          return saved;
        });

        return c.json({ invoice: updated });
      },
    );

    /**
     * One quote, with its lines — so a screen can show it and an editor can
     * load it.
     *
     * There was no way to read a single quote at all. The list rendered every
     * field it showed, the number beside each row was styled as a link and did
     * nothing, and a quote once raised could not be looked at, let alone
     * changed.
     */
    ctx.app.get(
      "/api/quotes/:id",
      requireSession(),
      requirePermission({ invoicing: ["read"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const [quote] = await db
          .select()
          .from(schema.quotes)
          .where(
            and(
              eq(schema.quotes.id, c.req.param("id")),
              eq(schema.quotes.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!quote) return c.json({ error: "not found" }, 404);

        const [lines, bands, contact] = await Promise.all([
          db
            .select()
            .from(schema.quoteLines)
            .where(eq(schema.quoteLines.quoteId, quote.id))
            .orderBy(schema.quoteLines.sortOrder),
          // Banded as it was when the quote was written, not recomputed: a
          // rate that changed since must not change the price somebody was
          // given.
          db
            .select()
            .from(schema.documentTaxes)
            .where(
              and(
                eq(schema.documentTaxes.documentType, "quote"),
                eq(schema.documentTaxes.documentId, quote.id),
              ),
            ),
          quote.contactId
            ? db
                .select({
                  id: schema.contacts.id,
                  name: schema.contacts.name,
                  email: schema.contacts.email,
                })
                .from(schema.contacts)
                // Org-filtered even though the write path now checks: a row
                // written before that check must not read another business's
                // customer out.
                .where(
                  and(
                    eq(schema.contacts.id, quote.contactId),
                    eq(schema.contacts.organizationId, orgId),
                  ),
                )
                .limit(1)
            : Promise.resolve([]),
        ]);

        return c.json({ quote, lines, bands, contact: contact[0] ?? null });
      },
    );

    /**
     * Changing a quote after it was raised.
     *
     * The thing a business does when a customer says "drop the second unit" —
     * and until now the only answer was to delete it and start again, which
     * loses the number, the share link and whatever the customer had already
     * been sent.
     *
     * **Refused once it has become an invoice.** The invoice's lines were
     * copied from these; editing them afterwards would leave two documents
     * disagreeing about what was agreed, and the invoice is the one that
     * posted to the ledger. A sent quote is still editable, because revising
     * and re-sending is exactly what negotiation is.
     *
     * Totals are recomputed through `prepareDocument`, the same path that
     * created it, so a quote cannot be edited into disagreeing with the sum of
     * its own lines.
     */
    ctx.app.patch(
      "/api/quotes/:id",
      requireSession(),
      requirePermission({ invoicing: ["update"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const id = c.req.param("id");
        const [quote] = await db
          .select()
          .from(schema.quotes)
          .where(
            and(
              eq(schema.quotes.id, id),
              eq(schema.quotes.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!quote) return c.json({ error: "not found" }, 404);
        if (quote.convertedInvoiceId) {
          return c.json(
            {
              error:
                "This quote has become an invoice. Change the invoice, or credit it and raise a new quote.",
            },
            409,
          );
        }

        const body = (await c.req.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;

        let prepared: Awaited<ReturnType<typeof prepareDocument>> | null = null;
        if (Array.isArray(body.lines)) {
          try {
            prepared = await prepareDocument(
              orgId,
              body.lines as IncomingLine[],
              parseDiscount(body),
              // The quote's own answer — see the invoice patch above.
              quote.pricesIncludeTax,
            );
          } catch (err) {
            if (err instanceof MoneyError) {
              return c.json({ error: err.message }, 400);
            }
            throw err;
          }
        }

        // Same rule as creation: a reassigned customer has to be one of ours.
        if (
          typeof body.contactId === "string" &&
          !(await ownedContact(orgId, body.contactId))
        ) {
          return c.json({ error: "no such customer" }, 404);
        }

        const updated = await db.transaction(async (tx) => {
          const values: Record<string, unknown> = { updatedAt: new Date() };
          if (typeof body.contactId === "string") {
            values.contactId = body.contactId;
          }
          if (body.notes !== undefined) {
            values.notes = String(body.notes ?? "").trim() || null;
          }
          if (body.validUntil !== undefined) {
            values.validUntil = body.validUntil
              ? new Date(String(body.validUntil))
              : null;
          }
          if (typeof body.templateId === "string") {
            values.templateId = await ownedTemplateId(orgId, body.templateId);
          }
          if (prepared) {
            values.discountType =
              body.discountType === "percent" || body.discountType === "amount"
                ? body.discountType
                : null;
            values.discountValue = Number.isInteger(body.discountValue)
              ? body.discountValue
              : 0;
            values.discountCents = prepared.discountCents;
            values.subtotalCents = prepared.subtotalCents;
            values.taxCents = prepared.taxCents;
            values.totalCents = prepared.totalCents;
          }

          const [saved] = await tx
            .update(schema.quotes)
            .set(values)
            .where(eq(schema.quotes.id, id))
            .returning();

          if (prepared) {
            // Replaced rather than merged: working out which line the browser
            // meant to change is a second source of truth about the document.
            await tx
              .delete(schema.quoteLines)
              .where(eq(schema.quoteLines.quoteId, id));
            await tx
              .insert(schema.quoteLines)
              .values(prepared.lines.map((l) => ({ quoteId: id, ...l })));
            await tx
              .delete(schema.documentTaxes)
              .where(
                and(
                  eq(schema.documentTaxes.documentType, "quote"),
                  eq(schema.documentTaxes.documentId, id),
                ),
              );
            await writeTaxBands(tx, orgId, "quote", id, prepared.bands);
          }
          return saved;
        });

        return c.json({ quote: updated });
      },
    );

    // Convert a quote to an invoice: copies the lines and links quoteId.
    ctx.app.post(
      "/api/quotes/:id/convert",
      requireSession(),
      requirePermission({ invoicing: ["create"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));

        /**
         * One invoice, or the schedule that was agreed with the quote.
         *
         * A deposit and two stages is an ordinary arrangement, and the
         * alternative a business has is raising the deposit by hand and
         * remembering the rest — which is how a stage goes unbilled.
         */
        const body = (await c.req.json().catch(() => ({}))) as {
          instalments?: unknown;
        };
        if (Array.isArray(body.instalments) && body.instalments.length > 0) {
          const plan = body.instalments.map((part) => {
            const one = (part ?? {}) as Record<string, unknown>;
            return {
              shareBp: Number(one.shareBp),
              dueInDays: Number(one.dueInDays) || 0,
              label: one.label ? String(one.label) : undefined,
            };
          });
          const result = await convertQuoteToInstalments(
            orgId,
            c.req.param("id"),
            plan,
          );
          if ("error" in result) {
            return c.json(
              { error: result.error },
              result.error === "not found" ? 404 : 400,
            );
          }
          return c.json({ invoices: result.invoices }, 201);
        }

        const invoice = await convertQuoteToInvoice(
          orgId,
          c.req.param("id"),
        ).catch((err: unknown) => {
          // A quote in a currency this business has never priced. Declined
          // with the reason, the way the instalment plan beside it is.
          if (err instanceof MoneyError) return err;
          throw err;
        });
        if (invoice instanceof MoneyError) {
          return c.json({ error: invoice.message }, 400);
        }
        if (invoice) return c.json({ invoice }, 201);

        /**
         * Null means one of two things, and they need different answers.
         *
         * A second query, but only on the way to an error: "not found" for a
         * quote that has already been invoiced is the sort of message that
         * has somebody raising a duplicate by hand because they think the
         * button is broken.
         */
        const [quote] = await db
          .select({ convertedInvoiceId: schema.quotes.convertedInvoiceId })
          .from(schema.quotes)
          .where(
            and(
              eq(schema.quotes.id, c.req.param("id")),
              eq(schema.quotes.organizationId, orgId),
            ),
          )
          .limit(1);

        if (quote?.convertedInvoiceId) {
          return c.json(
            {
              error: "that quote has already been turned into an invoice",
              invoiceId: quote.convertedInvoiceId,
            },
            409,
          );
        }
        return c.json({ error: "not found" }, 404);
      },
    );

    /**
     * Customer portal. The `customer` role only grants invoicing:read, which is
     * NOT enough on its own — RBAC cannot express "only your own rows". The
     * portal user is resolved to their contact record and the query is filtered
     * to that contact, so a customer can never read another customer's invoice.
     */
    /**
     * Mints the link a customer follows to see what they owe.
     *
     * `?rotate=1` reissues it, which is how a business takes a shared link out
     * of circulation.
     */
    ctx.app.post(
      "/api/contacts/:id/portal-link",
      requireSession(),
      requirePermission({ invoicing: ["read"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const [contact] = await db
          .select()
          .from(schema.contacts)
          .where(
            and(
              eq(schema.contacts.id, c.req.param("id")),
              eq(schema.contacts.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!contact) return c.json({ error: "not found" }, 404);

        const token =
          c.req.query("rotate") === "1"
            ? await ensurePortalToken(contact, true)
            : await ensurePortalToken(contact);

        const base =
          process.env.SENTRELLO_BASE_URL ?? new URL(c.req.url).origin;
        const url = `${base}/portal/${token}`;

        // Sending is the point: a link the business has to copy out of a
        // dialog and paste into their own email client is a link that stays
        // in the dialog.
        if (c.req.query("send") === "1") {
          if (!contact.email) {
            return c.json({ error: "this contact has no email address" }, 400);
          }
          // The link exists either way; what must not happen is "sent: true"
          // through a no-op mailer when no mail server is connected.
          if (!mailConfigured()) {
            return c.json(
              {
                url,
                sent: false,
                error:
                  "no mail server is connected — copy the link instead, or connect one under Settings → Connections",
              },
              400,
            );
          }

          const rows = await db
            .select()
            .from(schema.invoices)
            .where(
              and(
                eq(schema.invoices.organizationId, orgId),
                eq(schema.invoices.contactId, contact.id),
              ),
            );
          const paid = await db
            .select({
              invoiceId: schema.payments.invoiceId,
              amountCents: schema.payments.amountCents,
            })
            .from(schema.payments)
            .where(eq(schema.payments.organizationId, orgId));

          const outstandingCents = rows.reduce((sum, invoice) => {
            const settled = paid
              .filter((p) => p.invoiceId === invoice.id)
              .reduce((n, p) => n + p.amountCents, 0);
            return sum + Math.max(0, invoice.totalCents - settled);
          }, 0);

          const [org] = await db
            .select({ name: schema.organizations.name })
            .from(schema.organizations)
            .where(eq(schema.organizations.id, orgId))
            .limit(1);

          try {
            await emailAdapter().send({
              to: contact.email,
              ...portalLinkEmail({
                businessName: org?.name ?? "Your supplier",
                url,
                outstandingCents,
                currency: rows[0]?.currency,
              }),
            });
          } catch (err) {
            // The link exists either way; the business can still copy it.
            console.error("[invoicing] portal link email failed", err);
            return c.json({ url, sent: false }, 502);
          }
          return c.json({ url, sent: true });
        }

        return c.json({ url });
      },
    );

    /**
     * The customer's own page. Unauthenticated by necessity — they have no
     * account — so the token is compared in constant time and a wrong one is
     * a 404, which is what an unknown URL looks like.
     */
    ctx.app.get("/portal/:token", async (c) => {
      // The token is 32 random bytes, so guessing is hopeless — the limit is
      // not against that. It is against a public path that does database work
      // on every hit, on a box that is often the smallest one the customer
      // could rent. Scheduling, the shop and forms all carry one; this did not.
      const limited = rateLimit(
        `portal:${clientIp(c)}`,
        PORTAL_LIMIT,
        PORTAL_WINDOW_MS,
      );
      if (!limited.allowed) {
        return c.text("Too many requests. Try again in a minute.", 429, {
          "retry-after": String(limited.retryAfterSeconds),
        });
      }

      const supplied = c.req.param("token");
      const contact = await contactByPortalToken(supplied);
      if (!contact) return c.notFound();

      /**
       * Only documents the customer was actually sent. A draft is the
       * business thinking out loud, a void was taken back, and a credit
       * note is not a bill — shown as one, it read as "due" and offered a
       * Pay button for money the business owes the customer.
       */
      const rows = await db
        .select()
        .from(schema.invoices)
        .where(
          and(
            eq(schema.invoices.organizationId, contact.organizationId),
            eq(schema.invoices.contactId, contact.id),
            eq(schema.invoices.kind, "invoice"),
            isNull(schema.invoices.deletedAt),
            notInArray(schema.invoices.status, ["draft", "void"]),
          ),
        );
      const rowCredits = await creditedAgainst(
        contact.organizationId,
        rows.map((r) => r.id),
      );

      const paid = await db
        .select({
          invoiceId: schema.payments.invoiceId,
          amountCents: schema.payments.amountCents,
        })
        .from(schema.payments)
        .where(eq(schema.payments.organizationId, contact.organizationId));

      const [org] = await db
        // The whole row: the portal footer needs the address, tax number and
        // payment instructions, not only the name.
        .select()
        .from(schema.organizations)
        .where(eq(schema.organizations.id, contact.organizationId))
        .limit(1);

      const quotes = await db
        .select()
        .from(schema.quotes)
        .where(
          and(
            eq(schema.quotes.organizationId, contact.organizationId),
            eq(schema.quotes.contactId, contact.id),
          ),
        );

      return c.html(
        portalPage({
          businessName: org?.name ?? "Invoices",
          // On a Free instance with no card payments this footer is the only
          // thing telling the customer where to send the money.
          business: {
            name: org?.name ?? "Invoices",
            address: org?.address,
            taxId: org?.taxId,
            taxIdLabel: org?.taxIdLabel,
            paymentInstructions: org?.paymentInstructions,
          },
          customerName: contact.name,
          // The unified account page across every module — same token,
          // already valid, since it is the one that got them onto this page.
          accountPath: `/account/${supplied}`,
          quotes,
          quotePath: `/portal/${supplied}/quotes`,
          // Paying online is a Pro feature; a Free instance shows the bill and
          // leaves the customer to pay however they already do.
          payPath: ctx.entitled({ tier: "pro" })
            ? `/portal/${supplied}/pay`
            : undefined,
          credit: await creditFor(
            contact.organizationId,
            ctx.entitled({ tier: "pro" }),
          ),
          invoices: rows.map((invoice) => ({
            ...invoice,
            paidCents: paid
              .filter((p) => p.invoiceId === invoice.id)
              .reduce((sum, p) => sum + p.amountCents, 0),
            creditedCents: rowCredits.get(invoice.id) ?? 0,
          })),
        }),
        200,
        { "x-robots-tag": "noindex" },
      );
    });

    /**
     * Sending an invoice to the customer.
     *
     * The template existed and nothing called it, so a business could raise an
     * invoice and had no way to deliver it. The email carries the customer's
     * portal link, because an invoice someone has to reply to in order to pay
     * is an invoice that waits.
     */
    /**
     * One invoice, with everything a person needs to answer "where is this?":
     * what was charged, what has been paid, and what is left.
     *
     * The balance is computed from the payments rather than stored, so a row
     * that was hand-edited in the database cannot disagree with itself.
     */
    ctx.app.get(
      "/api/invoices/:id",
      requireSession(),
      requirePermission({ invoicing: ["read"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const [invoice] = await db
          .select()
          .from(schema.invoices)
          .where(
            and(
              eq(schema.invoices.id, c.req.param("id")),
              eq(schema.invoices.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!invoice) return c.json({ error: "not found" }, 404);

        const [lines, payments, bands, contact] = await Promise.all([
          db
            .select()
            .from(schema.invoiceLines)
            .where(eq(schema.invoiceLines.invoiceId, invoice.id))
            .orderBy(schema.invoiceLines.sortOrder),
          db
            .select()
            .from(schema.payments)
            .where(eq(schema.payments.invoiceId, invoice.id))
            .orderBy(schema.payments.receivedAt),
          // The tax as it was banded when the document was issued, not
          // recomputed — a rate that changed afterwards must not change what
          // an invoice already said.
          db
            .select()
            .from(schema.documentTaxes)
            .where(
              and(
                eq(schema.documentTaxes.documentType, "invoice"),
                eq(schema.documentTaxes.documentId, invoice.id),
              ),
            ),
          invoice.contactId
            ? db
                .select({
                  id: schema.contacts.id,
                  name: schema.contacts.name,
                  email: schema.contacts.email,
                })
                .from(schema.contacts)
                // Org-filtered even though the write path now checks: a row
                // written before that check must not read another business's
                // customer out.
                .where(
                  and(
                    eq(schema.contacts.id, invoice.contactId),
                    eq(schema.contacts.organizationId, orgId),
                  ),
                )
                .limit(1)
            : Promise.resolve([]),
        ]);

        const paidCents = payments.reduce((sum, p) => sum + p.amountCents, 0);
        // Credits settle debt the way payments do; a balance that ignored
        // them would show money the customer no longer owes.
        const creditedCents =
          (await creditedAgainst(orgId, [invoice.id])).get(invoice.id) ?? 0;
        // Balance, state and lateness from the one call every customer-facing
        // surface uses — including the early-payment saving, which is debt
        // given up rather than money received. Without it this screen showed a
        // discounted invoice as still owing the saving for ever.
        const { balanceDue, status } = invoiceState(
          invoice,
          paidCents,
          creditedCents,
        );

        return c.json({
          invoice,
          lines,
          payments,
          bands,
          contact: contact[0] ?? null,
          /**
           * The early-payment offer as it stands today.
           *
           * Computed here rather than in the browser so the screen and the
           * route that takes the discount agree about whether the window is
           * open — two clocks and two implementations of "within ten days" is
           * how somebody is offered a saving the server then refuses.
           *
           * The offer could be set on an invoice and never taken: the payment
           * form had no way to say the customer paid early, so a business
           * offering 2/10 net 30 either lost the discount or was short-paid
           * and left showing a balance for ever.
           */
          earlyPayment: earlyPaymentTerms({
            type: invoice.earlyDiscountType,
            value: invoice.earlyDiscountValue,
            days: invoice.earlyDiscountDays,
            issueDate: invoice.issueDate,
            totalCents: invoice.totalCents,
          }),
          earlyDiscountTakenCents: invoice.earlyDiscountTakenCents,
          // The labels on it, so the detail screen can show and change them
          // without a second request per invoice opened.
          tags:
            (await tagsFor(orgId, "invoice", [invoice.id])).get(invoice.id) ??
            [],
          paidCents,
          creditedCents,
          // A draft is not owed: nobody has been asked for it yet, and
          // `invoiceState` already answers zero for a draft and a void.
          balanceDue,
          // What the status is from the payments and credits, which is what
          // every screen shows. Kept under its old name because the detail
          // page reads it; the stored column beside it is the filter key.
          computedStatus: status,
          // What this customer could apply here, offered rather than
          // spent automatically. See "/api/invoices/:id/apply-credit".
          availableCreditCents: invoice.contactId
            ? await creditBalanceFor(orgId, invoice.contactId)
            : 0,
        });
      },
    );

    ctx.app.post(
      "/api/invoices/:id/send",
      requireSession(),
      requirePermission({ invoicing: ["send"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const [invoice] = await db
          .select()
          .from(schema.invoices)
          .where(
            and(
              eq(schema.invoices.id, c.req.param("id")),
              eq(schema.invoices.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!invoice) return c.json({ error: "not found" }, 404);
        // Refused out loud rather than dropped: with no mail server the
        // adapter is a no-op, and "sent" would write a delivery that never
        // happened onto the customer's timeline.
        if (!mailConfigured()) {
          return c.json(
            {
              error:
                "no mail server is connected — connect one under Settings → Connections",
            },
            400,
          );
        }
        if (!invoice.contactId) {
          return c.json({ error: "this invoice has no customer" }, 400);
        }

        const [contact] = await db
          .select()
          .from(schema.contacts)
          // Org-filtered even though the write path now checks: a row written
          // before that check must not mail another business's customer.
          .where(
            and(
              eq(schema.contacts.id, invoice.contactId),
              eq(schema.contacts.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!contact?.email) {
          return c.json({ error: "that customer has no email address" }, 400);
        }

        const token = await ensurePortalToken(contact);
        const base =
          process.env.SENTRELLO_BASE_URL ?? new URL(c.req.url).origin;
        const [org] = await db
          .select({ name: schema.organizations.name })
          .from(schema.organizations)
          .where(eq(schema.organizations.id, orgId))
          .limit(1);

        try {
          await emailAdapter().send({
            to: contact.email,
            ...invoiceEmail({
              number: invoice.number,
              totalCents: invoice.totalCents,
              currency: invoice.currency,
              dueDate: invoice.dueDate,
              businessName: org?.name,
              // The copy the customer keeps: it carries the seller's address
              // and how to pay, as the portal page does.
              business: await businessIdentity(orgId),
              sentrelloCredit: !ctx.entitled({ tier: "pro" }),
              portalUrl: `${base}/portal/${token}`,
            }),
          });
        } catch (err) {
          console.error("[invoicing] sending the invoice failed", err);
          return c.json({ error: "could not send it" }, 502);
        }

        // What was sent, and when, belongs on the customer's timeline: it is
        // the answer to "did we ever actually invoice them?"
        await db.insert(schema.activities).values({
          organizationId: orgId,
          contactId: contact.id,
          type: "note",
          body: `Sent invoice ${invoice.number} to ${contact.email}`,
          occurredAt: new Date(),
        });

        return c.json({ sent: true, to: contact.email });
      },
    );

    /**
     * The customer accepting a quote.
     *
     * This is the one thing a customer can change from their own page, so it
     * is narrow on purpose: only their own quote, only one the business has
     * sent, and only into the invoice the business already priced.
     */
    ctx.app.post("/portal/:token/quotes/:id/accept", async (c) => {
      // The token is 32 random bytes, so guessing is hopeless — the limit is
      // not against that. It is against a public path that does database work
      // on every hit, on a box that is often the smallest one the customer
      // could rent. Scheduling, the shop and forms all carry one; this did not.
      const limited = rateLimit(
        `portal:${clientIp(c)}`,
        PORTAL_LIMIT,
        PORTAL_WINDOW_MS,
      );
      if (!limited.allowed) {
        return c.text("Too many requests. Try again in a minute.", 429, {
          "retry-after": String(limited.retryAfterSeconds),
        });
      }

      const token = c.req.param("token");
      const contact = await contactByPortalToken(token);
      if (!contact) return c.notFound();

      const [quote] = await db
        .select()
        .from(schema.quotes)
        .where(
          and(
            eq(schema.quotes.id, c.req.param("id")),
            eq(schema.quotes.organizationId, contact.organizationId),
            eq(schema.quotes.contactId, contact.id),
          ),
        )
        .limit(1);
      // A quote already answered is not answerable again: accepting twice
      // would raise a second invoice for the same work.
      if (!quote || quote.status !== "sent") return c.notFound();

      /**
       * The shared conversion, not a private copy of it.
       *
       * The copy that used to live here dropped the fractional quantity, the
       * unit, the discount, the tax bands and the line's taxes — so the
       * invoice a customer raised by accepting differed from the one the
       * staff screen would have raised from the same quote. It also never
       * set `convertedInvoiceId`, which is the guard against the same quote
       * becoming two invoices.
       */
      /**
       * A customer accepting in their own portal.
       *
       * The conversion refuses a currency the business has never priced, and
       * that refusal reaches a customer rather than staff — so it is a 400
       * with the reason rather than a stack trace, and the quote stays open
       * for whoever fixes the rate.
       */
      const invoice = await convertQuoteToInvoice(
        contact.organizationId,
        quote.id,
      ).catch((err: unknown) => {
        if (err instanceof MoneyError) return err;
        throw err;
      });
      if (invoice instanceof MoneyError) {
        return c.json({ error: invoice.message }, 400);
      }
      if (!invoice) return c.notFound();

      // The business should find out from its own timeline, not by noticing.
      await db.insert(schema.activities).values({
        organizationId: contact.organizationId,
        contactId: contact.id,
        type: "note",
        body: `Accepted quote ${quote.number} — invoice ${invoice.number} raised`,
        occurredAt: new Date(),
      });

      return c.redirect(`/portal/${token}`, 303);
    });
  },
});
