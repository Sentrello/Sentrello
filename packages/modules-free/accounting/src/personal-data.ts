import { and, db, eq, inArray, schema, sql } from "@sentrello/db";
import type { ModuleContext, PersonalRecord } from "@sentrello/module-sdk";

/**
 * What accounting holds about a person.
 *
 * Two kinds, and neither can be deleted on request.
 *
 * A **contractor's tax details** are what a 1099 is filed from. The US
 * requirement to keep them runs years past the filing, and a business that
 * deleted them because somebody asked would be unable to answer the IRS. A
 * **journal entry** is the business's own book of account and the same applies.
 *
 * GDPR article 17(3)(b) exempts processing needed to comply with a legal
 * obligation, and the CCPA exempts transaction records. So the lawful answer
 * here is "no, and here is the reason", which is what this registers.
 */
export function registerAccountingPersonalData(ctx: ModuleContext) {
  ctx.registerPersonalData({
    id: "accounting",
    label: "Contractor tax details",
    retention:
      "Kept for as long as tax law requires the business to be able to answer for a filing — years after the last payment. Not deleted on request.",

    export: async (orgId, subject) => {
      if (!subject.email && !subject.id) return [];

      const contacts = await db
        .select({ id: schema.contacts.id, name: schema.contacts.name })
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
        .from(schema.contractorTaxDetails)
        .where(
          and(
            eq(schema.contractorTaxDetails.organizationId, orgId),
            inArray(
              schema.contractorTaxDetails.contactId,
              contacts.map((c) => c.id),
            ),
          ),
        );

      return rows.map(
        (r): PersonalRecord => ({
          kind: "Contractor tax details",
          reference: r.legalName ?? undefined,
          data: {
            legalName: r.legalName,
            entityType: r.entityType,
            reportable: r.reportable,
            /**
             * Said to be held, and not printed.
             *
             * The tax id is sealed everywhere else in the platform — no route
             * returns it — and this screen is used by staff, not by the person
             * asking. Printing it here to satisfy an access request would
             * re-expose the one field the whole module takes care never to
             * show, on a screen anybody with settings access can open.
             *
             * Telling the person it is held, and handing it over separately if
             * they ask, meets the right without undoing the sealing. If that
             * is ever judged insufficient, the fix is a channel that reaches
             * the subject directly — not printing it here.
             */
            taxId: r.taxId ? "held, not shown — ask if they need it" : null,
          },
        }),
      );
    },

    // No `erase`. See the note at the top: the obligation is the business's own
    // and a person cannot waive it on the business's behalf.
  });
}
