import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, gte, inArray, lte, schema } from "@sentrello/db";
import { record } from "@sentrello/db/security-events";
import type {
  ModuleContext,
  RouteContext,
  SentrelloEnv,
} from "@sentrello/module-sdk";
import { secrets } from "@sentrello/module-sdk";
import type { MiddlewareHandler } from "hono";

/**
 * What a US business has to tell the IRS about who it paid.
 *
 * Pay an unincorporated contractor $600 or more in a calendar year and a
 * 1099-NEC is due for them by the end of January. A business that has not
 * collected the contractor's legal name, taxpayer number and address by then
 * spends the month chasing people who have moved on — which is why this is
 * asked for when the supplier is set up, not when the form is due.
 *
 * Three rules decide what counts, and each of them is a wrong return if it is
 * missed:
 *
 *  - **Only what was actually paid in the calendar year.** A bill dated in
 *    December and paid in January is next year's form. This is a cash-basis
 *    question regardless of how the business keeps its books.
 *  - **Card and third-party payments do not count.** The processor reports
 *    those on a 1099-K, and a business that reports them too has the
 *    contractor's income declared twice by two different filers.
 *  - **Corporations are not reported**, with exceptions this does not attempt
 *    to guess at — the business says who is reportable, and the default for a
 *    supplier nobody has said anything about is that they are not.
 */
export const THRESHOLD_CENTS = 60_000;

/**
 * Payment methods the payer does not report.
 *
 * Anything settled by card or through a payment network is on the processor's
 * 1099-K. Matched on what the payment says it was, and deliberately generous:
 * a business that mis-typed "Card" is better served by a name it recognises
 * than by a form that double-reports somebody's income.
 */
const THIRD_PARTY = ["card", "credit-card", "stripe", "paypal", "square"];

export function registerContractors(
  ctx: ModuleContext,
  proOnly: MiddlewareHandler<SentrelloEnv>,
) {
  ctx.app.get(
    "/api/contractors",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const rows = await db
        .select()
        .from(schema.contractorTaxDetails)
        .where(eq(schema.contractorTaxDetails.organizationId, orgId));

      return c.json({
        contractors: rows.map((row) => ({
          contactId: row.contactId,
          reportable: row.reportable,
          legalName: row.legalName,
          entityType: row.entityType,
          // The number itself never leaves the database. Whether one is on
          // file, and its last four, is everything a screen needs.
          hasTaxId: Boolean(row.taxId),
          taxIdLast4: row.taxIdLast4,
          addressLine1: row.addressLine1,
          addressLine2: row.addressLine2,
          city: row.city,
          region: row.region,
          postalCode: row.postalCode,
          country: row.country,
        })),
      });
    },
  );

  ctx.app.put(
    "/api/contractors/:contactId",
    requireSession(),
    requirePermission({ bookkeeping: ["update"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const contactId = c.req.param("contactId") ?? "";

      const [contact] = await db
        .select({ id: schema.contacts.id })
        .from(schema.contacts)
        .where(
          and(
            eq(schema.contacts.id, contactId),
            eq(schema.contacts.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!contact) return c.json({ error: "not found" }, 404);

      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      /**
       * The number, if one was sent.
       *
       * Left alone when the field is absent, so a screen that shows the last
       * four and never the whole number can save an address change without
       * wiping the identification it was never given.
       */
      const raw = body.taxId === undefined ? null : String(body.taxId ?? "");
      const digits = raw === null ? null : raw.replace(/\D/g, "");
      if (digits !== null && digits !== "" && digits.length !== 9) {
        // A TIN is nine digits, whatever punctuation somebody typed around it.
        return c.json({ error: "a taxpayer number is nine digits" }, 400);
      }

      const values = {
        organizationId: orgId,
        contactId,
        reportable: body.reportable !== false,
        legalName: text(body.legalName, 120),
        entityType: text(body.entityType, 40),
        addressLine1: text(body.addressLine1, 120),
        addressLine2: text(body.addressLine2, 120),
        city: text(body.city, 80),
        region: text(body.region, 80),
        postalCode: text(body.postalCode, 20),
        country: text(body.country, 2) ?? "US",
        updatedAt: new Date(),
        ...(digits
          ? { taxId: secrets.seal(digits), taxIdLast4: digits.slice(-4) }
          : {}),
        // An empty string is a deliberate clearing; absent is "leave it".
        ...(digits === "" ? { taxId: null, taxIdLast4: null } : {}),
      };

      await db
        .insert(schema.contractorTaxDetails)
        .values(values)
        .onConflictDoUpdate({
          target: [
            schema.contractorTaxDetails.organizationId,
            schema.contractorTaxDetails.contactId,
          ],
          set: values,
        });

      if (digits) {
        /**
         * Written down, because somebody handled a social security number.
         *
         * For most sole traders a TIN *is* their SSN. Who put one on file and
         * when is exactly the kind of thing a business has to be able to
         * answer afterwards.
         */
        await record({
          organizationId: orgId,
          actor: c.get("session").user,
          action: "contractor.tax-id.set",
          detail: { contactId, last4: digits.slice(-4) },
        });
      }

      return c.json({ ok: true });
    },
  );

  /**
   * The figures a 1099-NEC is filled in from.
   *
   * Not a filing — nothing here sends anything to the IRS — but every number
   * that goes on the form, per contractor, with what it was made of so a
   * bookkeeper can check it rather than trust it.
   */
  ctx.app.get(
    "/api/reports/1099",
    requireSession(),
    requirePermission({ reports: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const year = Number(c.req.query("year") ?? new Date().getUTCFullYear());
      if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        return c.json({ error: "which calendar year" }, 400);
      }

      const from = new Date(Date.UTC(year, 0, 1));
      const to = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));

      const details = await db
        .select()
        .from(schema.contractorTaxDetails)
        .where(
          and(
            eq(schema.contractorTaxDetails.organizationId, orgId),
            eq(schema.contractorTaxDetails.reportable, true),
          ),
        );
      if (details.length === 0) {
        return c.json({ year, thresholdCents: THRESHOLD_CENTS, rows: [] });
      }
      const contactIds = details.map((row) => row.contactId);

      /**
       * Bills paid inside the year, to a supplier we report on.
       *
       * The bill says who; the payment says when and how much. A bill raised
       * in December and paid in January belongs to the January year, which is
       * the whole reason this reads payments rather than bills.
       */
      const billPaid = await db
        .select({
          contactId: schema.bills.vendorId,
          amountCents: schema.billPayments.amountCents,
          withheldCents: schema.billPayments.withheldCents,
          method: schema.billPayments.method,
          paidAt: schema.billPayments.paidAt,
        })
        .from(schema.billPayments)
        .innerJoin(
          schema.bills,
          eq(schema.bills.id, schema.billPayments.billId),
        )
        .where(
          and(
            eq(schema.billPayments.organizationId, orgId),
            gte(schema.billPayments.paidAt, from),
            lte(schema.billPayments.paidAt, to),
            inArray(schema.bills.vendorId, contactIds),
          ),
        );

      /** And money paid straight out, with no bill behind it. */
      const straight = await db
        .select({
          contactId: schema.transactions.contactId,
          amountCents: schema.transactions.amountCents,
          method: schema.transactions.method,
          paidAt: schema.transactions.occurredAt,
        })
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.organizationId, orgId),
            eq(schema.transactions.kind, "expense"),
            gte(schema.transactions.occurredAt, from),
            lte(schema.transactions.occurredAt, to),
            inArray(schema.transactions.contactId, contactIds),
          ),
        );

      const paid = new Map<string, number>();
      const excluded = new Map<string, number>();
      for (const payment of [
        ...billPaid.map((row) => ({
          contactId: row.contactId,
          // What the contractor was actually paid. Tax kept back is owed to
          // the authority, not to them, and belongs in a different box.
          amountCents: row.amountCents - row.withheldCents,
          method: row.method,
        })),
        ...straight,
      ]) {
        const id = payment.contactId;
        if (!id) continue;
        const bucket = thirdParty(payment.method) ? excluded : paid;
        bucket.set(id, (bucket.get(id) ?? 0) + payment.amountCents);
      }

      const rows = details
        .map((detail) => {
          const totalCents = paid.get(detail.contactId) ?? 0;
          return {
            contactId: detail.contactId,
            legalName: detail.legalName,
            entityType: detail.entityType,
            taxIdLast4: detail.taxIdLast4,
            hasTaxId: Boolean(detail.taxId),
            address: {
              line1: detail.addressLine1,
              line2: detail.addressLine2,
              city: detail.city,
              region: detail.region,
              postalCode: detail.postalCode,
              country: detail.country,
            },
            /** Box 1 on the form: what goes on the 1099-NEC. */
            totalCents,
            /**
             * What was paid by card or through a network, kept apart.
             *
             * Shown rather than hidden: a bookkeeper looking at a contractor
             * they know they paid $5,000 needs to see why the form says
             * $1,200, or they assume the software is wrong.
             */
            excludedCents: excluded.get(detail.contactId) ?? 0,
            reportable: totalCents >= THRESHOLD_CENTS,
            /**
             * What would stop the form being filed.
             *
             * Answered in December, when it can still be fixed, rather than
             * discovered in January.
             */
            missing: [
              ...(detail.taxId ? [] : ["taxpayer number"]),
              ...(detail.legalName ? [] : ["legal name"]),
              ...(detail.addressLine1 && detail.city && detail.region
                ? []
                : ["address"]),
            ],
          };
        })
        .filter((row) => row.totalCents > 0 || row.excludedCents > 0)
        .sort((a, b) => b.totalCents - a.totalCents);

      return c.json({ year, thresholdCents: THRESHOLD_CENTS, rows });
    },
  );
}

/** Whether a payment was made through somebody who reports it themselves. */
function thirdParty(method: string | null): boolean {
  if (!method) return false;
  const said = method.toLowerCase().replace(/[\s_]+/g, "-");
  return THIRD_PARTY.includes(said);
}

/** A trimmed string, or nothing. */
function text(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  const out = String(value).trim().slice(0, max);
  return out === "" ? null : out;
}
