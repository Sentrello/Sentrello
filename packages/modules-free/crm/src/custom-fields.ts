import { db, eq, schema } from "@sentrello/db";
import {
  type CustomField,
  type FieldSubject,
  type FieldType,
  coerceCustomValues as coerce,
  fieldId,
  parseCustomFields as parse,
} from "@sentrello/module-sdk";

/**
 * The CRM's own custom fields, which are the platform's with three subjects.
 *
 * The rules themselves live in the module SDK: a plumber's "boiler model" on a
 * contact and a bookkeeper's purchase-order number on a bill are the same
 * feature, and two copies of the coercion is two places for a number field to
 * start holding the string a browser sent.
 *
 * What stays here is the list of things the CRM has records for. Nothing else
 * should know that.
 */
export const CRM_SUBJECTS = ["contact", "company", "deal"] as const;

export type { CustomField, FieldSubject, FieldType };
export { fieldId, coerce as coerceCustomValues };

export function parseCustomFields(input: unknown): CustomField[] {
  return parse(input, [...CRM_SUBJECTS]);
}

/**
 * The definitions this business has, or none.
 *
 * Reading them stays with the module that owns the table. The SDK holds the
 * rules about what a field is and what a value may be, and knows nothing about
 * where any particular module keeps them.
 */
export async function customFieldsFor(orgId: string): Promise<CustomField[]> {
  const [row] = await db
    .select({ customFields: schema.crmSettings.customFields })
    .from(schema.crmSettings)
    .where(eq(schema.crmSettings.organizationId, orgId))
    .limit(1);
  return row?.customFields ?? [];
}
