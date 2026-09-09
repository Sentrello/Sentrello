import { and, db, eq, inArray, or, schema, sql } from "@sentrello/db";
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

      return {
        removed: [
          `${people.length} contact record${people.length === 1 ? "" : "s"}`,
          ...(notes.length ? [`${notes.length} notes`] : []),
          ...(activities.length
            ? [`${activities.length} calls and activities`]
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
        ],
      };
    },
  });
}
