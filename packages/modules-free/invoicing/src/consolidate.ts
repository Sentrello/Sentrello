import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, inArray, schema } from "@sentrello/db";
import { defaultDueDate } from "@sentrello/db/documents";
import { MoneyError } from "@sentrello/db/money";
import { nextDocumentNumber } from "@sentrello/db/numbering";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";
import {
  type IncomingLine,
  parseDiscount,
  prepareDocument,
  writeTaxBands,
} from "./documents";

/**
 * Several drafts for one customer, sent as one invoice.
 *
 * A business that raises a draft per job at the end of each visit has five
 * drafts for the same customer by Friday, and one of two bad options: send
 * five invoices, or retype the lot into a sixth. The reference product merges
 * them, and it is the right shape — the work was billed correctly, it is only
 * the envelope that should be one.
 *
 * The constraints are the whole feature, because each of them is a way to
 * produce a document that cannot be reconciled:
 *
 *  - **Drafts only.** An invoice that has been sent is a claim the customer
 *    already has. Folding it into another leaves two documents asking for the
 *    same money, and no way to tell which one a payment settled.
 *  - **One customer.** Obvious, and worth refusing rather than trusting the
 *    screen to have filtered properly.
 *  - **One currency.** Adding 400 EUR to 400 USD gives 800 of nothing.
 *
 * The lines keep the number of the invoice they came from, so the customer's
 * copy reads as the several jobs it actually was, with a subtotal each. The
 * sources' own discounts are not carried over — a discount is a decision about
 * one document — but a single discount may be applied to the merged one.
 */

interface ConsolidateBody {
  contactId?: unknown;
  invoiceIds?: unknown;
  discountType?: unknown;
  discountValue?: unknown;
}

export function registerConsolidate(ctx: ModuleContext) {
  ctx.app.post(
    "/api/invoices/consolidate",
    requireSession(),
    requirePermission({ invoicing: ["create"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as ConsolidateBody;

      const ids = Array.isArray(body.invoiceIds)
        ? (body.invoiceIds as unknown[]).filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          )
        : [];
      if (ids.length < 2) {
        return c.json({ error: "pick at least two drafts to merge" }, 400);
      }

      const sources = await db
        .select()
        .from(schema.invoices)
        .where(
          and(
            eq(schema.invoices.organizationId, orgId),
            inArray(schema.invoices.id, ids),
          ),
        );
      if (sources.length !== ids.length) {
        return c.json({ error: "one of those does not exist" }, 404);
      }

      const notDraft = sources.find((s) => s.status !== "draft");
      if (notDraft) {
        return c.json(
          {
            error: `${notDraft.number} has already been issued — only drafts can be merged`,
          },
          409,
        );
      }

      const currencies = new Set(sources.map((s) => s.currency));
      if (currencies.size > 1) {
        return c.json(
          { error: "those drafts are not all in the same currency" },
          409,
        );
      }

      const contacts = new Set(sources.map((s) => s.contactId ?? ""));
      if (contacts.size > 1) {
        return c.json(
          { error: "those drafts are for different customers" },
          409,
        );
      }
      const contactId =
        (typeof body.contactId === "string" ? body.contactId : null) ??
        sources[0]?.contactId ??
        null;

      /**
       * In the order they were raised, so the merged document reads
       * chronologically rather than in whatever order the ids arrived.
       */
      const ordered = [...sources].sort(
        (a, b) => a.issueDate.getTime() - b.issueDate.getTime(),
      );

      const lines = await db
        .select()
        .from(schema.invoiceLines)
        .where(
          inArray(
            schema.invoiceLines.invoiceId,
            ordered.map((s) => s.id),
          ),
        );
      const byInvoice = new Map<string, typeof lines>();
      for (const line of lines) {
        const list = byInvoice.get(line.invoiceId) ?? [];
        list.push(line);
        byInvoice.set(line.invoiceId, list);
      }

      const incoming: IncomingLine[] = [];
      for (const source of ordered) {
        const own = (byInvoice.get(source.id) ?? []).sort(
          (a, b) => a.sortOrder - b.sortOrder,
        );
        for (const line of own) {
          incoming.push({
            billableItemId: line.billableItemId,
            description: line.description,
            quantityMilli: line.quantityMilli,
            unitPriceCents: line.unitPriceCents,
            unit: line.unit,
            taxDefinitionId: line.taxDefinitionId,
            sourceNumber: source.number,
          });
        }
      }
      if (incoming.length === 0) {
        return c.json({ error: "those drafts have no lines" }, 400);
      }

      let prepared: Awaited<ReturnType<typeof prepareDocument>>;
      try {
        prepared = await prepareDocument(orgId, incoming, parseDiscount(body));
      } catch (err) {
        if (err instanceof MoneyError) {
          return c.json({ error: err.message }, 400);
        }
        throw err;
      }

      const merged = await db.transaction(async (tx) => {
        const [invoice] = await tx
          .insert(schema.invoices)
          .values({
            organizationId: orgId,
            contactId,
            currency: sources[0]?.currency ?? "USD",
            number: await nextDocumentNumber(tx, orgId, "invoice"),
            status: "draft",
            issueDate: new Date(),
            dueDate: defaultDueDate(),
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
            notes: `Merged from ${ordered.map((s) => s.number).join(", ")}.`,
          })
          .returning();
        if (!invoice) throw new Error("invoice insert returned no row");

        await tx
          .insert(schema.invoiceLines)
          .values(
            prepared.lines.map((line) => ({ ...line, invoiceId: invoice.id })),
          );
        await writeTaxBands(tx, orgId, "invoice", invoice.id, prepared.bands);

        /**
         * The sources go to the trash, not to nothing.
         *
         * They are drafts, so nobody has seen them, but somebody merged the
         * wrong five and will want to look. Soft-deleted is how every other
         * document leaves this module, and it is already what Restore reads.
         */
        await tx
          .update(schema.invoices)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(schema.invoices.organizationId, orgId),
              inArray(
                schema.invoices.id,
                ordered.map((s) => s.id),
              ),
            ),
          );

        return invoice;
      });

      return c.json(
        { invoice: merged, mergedFrom: ordered.map((s) => s.number) },
        201,
      );
    },
  );
}
