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
/**
 * How long invoices are kept, in the market the business is in.
 *
 * This screen tells a business what to copy into its own privacy notice, and
 * the sentence here read "six years in the UK." to all four markets until
 * 26 September 2026 — so an American shop was handed a British retention
 * period as if it were its own.
 *
 * **The figures are the statutory record-keeping period, and they should be
 * checked by an accountant before anybody relies on them.** They are in one
 * table for exactly that reason: correcting one is a one-line change, and
 * the authority each comes from is named beside it.
 *
 * - **GB** — six years. Companies Act 2006 s388 for company records, and
 *   HMRC's own guidance for business records generally.
 * - **CA** — six years, counted from the end of the last tax year the record
 *   relates to. Canada Revenue Agency.
 * - **US** — the IRS period of limitations is three years for most returns
 *   and six where income is substantially under-reported, so the sentence
 *   says at least three and longer in some cases rather than picking one.
 * - **The EU** — set by each member state and genuinely different across
 *   them, from six years to ten. Stated as the range rather than invented as
 *   a single figure.
 *
 * A country nobody has filled in, or one outside these markets, gets the
 * sentence without a number: the obligation is real wherever the business
 * is, and the length is not ours to assert.
 */
const EU = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "EL",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
]);

const HOW_LONG: Record<string, string> = {
  GB: "six years",
  CA: "six years",
  US: "at least three years, and longer where a return is under enquiry",
};

export function invoiceRetention(countryCode: string | null): string {
  const country = (countryCode ?? "").trim().toUpperCase();
  const period =
    HOW_LONG[country] ??
    (EU.has(country)
      ? "between six and ten years, depending on the country"
      : null);
  const opening = period
    ? `Invoices are kept for as long as the law requires the business to keep its accounts — ${period}.`
    : "Invoices are kept for as long as the law requires the business to keep its accounts, which is set by the country it is in.";
  return `${opening} They are not deleted on request.`;
}

export function registerInvoicingPersonalData(ctx: ModuleContext) {
  ctx.registerPersonalData({
    id: "invoicing",
    label: "Invoices and quotes",
    retention: invoiceRetention,

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
