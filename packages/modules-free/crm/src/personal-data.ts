import { and, db, eq, inArray, or, schema, sql } from "@sentrello/db";
import { consentHistory, describeConsent } from "@sentrello/db/consent";
import { redactPayloads } from "@sentrello/db/erasure";
import { RECORD_EVENT_PAYLOADS } from "@sentrello/db/record-events";
import type {
  DataSubject,
  EraseOutcome,
  ModuleContext,
  PersonalRecord,
} from "@sentrello/module-sdk";

/**
 * What the CRM holds about a person, and what it can do about it.
 *
 * This module holds more personal data than any other — a contact record *is* a
 * person — and until now it could answer neither of the two questions somebody
 * has a legal right to ask. A business asked "what do you have on me" had no
 * way to find out, and one asked to delete somebody could only do it by
 * deleting the contact and hoping nothing else referred to them.
 */

/** Every contact in this organisation that could be the person asking. */
async function matching(orgId: string, subject: DataSubject) {
  const tests = [
    subject.id ? eq(schema.contacts.id, subject.id) : null,
    subject.email
      ? sql`lower(${schema.contacts.email}) = lower(${subject.email})`
      : null,
    /*
     * The extra addresses too. A person who gave a work address and a personal
     * one is one person, and answering only on the primary address is how a
     * business tells somebody "we hold nothing about you" while holding a
     * record filed under their other email.
     */
    subject.email
      ? sql`exists (select 1 from jsonb_array_elements(coalesce(${schema.contacts.emails}, '[]'::jsonb)) e
             where lower(e->>'value') = lower(${subject.email}))`
      : null,
    subject.phone ? eq(schema.contacts.phone, subject.phone) : null,
  ].filter(Boolean);
  if (!tests.length) return [];

  return db
    .select()
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.organizationId, orgId),
        or(...(tests as NonNullable<(typeof tests)[number]>[])),
      ),
    );
}

export function registerCrmPersonalData(ctx: ModuleContext) {
  ctx.registerPersonalData({
    id: "crm",
    label: "Customer and contact records",
    retention:
      "For as long as the contact exists. Notes and activities are removed with them.",

    export: async (orgId, subject) => {
      const people = await matching(orgId, subject);
      if (!people.length) return [];
      const ids = people.map((p) => p.id);
      const out: PersonalRecord[] = people.map((p) => ({
        kind: "Contact",
        reference: p.name,
        data: {
          name: p.name,
          firstName: p.firstName,
          lastName: p.lastName,
          title: p.title,
          email: p.email,
          emails: p.emails,
          phone: p.phone,
          phones: p.phones,
          linkedinUrl: p.linkedinUrl,
          kind: p.kind,
          status: p.status,
          createdAt: p.createdAt,
        },
      }));

      const notes = await db
        .select()
        .from(schema.notes)
        .where(
          and(
            eq(schema.notes.organizationId, orgId),
            eq(schema.notes.entityType, "contact"),
            inArray(schema.notes.entityId, ids),
          ),
        );
      for (const n of notes) {
        out.push({
          kind: "Note",
          reference: String(n.createdAt),
          data: { text: n.text, createdAt: n.createdAt },
        });
      }

      const activities = await db
        .select()
        .from(schema.activities)
        .where(
          and(
            eq(schema.activities.organizationId, orgId),
            inArray(schema.activities.contactId, ids),
          ),
        );
      for (const a of activities) {
        out.push({
          kind: a.type === "call" ? "Call" : "Activity",
          reference: String(a.occurredAt),
          data: { type: a.type, body: a.body, occurredAt: a.occurredAt },
        });
      }

      /*
       * What they agreed to, and when. The record rather than the tick.
       *
       * An access request under GDPR or Law 25 that answers "marketing: yes"
       * has not answered the question the person asked, which is usually how
       * this business came to have their address in the first place.
       */
      const consents = (
        await Promise.all(
          ids.map((id) => consentHistory(orgId, { kind: "contact", id })),
        )
      ).flat();
      for (const row of consents) {
        out.push({
          kind: "Consent",
          reference: describeConsent(row),
          data: {
            purpose: row.purpose,
            granted: row.granted,
            how: row.source,
            wording: row.wording,
            recordedBy: row.actorName,
            at: row.at,
          },
        });
      }

      return out;
    },

    erase: async (orgId, subject): Promise<EraseOutcome> => {
      const people = await matching(orgId, subject);
      if (!people.length) return { removed: [], kept: [] };
      const ids = people.map((p) => p.id);

      const notes = await db
        .delete(schema.notes)
        .where(
          and(
            eq(schema.notes.organizationId, orgId),
            eq(schema.notes.entityType, "contact"),
            inArray(schema.notes.entityId, ids),
          ),
        )
        .returning({ id: schema.notes.id });

      const activities = await db
        .delete(schema.activities)
        .where(
          and(
            eq(schema.activities.organizationId, orgId),
            inArray(schema.activities.contactId, ids),
          ),
        )
        .returning({ id: schema.activities.id });

      await db
        .delete(schema.contacts)
        .where(
          and(
            eq(schema.contacts.organizationId, orgId),
            inArray(schema.contacts.id, ids),
          ),
        );

      /*
       * And every log that kept a copy of them on the way past.
       *
       * Deleting the contact was never the hard part. The platform writes the
       * record down in several places as it works — the change feed, the
       * outbound delivery log, what a merge folded in, what somebody typed
       * into a form — and an erasure that leaves any of them full is not an
       * erasure. It is worse than the gap, because the screen then tells a
       * data subject something untrue.
       *
       * Emptied rather than deleted. A business still has to be able to say
       * that a delivery was attempted and abandoned, that a merge happened, or
       * that a form was submitted on the third; those are facts about the
       * business, not about the person. The rows and their shape stay and the
       * person comes out of them.
       *
       * Once per person, keyed on everything we know them by — the same one
       * function every other store in the product uses, including the workflow
       * run logs in the paid bundle, so no two logs forget somebody to two
       * different standards.
       */
      let logs = 0;
      for (const person of people) {
        const who = {
          id: person.id,
          email: person.email ?? subject.email,
          phone: person.phone ?? subject.phone,
        };
        logs += await redactPayloads({
          table: schema.recordEvents,
          organizationId: orgId,
          subject: who,
          // From the list beside the columns, which the retention sweep reads
          // too: two spellings of what a payload is would agree for a
          // fortnight, and the one that drifted would be this one.
          payloads: [...RECORD_EVENT_PAYLOADS],
        });
        logs += await redactPayloads({
          table: schema.crmWebhookDeliveries,
          organizationId: orgId,
          subject: who,
          // The envelope is the operational record — which endpoint, which
          // event, how many attempts. Only the record it carried comes out.
          payloads: [
            {
              column: schema.crmWebhookDeliveries.payload,
              keys: ["before", "after"],
            },
          ],
        });
        logs += await redactPayloads({
          table: schema.contactMerges,
          organizationId: orgId,
          subject: who,
          payloads: [schema.contactMerges.mergedRecord],
        });
        logs += await redactPayloads({
          table: schema.formSubmissions,
          organizationId: orgId,
          subject: who,
          payloads: [schema.formSubmissions.payload],
        });
      }

      return {
        removed: [
          `${people.length} contact record${people.length === 1 ? "" : "s"}`,
          ...(notes.length ? [`${notes.length} notes`] : []),
          ...(activities.length
            ? [`${activities.length} calls and activities`]
            : []),
          ...(logs
            ? [
                `their details in ${logs} log entr${logs === 1 ? "y" : "ies"} — the change feed, webhook deliveries, merges and form submissions`,
              ]
            : []),
        ],
        /*
         * Said rather than implied, and this is the part that makes the answer
         * lawful rather than merely reassuring.
         *
         * A deal names the contact by id and is a record of the business's own
         * trading, not of the person; anything they were actually billed for is
         * an invoice, which tax law requires to be kept and which the invoicing
         * module answers for. Telling somebody "everything is gone" while the
         * ledger still names them would be a false statement made in writing.
         */
        kept: [
          {
            what: "Deals this contact was named on",
            why: "the business's own record of its trading; the person is no longer named",
          },
          {
            what: "That each log entry happened, and what it did",
            why: "a delivery that was attempted and abandoned, a merge, a form submission: the business's own operational record, now holding no personal data and only the internal reference the deleted record had",
          },
        ],
      };
    },
  });
}
