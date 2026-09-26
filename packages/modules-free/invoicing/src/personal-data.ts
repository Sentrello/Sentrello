import { and, db, eq, inArray, schema, sql } from "@sentrello/db";
import type { ModuleContext, PersonalRecord } from "@sentrello/module-sdk";

/**
 * What invoicing holds about a person — and why almost none of it can be
 * deleted.
 *
 * This is the module that has to say no, and saying it precisely is the whole
 * point. An invoice is a record the business is required to keep: six years in
 * the UK, longer in some places, and the obligation is the business's own
 * rather than something a customer can waive. GDPR article 17(3)(b) exempts
 * processing needed to comply with a legal obligation, and the CCPA has the
 * same carve-out for transactions.
 *
 * So the answer to an erasure request here is "no, and here is the reason",
 * which is a lawful answer. What would not be lawful is deleting the invoice,
 * and what would be worse than either is telling somebody their data is gone
 * while the ledger still names them.
 */
export function registerInvoicingPersonalData(ctx: ModuleContext) {
  ctx.registerPersonalData({
    id: "invoicing",
    label: "Invoices and quotes",
    /*
     * How long, without telling three of our four markets the fourth's rule.
     *
     * This read "six years in the UK" full stop, on a screen a business is
     * told to copy into its own privacy notice — so an American shop was
     * handed a British retention period as if it were theirs. The figure
     * stays because it is the one we can state without qualification; what
     * changes is that it is now an example rather than the rule, and the
     * sentence says the answer depends on where the business is.
     *
     * The real fix is country-aware copy, which needs `registerPersonalData`
     * to take a function of the organisation rather than a string. Worth
     * doing; not worth guessing at four tax codes to do it today.
     */
    retention:
      "Invoices are kept for as long as the law requires the business to keep its accounts — six years in the UK, for example. How long that is depends on where the business is, and they are not deleted on request.",

    export: async (orgId, subject) => {
      if (!subject.email && !subject.id) return [];

      const contacts = await db
        .select({ id: schema.contacts.id })
        .from(schema.contacts)
        .where(
          and(
            eq(schema.contacts.organizationId, orgId),
            subject.id
              ? eq(schema.contacts.id, subject.id)
              : sql`lower(${schema.contacts.email}) = lower(${subject.email})`,
          ),
        );
      if (!contacts.length) return [];

      const rows = await db
        .select()
        .from(schema.invoices)
        .where(
          and(
            eq(schema.invoices.organizationId, orgId),
            inArray(
              schema.invoices.contactId,
              contacts.map((c) => c.id),
            ),
          ),
        );

      return rows.map(
        (i): PersonalRecord => ({
          kind: i.kind === "quote" ? "Quote" : "Invoice",
          reference: i.number ?? i.id,
          data: {
            number: i.number,
            issueDate: i.issueDate,
            dueDate: i.dueDate,
            status: i.status,
            currency: i.currency,
            totalCents: i.totalCents,
          },
        }),
      );
    },

    /*
     * No `erase`, deliberately.
     *
     * Omitting it is a statement — this module holds nothing it may lawfully
     * delete — and it is a better one than an implementation that quietly does
     * nothing and reports success. What a business tells the person is the
     * `retention` sentence above, which is why that field is required.
     */
  });
}
