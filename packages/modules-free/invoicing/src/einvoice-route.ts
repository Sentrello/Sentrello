import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, inArray, schema } from "@sentrello/db";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";
import {
  EINVOICE_PROFILES,
  type EInvoiceInput,
  type EInvoiceProfile,
  missingForEInvoice,
  toUbl,
} from "./einvoice";

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
/**
 * Which rulebook the caller asked for. The bare norm is the default so every
 * existing consumer keeps the document it always got; `peppol` is what the
 * network itself validates; `xrechnung` is Germany's. A profile this server
 * does not know is a 400 in words, not a silently different document.
 */
const unknownProfile =
  "unknown profile — this endpoint produces en16931, peppol or xrechnung";

function readProfile(c: RouteContext): EInvoiceProfile | null {
  const asked = c.req.query("profile") ?? "en16931";
  return (EINVOICE_PROFILES as readonly string[]).includes(asked)
    ? (asked as EInvoiceProfile)
    : null;
}

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
        // Org-filtered: a buyer on the document has to be this business's
        // contact, however the id got onto the invoice.
        .where(
          and(
            eq(schema.contacts.id, invoice.contactId),
            eq(schema.contacts.organizationId, orgId),
          ),
        )
        .limit(1);
      buyerName = contact?.name ?? "";
      if (contact?.companyId) {
        [company] = await db
          .select()
          .from(schema.companies)
          .where(
            and(
              eq(schema.companies.id, contact.companyId),
              eq(schema.companies.organizationId, orgId),
            ),
          )
          .limit(1);
      }
    }

    const paid = await db
      .select({ amountCents: schema.payments.amountCents })
      .from(schema.payments)
      .where(eq(schema.payments.invoiceId, invoice.id));
    const paidCents = paid.reduce((sum, p) => sum + p.amountCents, 0);

    /**
     * The frozen tax breakdown, and the categories behind it.
     *
     * The bands are what the document was taxed at when it was issued —
     * discount already apportioned — so the XML's breakdown agrees with the
     * totals block to the cent. The definitions supply what the bands do not
     * carry: the wording for an exempt or reverse-charge category, and the
     * category for an older line that recorded only a definition id.
     */
    const bands = await db
      .select()
      .from(schema.documentTaxes)
      .where(
        and(
          eq(schema.documentTaxes.organizationId, orgId),
          eq(schema.documentTaxes.documentType, "invoice"),
          eq(schema.documentTaxes.documentId, invoice.id),
        ),
      );
    const wanted = [
      ...new Set(
        [
          ...bands.map((band) => band.taxDefinitionId),
          ...lines.map((line) => line.taxDefinitionId),
        ].filter((id): id is string => id !== null),
      ),
    ];
    const definitions = new Map(
      wanted.length
        ? (
            await db
              .select({
                id: schema.taxDefinitions.id,
                categoryCode: schema.taxDefinitions.categoryCode,
                description: schema.taxDefinitions.description,
              })
              .from(schema.taxDefinitions)
              .where(
                and(
                  eq(schema.taxDefinitions.organizationId, orgId),
                  inArray(schema.taxDefinitions.id, wanted),
                ),
              )
          ).map((d) => [d.id, d])
        : [],
    );

    return {
      number: invoice.number,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      currency: invoice.currency,
      kind: invoice.kind,
      seller: {
        name: org?.name ?? "",
        street: org?.address ?? null,
        city: org?.city ?? null,
        postcode: org?.postcode ?? null,
        countryCode: org?.countryCode ?? null,
        taxId: org?.taxId ?? null,
        /*
         * The contact point Germany requires on every XRechnung (BR-DE-5/6/7).
         * The business's own name serves as the contact name — a
         * micro-business is its own switchboard.
         */
        contactName: org?.name ?? null,
        contactPhone: org?.phone ?? null,
        contactEmail: org?.email ?? null,
      },
      buyerReference: invoice.buyerReference,
      paymentTerms: invoice.paymentTerms,
      payment: { iban: org?.iban ?? null, accountName: org?.name ?? null },
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
        taxRatePpm: line.taxRatePpm,
        // The line's own frozen taxes where it has them; otherwise the
        // category from its definition — which is how an exempt or
        // reverse-charge line recorded before lines carried categories still
        // reaches the XML as E or AE rather than mislabelled Z.
        taxes: line.taxes?.length
          ? line.taxes
          : line.taxDefinitionId && definitions.has(line.taxDefinitionId)
            ? [
                {
                  rateBp: line.taxRateBp,
                  ratePpm: line.taxRatePpm,
                  categoryCode: (
                    definitions.get(line.taxDefinitionId) as {
                      categoryCode: string;
                    }
                  ).categoryCode,
                },
              ]
            : null,
      })),
      bands: bands.map((band) => ({
        rateBp: band.rateBp,
        ratePpm: band.ratePpm,
        categoryCode: band.categoryCode,
        taxableCents: band.taxableCents,
        taxCents: band.taxCents,
        exemptionReason: band.taxDefinitionId
          ? (definitions.get(band.taxDefinitionId)?.description ?? null)
          : null,
      })),
      subtotalCents: invoice.subtotalCents,
      discountCents: invoice.discountCents,
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
      const profile = readProfile(c);
      if (!profile) return c.json({ error: unknownProfile }, 400);
      const input = await gather(orgId, c.req.param("id") ?? "");
      if (!input) return c.json({ error: "not found" }, 404);

      const missing = missingForEInvoice({ ...input, profile });
      return c.json({
        ready: missing.length === 0,
        missing,
        profile,
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
      const profile = readProfile(c);
      if (!profile) return c.json({ error: unknownProfile }, 400);
      const input = await gather(orgId, c.req.param("id") ?? "");
      if (!input) return c.json({ error: "not found" }, 404);

      try {
        const xml = toUbl({ ...input, profile });
        return c.body(xml, 200, {
          "content-type": "application/xml; charset=utf-8",
          // Named after the invoice and the rulebook it satisfies, because a
          // folder of `einvoice.xml` files is a folder nobody can use.
          "content-disposition": `attachment; filename="${input.number}-${profile}.xml"`,
        });
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }
    },
  );
}
