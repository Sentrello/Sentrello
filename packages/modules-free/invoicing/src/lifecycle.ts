import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, isNull, schema } from "@sentrello/db";
import { copyInvoice } from "@sentrello/db/documents";
import {
  CORE_ACCOUNTS,
  ensureAccount,
  postInvoiceIssued,
  postJournalEntry,
} from "@sentrello/db/ledger";
import { nextDocumentNumber } from "@sentrello/db/numbering";
import type { ModuleContext } from "@sentrello/module-sdk";
import { shareToken, writeTaxBands } from "./documents";

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

  const plain = /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
  const parsed = new Date(plain ? `${value.trim()}T12:00:00.000Z` : value);
  if (Number.isNaN(parsed.getTime())) {
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

      const [issued] = await db
        .update(schema.invoices)
        .set({ status: "open", issueDate: issuedOn, updatedAt: new Date() })
        .where(eq(schema.invoices.id, invoice.id))
        .returning();
      if (!issued) throw new Error("issue returned no row");

      /**
       * The one posting function, shared with the create route and the
       * recurring job. The copy that used to live here credited income with
       * subtotal-less-discount and ignored the exchange rate entirely, so a
       * euro invoice put euro cents into dollar books — the two bugs the
       * shared one was written to fix, still sitting in this path because
       * nobody had noticed there were two implementations.
       */
      await postInvoiceIssued(orgId, issued, undefined, issuedOn);

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
      const copy = await copyInvoice(orgId, c.req.param("id"), {
        status: "draft",
        issueDate: new Date(),
      });
      if (!copy) return c.json({ error: "not found" }, 404);

      return c.json({ invoice: copy }, 201);
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

      const [voided] = await db
        .update(schema.invoices)
        .set({ status: "void", updatedAt: new Date() })
        .where(eq(schema.invoices.id, invoice.id))
        .returning();

      // A draft was never in the books, so there is nothing to reverse.
      if (invoice.status !== "draft") {
        const [ar, income, taxPayable] = await Promise.all([
          ensureAccount(orgId, CORE_ACCOUNTS.accountsReceivable),
          ensureAccount(orgId, CORE_ACCOUNTS.salesIncome),
          ensureAccount(orgId, CORE_ACCOUNTS.taxPayable),
        ]);
        await postJournalEntry(
          orgId,
          `Void invoice ${invoice.number}`,
          `invoice-void:${invoice.id}`,
          [
            { accountId: ar, creditCents: invoice.totalCents },
            {
              accountId: income,
              debitCents: invoice.subtotalCents - invoice.discountCents,
            },
            ...(invoice.taxCents > 0
              ? [{ accountId: taxPayable, debitCents: invoice.taxCents }]
              : []),
          ],
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

      const body = (await c.req.json().catch(() => ({}))) as {
        amountCents?: unknown;
        reason?: unknown;
      };
      const amountCents = body.amountCents ?? source.totalCents;
      if (
        !Number.isInteger(amountCents) ||
        (amountCents as number) <= 0 ||
        (amountCents as number) > source.totalCents
      ) {
        // More than the invoice is not a credit, it is a payment to the
        // customer, and it belongs somewhere a business can see it.
        return c.json(
          { error: "a credit note is between one cent and the invoice total" },
          400,
        );
      }

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
            subtotalCents: amountCents as number,
            totalCents: amountCents as number,
          })
          .returning();
        if (!made) throw new Error("credit note returned no row");

        await tx.insert(schema.invoiceLines).values({
          invoiceId: made.id,
          description: `Credit against invoice ${source.number}`,
          quantity: 1,
          quantityMilli: 1000,
          unitPriceCents: amountCents as number,
        });
        return made;
      });

      const [ar, income] = await Promise.all([
        ensureAccount(orgId, CORE_ACCOUNTS.accountsReceivable),
        ensureAccount(orgId, CORE_ACCOUNTS.salesIncome),
      ]);
      await postJournalEntry(
        orgId,
        `Credit note ${note.number} against ${source.number}`,
        `credit-note:${note.id}`,
        [
          { accountId: income, debitCents: amountCents as number },
          { accountId: ar, creditCents: amountCents as number },
        ],
      );

      return c.json({ creditNote: note }, 201);
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
