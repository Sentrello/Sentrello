import type { CustomField } from "@sentrello/module-sdk/custom-fields";
import { coerceCustomValues } from "@sentrello/module-sdk/custom-fields";
import { eq } from "drizzle-orm";
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
