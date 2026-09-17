import type { CustomField } from "@sentrello/module-sdk/custom-fields";
import { coerceCustomValues } from "@sentrello/module-sdk/custom-fields";
import { type SQL, and, eq, inArray, sql } from "drizzle-orm";
import { db } from "./client";
import * as schema from "./schema";

/**
 * The extra fields a business keeps on its contacts, companies and deals.
 *
 * Read from the same `crmSettings` row the pipeline lives on, and needed by
 * both halves of the CRM: the Free side stores the values on every record it
 * writes, the paid side owns defining the fields, and neither package imports
 * the other. The rule that matters is the platform's, in the module SDK's
 * `coerceCustomValues`: a value is only ever written against a field somebody
 * defined.
 */
export const CRM_SUBJECTS = ["contact", "company", "deal"] as const;

/** The definitions this business has, or none. */
export async function crmFieldsFor(
  organizationId: string,
): Promise<CustomField[]> {
  const [row] = await db
    .select({ customFields: schema.crmSettings.customFields })
    .from(schema.crmSettings)
    .where(eq(schema.crmSettings.organizationId, organizationId))
    .limit(1);
  return row?.customFields ?? [];
}

/**
 * The values on one record, checked against what the business defined.
 *
 * Anything without a definition is dropped rather than kept "just in case".
 * The body of a request is not a schema, and without this any caller could
 * write any key onto any contact for ever.
 */
export async function crmValues(
  organizationId: string,
  subject: (typeof CRM_SUBJECTS)[number],
  input: unknown,
): Promise<Record<string, string | number | boolean | null>> {
  if (input === undefined) return {};
  return coerceCustomValues(await crmFieldsFor(organizationId), subject, input);
}

/**
 * Whether a contact is reachable at an address — primary or otherwise.
 *
 * A contact carries one address on the record and a list beside it, and the
 * list is where a work address, an accounts inbox and the address somebody
 * was merged in under end up. Asking only the primary column answers "whose
 * email is this?" wrongly in two ways, and both reach customers:
 *
 * - Mail to a secondary address matches nobody, and the miss looks exactly
 *   like mail from a stranger, so nothing in the product says it happened.
 * - Merging two contacts turns one primary into a secondary, so a thread that
 *   was on the record yesterday is silently missing today.
 *
 * Three places answered this question and three answered it differently: the
 * subject-access search read the list, inbound mail read the primary column in
 * JavaScript over every contact in the business, and the form handler compared
 * the primary column exactly — so `Jane@Example.com` made a second contact
 * beside `jane@example.com`. One condition now, case-insensitive, matched in
 * the database.
 *
 * A condition rather than a query, because the callers want different things
 * around it: one wants it beside a name and a phone number in an `or`, one
 * wants the first row, one wants any of several addresses off one message.
 */
export function contactHasEmail(email: string): SQL {
  return sql`(
    lower(${schema.contacts.email}) = lower(${email})
    or exists (
      select 1
        from jsonb_array_elements(coalesce(${schema.contacts.emails}, '[]'::jsonb)) e
       where lower(e->>'value') = lower(${email})
    )
  )`;
}

/**
 * The names of the contacts on one page of anything.
 *
 * Every list that shows a customer's name needs this, and each of them used to
 * do it by fetching the whole contacts table into the browser and looking
 * names up there. That works until a business has more customers than the
 * unpaged ceiling, at which point the name quietly becomes blank for everybody
 * past the first thousand — sorted, so it is always the same people.
 *
 * One query for the page, keyed by the ids already in hand. Organization-
 * scoped, so a row that somehow names another business's contact resolves to
 * nothing rather than to their customer.
 */
export async function contactNames(
  organizationId: string,
  ids: (string | null)[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!wanted.length) return new Map();
  const rows = await db
    .select({ id: schema.contacts.id, name: schema.contacts.name })
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.organizationId, organizationId),
        inArray(schema.contacts.id, wanted),
      ),
    );
  return new Map(rows.map((row) => [row.id, row.name]));
}
