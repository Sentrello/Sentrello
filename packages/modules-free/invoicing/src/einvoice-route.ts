import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, schema } from "@sentrello/db";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";
import { type EInvoiceInput, missingForEInvoice, toUbl } from "./einvoice";

/**
 * Handing over a structured e-invoice.
 *
 * Two routes rather than one, and the split is the point. `GET …/einvoice`
 * answers "could this be sent, and what is stopping it" — which is the question
 * the screen asks before offering a download. `GET …/einvoice.xml` produces the
 * document. A single route returning either a file or an error would make the
 * screen discover the problem by trying, which means the first a business hears
 * of a missing country is a failed download.
 */
export function registerEInvoice(ctx: ModuleContext) {
  /**
   * Everything the standard needs, gathered from three places.
   *
   * The buyer's address comes from the *company*, because that is the only
   * place this platform holds one. A customer recorded as a person has no
   * address to give, which is the commonest reason an e-invoice cannot be
   * produced and is reported as such rather than as a validation code.
   */
  const gather = async (
    orgId: string,
    invoiceId: string,
  ): Promise<EInvoiceInput | null> => {
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
    if (!invoice) return null;

    const [org] = await db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.id, orgId))
      .limit(1);

    const lines = await db
      .select()
      .from(schema.invoiceLines)
      .where(eq(schema.invoiceLines.invoiceId, invoice.id))
      .orderBy(schema.invoiceLines.sortOrder);

    let buyerName = "";
    let company: typeof schema.companies.$inferSelect | undefined;
    if (invoice.contactId) {
      const [contact] = await db
        .select()
        .from(schema.contacts)
        .where(eq(schema.contacts.id, invoice.contactId))
        .limit(1);
      buyerName = contact?.name ?? "";
      if (contact?.companyId) {
        [company] = await db
          .select()
          .from(schema.companies)
          .where(eq(schema.companies.id, contact.companyId))
          .limit(1);
      }
    }

    const paid = await db
      .select({ amountCents: schema.payments.amountCents })
      .from(schema.payments)
      .where(eq(schema.payments.invoiceId, invoice.id));
    const paidCents = paid.reduce((sum, p) => sum + p.amountCents, 0);

    return {
      number: invoice.number,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      currency: invoice.currency,
      seller: {
        name: org?.name ?? "",
        street: org?.address ?? null,
        city: org?.city ?? null,
        postcode: org?.postcode ?? null,
        countryCode: org?.countryCode ?? null,
        taxId: org?.taxId ?? null,
      },
      buyer: {
        // The company's name where there is one: an e-invoice is addressed to
        // the legal entity being billed, not to the person who ordered.
        name: company?.name ?? buyerName,
        street: company?.address ?? null,
        city: company?.city ?? null,
        postcode: company?.postcode ?? null,
        countryCode: company?.country ?? null,
        taxId: company?.taxIdentifier ?? null,
      },
      lines: lines.map((line) => ({
        description: line.description,
        quantityMilli: line.quantityMilli,
        unit: line.unit,
        unitPriceCents: line.unitPriceCents,
        netCents: Math.round((line.quantityMilli * line.unitPriceCents) / 1000),
        taxRateBp: line.taxRateBp,
      })),
      subtotalCents: invoice.subtotalCents,
      taxCents: invoice.taxCents,
      totalCents: invoice.totalCents,
      /*
       * What is still owed. An e-invoice quoting the full total on a part-paid
       * invoice asks the customer for money they have already sent.
       */
      dueCents: Math.max(0, invoice.totalCents - paidCents),
      note: invoice.notes,
    };
  };

  ctx.app.get(
    "/api/invoices/:id/einvoice",
    requireSession(),
    requirePermission({ invoicing: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const input = await gather(orgId, c.req.param("id") ?? "");
      if (!input) return c.json({ error: "not found" }, 404);

      const missing = missingForEInvoice(input);
      return c.json({
        ready: missing.length === 0,
        missing,
        /*
         * Sent so the screen can say who it is addressed to. An e-invoice goes
         * to the legal entity rather than the person who ordered, and that is
         * worth confirming before it is filed with a tax authority.
         */
        addressedTo: input.buyer.name,
        country: input.buyer.countryCode,
      });
    },
  );

  ctx.app.get(
    "/api/invoices/:id/einvoice.xml",
    requireSession(),
    requirePermission({ invoicing: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const input = await gather(orgId, c.req.param("id") ?? "");
      if (!input) return c.json({ error: "not found" }, 404);

      try {
        const xml = toUbl(input);
        return c.body(xml, 200, {
          "content-type": "application/xml; charset=utf-8",
          // Named after the invoice, because a folder of `einvoice.xml` files is
          // a folder nobody can use.
          "content-disposition": `attachment; filename="${input.number}-en16931.xml"`,
        });
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }
    },
  );
}
