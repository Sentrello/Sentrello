import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, gte, inArray, schema } from "@sentrello/db";
import { RATE_SCALE, toBaseCents } from "@sentrello/db/currency";
import type { ModuleContext } from "@sentrello/module-sdk";

/**
 * The EU distance-selling threshold, watched rather than guessed at.
 *
 * An EU business selling to consumers in other member states charges its own
 * country's VAT — until its cross-border B2C sales pass €10,000 across the
 * union, after which VAT is due in each customer's country instead, normally
 * reported through the Union OSS scheme. The old per-country thresholds are
 * gone; this one figure is the whole rule.
 *
 * A one-person business selling a few hundred euros over a border should not
 * meet OSS machinery on day one, so nothing here changes what an invoice
 * charges. This watches the figures and says, plainly, which side of the
 * line the business is on — the decision to register is theirs, and their
 * accountant's.
 */

/**
 * €10,000, in cents, across the whole EU per calendar year — the current
 * *and* the preceding one both have to stay under it for home-country VAT to
 * keep applying. Article 59c of Directive 2006/112/EC; figure confirmed
 * against the Commission's OSS portal (vat-one-stop-shop.ec.europa.eu),
 * checked 15 September 2026.
 */
export const DISTANCE_SELLING_THRESHOLD_CENTS = 1_000_000;

/** The member states, by the atlas codes company records carry. */
const EU_MEMBERS = new Set([
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
  "EL", // Greece as the VAT register spells it, for the record typed that way
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

const euCountry = (raw: string | null | undefined): string | null => {
  const code = raw?.trim().toUpperCase() ?? "";
  if (!EU_MEMBERS.has(code)) return null;
  return code === "EL" ? "GR" : code;
};

export interface DistanceSalesPosition {
  /** False for a seller outside the EU — the threshold is not theirs. */
  applies: boolean;
  /** The organisation's base currency; the sums below are in its cents. */
  currency?: string;
  yearCents?: number;
  priorYearCents?: number;
  /** Null when the base currency is not the euro — see below. */
  thresholdCents?: number | null;
  exceeded?: boolean | null;
}

/**
 * Where the business stands against the threshold, from its own invoices.
 *
 * What counts: invoices to customers in *other* member states with no VAT
 * number on record — no registration is what makes the sale B2C for VAT.
 * Credit notes subtract. Sums are net of VAT, because the directive counts
 * the value of the supplies.
 *
 * What cannot be counted is stated rather than hidden: a customer saved only
 * as a person has no country here (addresses live on company records), so
 * the figure is a floor. The nine member states outside the euro state the
 * threshold in their own currency; for a base currency other than EUR the
 * totals are reported and the comparison left open, with the threshold null.
 */
export async function distanceSalesPosition(
  orgId: string,
  now: Date = new Date(),
): Promise<DistanceSalesPosition> {
  const [org] = await db
    .select({
      countryCode: schema.organizations.countryCode,
      baseCurrency: schema.organizations.baseCurrency,
    })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId))
    .limit(1);

  const seller = euCountry(org?.countryCode);
  if (!seller) return { applies: false };

  const priorYearStart = new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1));
  const rows = await db
    .select({
      kind: schema.invoices.kind,
      issueDate: schema.invoices.issueDate,
      subtotalCents: schema.invoices.subtotalCents,
      discountCents: schema.invoices.discountCents,
      rateMicro: schema.invoices.rateMicro,
      buyerCountry: schema.companies.country,
      buyerTaxId: schema.companies.taxIdentifier,
    })
    .from(schema.invoices)
    .innerJoin(
      schema.contacts,
      eq(schema.invoices.contactId, schema.contacts.id),
    )
    .innerJoin(
      schema.companies,
      eq(schema.contacts.companyId, schema.companies.id),
    )
    .where(
      and(
        eq(schema.invoices.organizationId, orgId),
        // The same fence twice over: a contact or company row reattached
        // across organisations must not put a stranger's sales in the sum.
        eq(schema.contacts.organizationId, orgId),
        eq(schema.companies.organizationId, orgId),
        inArray(schema.invoices.status, ["open", "partial", "paid"]),
        gte(schema.invoices.issueDate, priorYearStart),
      ),
    );

  let yearCents = 0;
  let priorYearCents = 0;
  for (const row of rows) {
    const buyer = euCountry(row.buyerCountry);
    if (!buyer || buyer === seller) continue; // domestic or outside the EU
    if (row.buyerTaxId?.trim()) continue; // registered: B2B, not distance selling

    const net = toBaseCents(
      row.subtotalCents - row.discountCents,
      row.rateMicro ?? RATE_SCALE,
    );
    const signed = row.kind === "credit_note" ? -net : net;
    if (row.issueDate.getUTCFullYear() === now.getUTCFullYear()) {
      yearCents += signed;
    } else {
      priorYearCents += signed;
    }
  }

  const inEuros = (org?.baseCurrency ?? "USD") === "EUR";
  return {
    applies: true,
    currency: org?.baseCurrency ?? "USD",
    yearCents,
    priorYearCents,
    thresholdCents: inEuros ? DISTANCE_SELLING_THRESHOLD_CENTS : null,
    exceeded: inEuros
      ? yearCents > DISTANCE_SELLING_THRESHOLD_CENTS ||
        priorYearCents > DISTANCE_SELLING_THRESHOLD_CENTS
      : null,
  };
}

export function registerDistanceSelling(ctx: ModuleContext) {
  ctx.app.get(
    "/api/invoicing/distance-sales",
    requireSession(),
    requirePermission({ invoicing: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const position = await distanceSalesPosition(orgId);
      return c.json({
        ...position,
        advice: !position.applies
          ? null
          : position.exceeded
            ? "Cross-border sales to EU consumers have passed the €10,000 EU-wide threshold: VAT is due in each customer's country. The Union OSS scheme reports it all through your own country's portal — talk to your accountant about registering."
            : position.exceeded === false
              ? "Cross-border sales to EU consumers are under the €10,000 EU-wide threshold in both this year and last, so your own country's VAT applies to them."
              : "Your base currency is not the euro, so compare these totals with the threshold in your member state's own currency.",
      });
    },
  );
}
