import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, eq, schema } from "@sentrello/db";
import {
  type CustomField,
  type ModuleContext,
  type RouteContext,
  type SentrelloEnv,
  coerceCustomValues,
  parseCustomFields,
} from "@sentrello/module-sdk";
import type { MiddlewareHandler } from "hono";

/**
 * The extra things a business keeps on its bills and its money in and out.
 *
 * A purchase-order number, a job reference, which van the fuel went into. None
 * of them is worth a migration and every business wants a different one — and
 * a bookkeeper who cannot record the thing their business is asked about keeps
 * a spreadsheet beside the product, which is the thing this is meant to
 * replace.
 *
 * The rules are the platform's, in the module SDK, and are the same ones the
 * CRM uses. What is here is which records the accounting module has.
 */
export const ACCOUNTING_SUBJECTS = ["bill", "transaction"] as const;

export function registerAccountingCustomFields(
  ctx: ModuleContext,
  proOnly: MiddlewareHandler<SentrelloEnv>,
) {
  ctx.app.get(
    "/api/accounting/custom-fields",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      return c.json({ customFields: await accountingFieldsFor(orgId) });
    },
  );

  ctx.app.put(
    "/api/accounting/custom-fields",
    requireSession(),
    requirePermission({ bookkeeping: ["update"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      let customFields: CustomField[];
      try {
        customFields = parseCustomFields(body.customFields, [
          ...ACCOUNTING_SUBJECTS,
        ]);
      } catch (err) {
        // Said back in the words the person used, not "invalid input": these
        // are their own field names and they are the only one who can fix it.
        return c.json({ error: (err as Error).message }, 400);
      }

      await db
        .insert(schema.ledgerSettings)
        .values({ organizationId: orgId, customFields })
        .onConflictDoUpdate({
          target: schema.ledgerSettings.organizationId,
          // Only the fields. The period lock lives on the same row and is not
          // this screen's to change.
          set: { customFields, updatedAt: new Date() },
        });

      return c.json({ customFields });
    },
  );
}

/** The definitions this business has, or none. */
export async function accountingFieldsFor(
  organizationId: string,
): Promise<CustomField[]> {
  const [row] = await db
    .select({ customFields: schema.ledgerSettings.customFields })
    .from(schema.ledgerSettings)
    .where(eq(schema.ledgerSettings.organizationId, organizationId))
    .limit(1);
  return row?.customFields ?? [];
}

/**
 * The values on one record, checked against what the business defined.
 *
 * Anything without a definition is dropped rather than kept "just in case".
 * The body of a request is not a schema, and without this any caller could
 * write any key onto any bill for ever.
 */
export async function accountingValues(
  organizationId: string,
  subject: (typeof ACCOUNTING_SUBJECTS)[number],
  input: unknown,
): Promise<Record<string, string | number | boolean | null>> {
  if (input === undefined) return {};
  return coerceCustomValues(
    await accountingFieldsFor(organizationId),
    subject,
    input,
  );
}
