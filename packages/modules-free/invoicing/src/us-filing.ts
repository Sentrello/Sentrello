import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import {
  and,
  db,
  eq,
  gte,
  inArray,
  isNotNull,
  like,
  lte,
  or,
  schema,
} from "@sentrello/db";
import { RATE_SCALE, toBaseCents } from "@sentrello/db/currency";
import type { ModuleContext } from "@sentrello/module-sdk";

/**
 * Filing-ready US sales tax figures: what is owed, where, for a period.
 *
 * A state return asks the same three questions everywhere: what did you
 * sell, how much of it was taxable, and how much tax did you collect —
 * per jurisdiction, because the county's and the district's shares are
 * itemised on the same form. Every figure here is derived, never typed:
 * the taxable and collected amounts come from the tax bands frozen onto
 * each issued document, and beside them stands the same period's movement
 * on that jurisdiction's own liability account — the ledger's answer to
 * the identical question. The two columns agreeing is the check an
 * accountant runs before filing; the two disagreeing is a posting bug
 * surfaced here, on a screen, rather than at an audit.
 *
 * This computes; it does not file. State portals are typed into by a
 * person, and a figure nobody has checked should not be the first draft
 * of a tax return.
 */

export interface JurisdictionFigures {
  /** "US-TX", "US-TX-AUSTIN" — one row per authority, as filed. */
  jurisdiction: string;
  /** The names the business gave the rates, for reading the row. */
  names: string[];
  /** What was taxed at this jurisdiction's rates, in base-currency cents. */
  taxableCents: number;
  /** What was collected for it, from the documents. */
  taxCents: number;
  /** The same period's credits less debits on its liability accounts. */
  ledgerTaxCents: number;
}

export interface ExemptFigures {
  /** The certificate's issuing state. */
  state: string;
  exemptCents: number;
  invoices: number;
}

export interface UsFilingReport {
  from: Date;
  to: Date;
  currency: string;
  jurisdictions: JurisdictionFigures[];
  /** Sales excused by certificate — the "exempt sales" line on the return. */
  exempt: ExemptFigures[];
}

export async function usFilingReport(
  orgId: string,
  from: Date,
  to: Date,
): Promise<UsFilingReport> {
  const [org] = await db
    .select({ baseCurrency: schema.organizations.baseCurrency })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId))
    .limit(1);

  /**
   * The document side: every band of US tax on an invoice issued in the
   * period. Credit notes subtract — a credited sale is tax the business no
   * longer owes. Quotes never appear; nothing was sold.
   */
  const bands = await db
    .select({
      jurisdiction: schema.taxDefinitions.jurisdiction,
      definitionId: schema.taxDefinitions.id,
      name: schema.documentTaxes.name,
      taxableCents: schema.documentTaxes.taxableCents,
      taxCents: schema.documentTaxes.taxCents,
      kind: schema.invoices.kind,
      rateMicro: schema.invoices.rateMicro,
    })
    .from(schema.documentTaxes)
    .innerJoin(
      schema.taxDefinitions,
      eq(schema.documentTaxes.taxDefinitionId, schema.taxDefinitions.id),
    )
    .innerJoin(
      schema.invoices,
      eq(schema.documentTaxes.documentId, schema.invoices.id),
    )
    .where(
      and(
        eq(schema.documentTaxes.organizationId, orgId),
        eq(schema.documentTaxes.documentType, "invoice"),
        eq(schema.invoices.organizationId, orgId),
        or(
          eq(schema.taxDefinitions.regime, "us"),
          like(schema.taxDefinitions.jurisdiction, "US-%"),
        ),
        isNotNull(schema.taxDefinitions.jurisdiction),
        inArray(schema.invoices.status, ["open", "partial", "paid"]),
        gte(schema.invoices.issueDate, from),
        lte(schema.invoices.issueDate, to),
      ),
    );

  const byJurisdiction = new Map<
    string,
    JurisdictionFigures & { definitionIds: Set<string> }
  >();
  for (const band of bands) {
    const jurisdiction = band.jurisdiction?.toUpperCase();
    if (!jurisdiction) continue;
    const sign = band.kind === "credit_note" ? -1 : 1;
    const rate = band.rateMicro ?? RATE_SCALE;
    const entry = byJurisdiction.get(jurisdiction) ?? {
      jurisdiction,
      names: [],
      taxableCents: 0,
      taxCents: 0,
      ledgerTaxCents: 0,
      definitionIds: new Set<string>(),
    };
    entry.taxableCents += sign * toBaseCents(band.taxableCents, rate);
    entry.taxCents += sign * toBaseCents(band.taxCents, rate);
    if (!entry.names.includes(band.name)) entry.names.push(band.name);
    entry.definitionIds.add(band.definitionId);
    byJurisdiction.set(jurisdiction, entry);
  }

  /**
   * The ledger side: each jurisdiction's definitions post to accounts coded
   * "2200-" plus the definition id's first eight characters, so the period's
   * movement on those accounts is the filing figure read straight off the
   * books. Collected on a sale is a credit; a credit note's reversal is a
   * debit; the difference is what is owed for the period.
   */
  const wantedCodes = new Map<string, string>(); // code -> jurisdiction
  for (const entry of byJurisdiction.values()) {
    for (const id of entry.definitionIds) {
      wantedCodes.set(`2200-${id.slice(0, 8)}`, entry.jurisdiction);
    }
  }
  if (wantedCodes.size > 0) {
    const movements = await db
      .select({
        code: schema.accounts.code,
        debitCents: schema.journalLines.debitCents,
        creditCents: schema.journalLines.creditCents,
      })
      .from(schema.journalLines)
      .innerJoin(
        schema.journalEntries,
        eq(schema.journalLines.entryId, schema.journalEntries.id),
      )
      .innerJoin(
        schema.accounts,
        eq(schema.journalLines.accountId, schema.accounts.id),
      )
      .where(
        and(
          eq(schema.journalEntries.organizationId, orgId),
          eq(schema.accounts.organizationId, orgId),
          inArray(schema.accounts.code, [...wantedCodes.keys()]),
          gte(schema.journalEntries.postedAt, from),
          lte(schema.journalEntries.postedAt, to),
        ),
      );
    for (const line of movements) {
      const jurisdiction = wantedCodes.get(line.code);
      if (!jurisdiction) continue;
      const entry = byJurisdiction.get(jurisdiction);
      if (!entry) continue;
      entry.ledgerTaxCents += line.creditCents - line.debitCents;
    }
  }

  /**
   * Exempt sales, by the certificate's issuing state. Returns ask for the
   * figure — "gross sales" minus "taxable sales" has to be accounted for —
   * and each invoice in it points at the certificate that excused it, which
   * is the audit trail the exemption exists to provide.
   */
  const exemptRows = await db
    .select({
      state: schema.exemptionCertificates.state,
      subtotalCents: schema.invoices.subtotalCents,
      discountCents: schema.invoices.discountCents,
      rateMicro: schema.invoices.rateMicro,
      kind: schema.invoices.kind,
    })
    .from(schema.invoices)
    .innerJoin(
      schema.exemptionCertificates,
      eq(
        schema.invoices.exemptionCertificateId,
        schema.exemptionCertificates.id,
      ),
    )
    .where(
      and(
        eq(schema.invoices.organizationId, orgId),
        eq(schema.exemptionCertificates.organizationId, orgId),
        inArray(schema.invoices.status, ["open", "partial", "paid"]),
        gte(schema.invoices.issueDate, from),
        lte(schema.invoices.issueDate, to),
      ),
    );
  const exemptByState = new Map<string, ExemptFigures>();
  for (const row of exemptRows) {
    const entry = exemptByState.get(row.state) ?? {
      state: row.state,
      exemptCents: 0,
      invoices: 0,
    };
    const net = toBaseCents(
      row.subtotalCents - row.discountCents,
      row.rateMicro ?? RATE_SCALE,
    );
    entry.exemptCents += row.kind === "credit_note" ? -net : net;
    if (row.kind !== "credit_note") entry.invoices += 1;
    exemptByState.set(row.state, entry);
  }

  return {
    from,
    to,
    currency: org?.baseCurrency ?? "USD",
    jurisdictions: [...byJurisdiction.values()]
      .map(({ definitionIds: _, ...figures }) => figures)
      .sort((a, b) => a.jurisdiction.localeCompare(b.jurisdiction)),
    exempt: [...exemptByState.values()].sort((a, b) =>
      a.state.localeCompare(b.state),
    ),
  };
}

export function registerUsFiling(ctx: ModuleContext) {
  ctx.app.get(
    "/api/invoicing/us-filing",
    requireSession(),
    requirePermission({ invoicing: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const from = new Date(c.req.query("from") ?? "");
      const to = new Date(c.req.query("to") ?? "");
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        return c.json(
          { error: "which period? from and to are both required dates" },
          400,
        );
      }
      return c.json(await usFilingReport(orgId, from, to));
    },
  );
}
