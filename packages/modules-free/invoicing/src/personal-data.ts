import { and, db, eq, inArray, schema, sql } from "@sentrello/db";
import { RETENTION_YEARS, retentionYears } from "@sentrello/db/archive";
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
 * **The number comes from the deletion floor, and there is only one of it.**
 * This file used to keep its own table of statutory periods beside the one
 * in `@sentrello/db/archive` that decides what may actually be deleted, and
 * the two disagreed the moment an accountant moved the floors on
 * 27 September 2026: the notice promised six years while Archive refused for
 * seven, and told an American three while it refused for seven. A privacy
 * notice that understates how long something is kept is the one kind of
 * inaccuracy that matters here, so the sentence now reads the floor.
 *
 * Why the floor is the honest figure rather than the statute: the statutory
 * clock starts at the end of an accounting period and ours starts on the
 * invoice's own date, so the floor is a little longer than the statute
 * everywhere — and what the reader wants to know is when the record actually
 * goes, not when the law stops asking for it. The statutory reasoning, and
 * the authority behind each number, lives beside the floors themselves.
 *
 * A country outside our four markets still gets no foreign statute quoted at
 * it — that was the 26 September bug, where an American shop was handed a
 * British period as if it were its own. What it gets instead is the truth
 * about this instance: the default floor, and the fact that the length is
 * set by the country the business is in.
 */
/** The floors are numbers; a privacy notice is prose. */
const IN_WORDS: Record<number, string> = {
  6: "six",
  7: "seven",
  8: "eight",
  9: "nine",
  10: "ten",
};

function years(n: number): string {
  return `${IN_WORDS[n] ?? n} years`;
}

export function invoiceRetention(countryCode: string | null): string {
  const country = (countryCode ?? "").trim().toUpperCase();
  const known = country in RETENTION_YEARS;
  const period = years(retentionYears(country || null));
  const opening = known
    ? `Invoices are kept for as long as the law requires the business to keep its accounts, which here is ${period}.`
    : `Invoices are kept for as long as the law requires the business to keep its accounts, which is set by the country it is in. This instance keeps them for ${period}.`;
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
