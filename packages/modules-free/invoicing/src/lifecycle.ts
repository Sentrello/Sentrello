import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, isNull, schema } from "@sentrello/db";
import { copyInvoice } from "@sentrello/db/documents";
import {
  postCreditNoteIssued,
  postInvoiceIssued,
  reverseJournalEntries,
} from "@sentrello/db/ledger";
import { MoneyError, invoiceStatus } from "@sentrello/db/money";
import { nextDocumentNumber } from "@sentrello/db/numbering";
import { dateFrom } from "@sentrello/db/timezone";
import type { ModuleContext } from "@sentrello/module-sdk";
import { creditedAgainst, shareToken, writeTaxBands } from "./documents";
import { ExemptionError, exemptionForInvoice } from "./exemptions";

/**
 * What happens to an invoice after it is written.
 *
 * Issue a draft, copy one, void one, credit one, and give a customer a link to
 * look at it. Kept apart from creating one because these are the operations
 * that have to be careful: each of them either moves money in the books or
 * puts a document in front of somebody outside the business.
 *
 * The rule running through all of it: **an issued document is never edited or
 * erased.** It is superseded — voided, or credited by a second document that
 * says so. A business that can quietly change an invoice it has already sent
 * has no audit trail, and neither does its accountant.
 */

async function invoiceIn(orgId: string, id: string) {
  const [row] = await db
    .select()
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.id, id),
        eq(schema.invoices.organizationId, orgId),
        isNull(schema.invoices.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * The date an invoice is being issued on, or why it will not be accepted.
 *
 * Absent means now, which is what nearly every caller means. A date is read as
 * plain calendar input and anchored at midday UTC, so a business anywhere in
 * the markets this product sells into gets the day it typed rather than the
 * day before it — parsing "2026-06-15" as midnight puts a business in Denver
 * on the fourteenth.
 *
 * Returns an Error rather than throwing so the route can answer 400 with the
 * reason on it, which is the difference between a form somebody can correct
 * and one that appears to be broken.
 */
export function requestedIssueDate(value: unknown): Date | Error {
  if (value === undefined || value === null || value === "") return new Date();
  if (typeof value !== "string") {
    return new Error("the issue date has to be a date");
  }

  /*
   * The 30th of February is not a date, however plainly it is written.
   * `new Date` rolls it to the 2nd of March without complaint, and the issue
   * date is the date this invoice's journal entry is posted under — so a
   * rolled day books the sale into a month nobody chose, and every report
   * after it agrees with itself.
   */
  const plain = /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
  const parsed = dateFrom(
    plain ? `${value.trim()}T12:00:00.000Z` : value.trim(),
  );
  if (!parsed) {
    return new Error("that is not a date we can read");
  }

  // Revenue that has not happened yet would sit in every report downstream —
  // the income chart, the profit and loss, the tax summary — as money the
  // business does not have.
  if (parsed.getTime() > Date.now()) {
    return new Error("an invoice cannot be issued with a date in the future");
  }

  return parsed;
}

export function registerLifecycle(ctx: ModuleContext) {
  /**
   * Issuing a draft.
   *
   * The moment it becomes an accounting event: the journal entry is posted
   * here rather than when the draft was written, so the books only ever carry
   * documents that were actually raised.
   *
   * The date is optional and almost always absent — somebody raising today's
   * invoice today. It exists for the business adopting Sentrello halfway
   * through its year, which has a back catalogue to load and needs June's
   * revenue in June. The date governs both the document and the journal entry,
   * because an invoice whose books disagree with its own face is worse than
   * one that was never loaded.
   *
   * A date inside a closed accounting period is refused, and not here: the
   * lock lives in `postJournalEntry`, so it binds every module that touches
   * money rather than the one caller that prompted it. Off until a business
   * closes a period, which is Accounting → Tax and currency.
   */
  ctx.app.post(
    "/api/invoices/:id/issue",
    requireSession(),
    requirePermission({ invoicing: ["update"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const invoice = await invoiceIn(orgId, c.req.param("id"));
      if (!invoice) return c.json({ error: "not found" }, 404);
      if (invoice.status !== "draft") {
        return c.json({ error: "that invoice has already been issued" }, 409);
      }

      const body = (await c.req.json().catch(() => ({}))) as {
        issueDate?: unknown;
      };
      const issuedOn = requestedIssueDate(body.issueDate);
      if (issuedOn instanceof Error) {
        return c.json({ error: issuedOn.message }, 400);
      }

      /**
       * A draft written under an exemption certificate is re-checked on the
       * day it actually becomes a sale. The certificate may have expired or
       * been revoked while the draft sat — and an expired certificate that
       * quietly kept exempting is the under-collection a business only
       * discovers at an audit, with penalties attached.
       */
      if (invoice.exemptionCertificateId) {
        try {
          await exemptionForInvoice(
            orgId,
            invoice.contactId,
            invoice.exemptionCertificateId,
            issuedOn,
          );
        } catch (err) {
          if (err instanceof ExemptionError) {
            return c.json({ error: err.message }, 422);
          }
          throw err;
        }
      }

      /**
       * Issued and posted in one commit, or neither.
       *
       * The status was written first and the entry posted afterwards, and the
       * gap is reachable by the very feature this route advertises: posting
       * refuses a date inside a closed period, so issuing a back-dated
       * invoice into a closed month left the document reading `open` — a debt
       * on every aging report, chased by the reminder sweep — with no entry
       * behind it at all.
       *
       * The posting itself is the one shared function, used by the create
       * route and the recurring job too. The copy that used to live here
       * credited income with subtotal-less-discount and ignored the exchange
       * rate entirely, so a euro invoice put euro cents into dollar books.
       */
      const issued = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(schema.invoices)
          .set({ status: "open", issueDate: issuedOn, updatedAt: new Date() })
          .where(eq(schema.invoices.id, invoice.id))
          .returning();
        if (!row) throw new Error("issue returned no row");
        await postInvoiceIssued(orgId, row, undefined, issuedOn, { tx });
        return row;
      });

      return c.json({ invoice: issued });
    },
  );

  /**
   * Copying an invoice.
   *
   * The most-used button in every invoicing product, because most businesses
   * bill the same thing repeatedly. The copy is always a draft with a new
   * number and today's date — copying the status too would post a journal
   * entry for a document nobody has looked at.
   */
  ctx.app.post(
    "/api/invoices/:id/duplicate",
    requireSession(),
    requirePermission({ invoicing: ["create"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      // Copying is shared with the recurring job, which raises this period's
      // invoice from a template one the same way. A copy that drops a field
      // asks the customer for a different amount than the document it came
      // from, and two implementations drop different fields.
      try {
        const copy = await copyInvoice(orgId, c.req.param("id"), {
          status: "draft",
          issueDate: new Date(),
        });
        if (!copy) return c.json({ error: "not found" }, 404);

        return c.json({ invoice: copy }, 201);
      } catch (err) {
        /*
         * A refusal, not a failure. Copying is declined when the currency has
         * never been priced and when the document is a credit note, and both
         * are things the person pressing the button can act on — a 500 with a
         * stack trace tells them only that the product is broken.
         */
        if (err instanceof MoneyError) {
          return c.json({ error: err.message }, 400);
        }
        throw err;
      }
    },
  );

  /**
   * Voiding an invoice that should never have been raised.
   *
   * Reversed in the books rather than deleted from them: the number stays
   * used, the document stays readable, and the ledger carries an equal and
   * opposite entry. A gap in an invoice sequence is the first thing an auditor
   * asks about.
   *
   * Refused once anything has been paid against it — that is a credit note,
   * because money actually moved and pretending otherwise loses it.
   */
  ctx.app.post(
    "/api/invoices/:id/void",
    requireSession(),
    requirePermission({ invoicing: ["update"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const invoice = await invoiceIn(orgId, c.req.param("id"));
      if (!invoice) return c.json({ error: "not found" }, 404);
      if (invoice.status === "void") {
        return c.json({ error: "that invoice is already void" }, 409);
      }

      const paid = await db
        .select({ amountCents: schema.payments.amountCents })
        .from(schema.payments)
        .where(eq(schema.payments.invoiceId, invoice.id));
      if (paid.length > 0) {
        return c.json(
          {
            error:
              "money has been paid against this invoice; raise a credit note instead",
          },
          409,
        );
      }

      // Refused once a credit note stands against it, for the mirror-image
      // reason: the note already reversed the sale in the books, and the
      // void's reversal on top would take the income out twice.
      const credited =
        (await creditedAgainst(orgId, [invoice.id])).get(invoice.id) ?? 0;
      if (credited > 0) {
        return c.json(
          {
            error:
              "credit notes stand against this invoice; the books already carry their reversal",
          },
          409,
        );
      }

      const [voided] = await db
        .update(schema.invoices)
        .set({ status: "void", updatedAt: new Date() })
        .where(eq(schema.invoices.id, invoice.id))
        .returning();

      // A draft was never in the books, so there is nothing to reverse.
      //
      // The reversal is the issued entry with its sides swapped, line for
      // line, rather than an entry rebuilt from the invoice's figures. The
      // rebuilt one had two ways to disagree with what it was undoing: it
      // posted face-value cents whatever currency the document was in, and it
      // debited one tax account when the issue may have credited several —
      // leaving every account touched still carrying a balance the void was
      // supposed to remove.
      if (invoice.status !== "draft") {
        await reverseJournalEntries(
          orgId,
          `invoice:${invoice.id}`,
          `Void invoice ${invoice.number}`,
        );
      }

      return c.json({ invoice: voided });
    },
  );

  /**
   * Crediting an invoice that was paid, or partly paid.
   *
   * A second document rather than an edit to the first: both stay on the
   * record, the customer can see what was charged and what was given back, and
   * the ledger carries both movements. This is what a business does when a
   * void is no longer honest.
   */
  ctx.app.post(
    "/api/invoices/:id/credit",
    requireSession(),
    requirePermission({ invoicing: ["create"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const source = await invoiceIn(orgId, c.req.param("id"));
      if (!source) return c.json({ error: "not found" }, 404);
      if (source.kind === "credit_note") {
        return c.json({ error: "a credit note cannot be credited" }, 409);
      }
      /**
       * The mirror of the refusal the void route already makes.
       *
       * Void refuses once a credit note stands against an invoice, because the
       * note has already reversed the sale and a void's reversal on top would
       * take the income out twice. The same is true the other way round and
       * nothing said so: crediting an invoice that had been voided posted a
       * second reversal of a sale already reversed, and crediting a draft took
       * revenue out of the books that had never been put in.
       */
      if (source.status === "void" || source.status === "draft") {
        return c.json(
          {
            error:
              source.status === "void"
                ? "this invoice is void; the books already carry its reversal"
                : "this invoice is still a draft — it is not in the books, so there is nothing to credit",
          },
          409,
        );
      }

      const body = (await c.req.json().catch(() => ({}))) as {
        amountCents?: unknown;
        reason?: unknown;
      };
      const requested = body.amountCents ?? source.totalCents;
      if (
        !Number.isInteger(requested) ||
        (requested as number) <= 0 ||
        (requested as number) > source.totalCents
      ) {
        // More than the invoice is not a credit, it is a payment to the
        // customer, and it belongs somewhere a business can see it.
        return c.json(
          { error: "a credit note is between one cent and the invoice total" },
          400,
        );
      }
      const amount = requested as number;

      /**
       * The cap is cumulative, not per note. Each note alone stayed under
       * the total, so two full-value credits both passed and an invoice
       * could be credited for twice what it was ever worth — money invented
       * out of a button pressed twice.
       */
      const already =
        (await creditedAgainst(orgId, [source.id])).get(source.id) ?? 0;
      if (already + amount > source.totalCents) {
        return c.json(
          {
            error:
              "credit notes against this invoice would then exceed its total; only what is left of the invoice can still be credited",
          },
          400,
        );
      }

      /**
       * The tax on what is being given back, band by band, in proportion.
       *
       * Read from the bands frozen onto the sale rather than recomputed from
       * rates, so the credit unwinds what was actually charged — including a
       * rate that has been renamed or retired since. Each band's share is
       * rounded on its own, the same per-tax rounding decision recorded in
       * `documentTotals`, and the net takes the remainder: the note still
       * credits exactly the amount asked for, and the entry it posts still
       * balances to the cent. An exempt or zero-rated sale has no tax in its
       * bands, so its credit invents none.
       */
      const sourceBands = await db
        .select()
        .from(schema.documentTaxes)
        .where(
          and(
            eq(schema.documentTaxes.organizationId, orgId),
            eq(schema.documentTaxes.documentType, "invoice"),
            eq(schema.documentTaxes.documentId, source.id),
          ),
        );
      const bands = sourceBands
        .map((band) => ({
          taxDefinitionId: band.taxDefinitionId,
          name: band.name,
          rateBp: band.rateBp,
          ratePpm: band.ratePpm ?? band.rateBp * 100,
          categoryCode: band.categoryCode,
          taxableCents: Math.round(
            (band.taxableCents * amount) / source.totalCents,
          ),
          taxCents: Math.round((band.taxCents * amount) / source.totalCents),
        }))
        .filter((band) => band.taxableCents !== 0 || band.taxCents !== 0);
      let taxCents = bands.reduce((sum, band) => sum + band.taxCents, 0);
      // A one-cent credit against heavily taxed lines can round every band
      // up at once. The net must never go below zero, so the excess comes
      // back off the largest bands and the entry still balances.
      if (taxCents > amount) {
        let over = taxCents - amount;
        for (const band of [...bands].sort((a, b) => b.taxCents - a.taxCents)) {
          const cut = Math.min(band.taxCents, over);
          band.taxCents -= cut;
          over -= cut;
          if (over === 0) break;
        }
        taxCents = amount;
      }
      const netCents = amount - taxCents;

      const note = await db.transaction(async (tx) => {
        const [made] = await tx
          .insert(schema.invoices)
          .values({
            organizationId: orgId,
            contactId: source.contactId,
            currency: source.currency,
            kind: "credit_note",
            referenceInvoiceId: source.id,
            number: await nextDocumentNumber(tx, orgId, "invoice"),
            status: "open",
            issueDate: new Date(),
            notes: String(body.reason ?? "").trim() || null,
            subtotalCents: netCents,
            taxCents,
            totalCents: amount,
            // The credited money unwinds at the rate the sale was booked at,
            // or the reversal never fully clears what the sale put in.
            rateMicro: source.rateMicro,
            // A credit against an exempt sale carries the certificate that
            // excused it, so the filing's exempt figure falls too.
            exemptionCertificateId: source.exemptionCertificateId,
          })
          .returning();
        if (!made) throw new Error("credit note returned no row");

        await tx.insert(schema.invoiceLines).values({
          invoiceId: made.id,
          description: `Credit against invoice ${source.number}`,
          quantity: 1,
          quantityMilli: 1000,
          unitPriceCents: netCents,
        });
        // The note freezes its own bands the way the sale did: the US filing
        // and the tax summary read documents band by band, and a credit with
        // no bands is a credit those figures never see.
        await writeTaxBands(tx, orgId, "invoice", made.id, bands);
        /*
         * Posted in the same commit as the note.
         *
         * A credit note settles the invoice the moment it exists —
         * `creditedAgainst` counts every note that is not void, posted or
         * not — so a note written and then failing to post is a customer's
         * debt reduced with nothing in the books to match it, and an invoice
         * nobody chases for money the ledger still says is owed.
         */
        await postCreditNoteIssued(
          orgId,
          made,
          `Credit note ${made.number} against ${source.number}`,
          undefined,
          { tx },
        );
        return made;
      });

      /**
       * The credit settles the invoice the way a payment does: the customer
       * no longer owes that part. Left alone, a fully credited invoice kept
       * reading as outstanding and the reminder job chased the customer for
       * money nobody was owed. Same arithmetic as the payments route —
       * payments plus credits against what the invoice asks for — with the
       * two kinds of settlement passed apart, so an invoice settled by
       * credit alone reads `credited` rather than claiming somebody paid.
       */
      const paid = await db
        .select({ amountCents: schema.payments.amountCents })
        .from(schema.payments)
        .where(
          and(
            eq(schema.payments.invoiceId, source.id),
            eq(schema.payments.organizationId, orgId),
          ),
        );
      const { status, balanceDue } = invoiceStatus(
        source.totalCents - source.earlyDiscountTakenCents,
        paid.reduce((sum, p) => sum + p.amountCents, 0),
        already + amount,
      );
      await db
        .update(schema.invoices)
        .set({ status, updatedAt: new Date() })
        .where(eq(schema.invoices.id, source.id));

      return c.json({ creditNote: note, status, balanceDue }, 201);
    },
  );

  /**
   * The link a customer opens, for an invoice or a quote.
   *
   * A token rather than an account: the person being billed is a customer of a
   * small business, and asking them to register in order to read a bill is how
   * a bill goes unread. Minted once and kept, so a link already sent keeps
   * working; `?rotate=1` replaces it, which is what to do when one has gone
   * somewhere it should not have.
   */
  for (const kind of ["invoices", "quotes"] as const) {
    const table = kind === "invoices" ? schema.invoices : schema.quotes;

    ctx.app.post(
      `/api/${kind}/:id/share`,
      requireSession(),
      requirePermission({ invoicing: ["send"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const [row] = await db
          .select()
          .from(table)
          .where(
            and(
              eq(table.id, c.req.param("id")),
              eq(table.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!row) return c.json({ error: "not found" }, 404);

        const rotate = c.req.query("rotate") === "1";
        const token = !rotate && row.shareToken ? row.shareToken : shareToken();

        const [updated] = await db
          .update(table)
          .set({ shareToken: token, published: true, updatedAt: new Date() })
          .where(eq(table.id, row.id))
          .returning();

        const base =
          process.env.SENTRELLO_BASE_URL ?? new URL(c.req.url).origin;
        return c.json({
          url: `${base}/share/${kind === "invoices" ? "invoice" : "quote"}/${token}`,
          published: updated?.published ?? true,
        });
      },
    );

    /** Taking a shared document back offline, without losing the link. */
    ctx.app.post(
      `/api/${kind}/:id/unshare`,
      requireSession(),
      requirePermission({ invoicing: ["send"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const [row] = await db
          .update(table)
          .set({ published: false, updatedAt: new Date() })
          .where(
            and(
              eq(table.id, c.req.param("id")),
              eq(table.organizationId, orgId),
            ),
          )
          .returning();
        if (!row) return c.json({ error: "not found" }, 404);
        return c.json({ published: false });
      },
    );
  }
}
