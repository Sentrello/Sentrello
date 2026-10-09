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
import {
  entryDayWithin,
  ledgerRows,
  periodFrom,
  unbandedSalesTaxCents,
} from "@sentrello/db/ledger";
import { timezoneFor } from "@sentrello/db/timezone";
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
  /**
   * Sales tax collected in the period that names no jurisdiction.
   *
   * The Shop's, in practice: one blended rate per place and no tax
   * definition, so it posts to the shared account and none of the figures
   * above can see it. Stated so a business adds it by hand rather than
   * filing short.
   */
  unbandedCents: number;
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
        inArray(schema.invoices.status, [
          "open",
          "partial",
          "paid",
          "credited",
        ]),
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
  /*
   * Every US definition's account, not only the ones an invoice used.
   *
   * This read the accounts of definitions found in invoice bands, so a sale
   * through the Shop or the till — posted to its state's own account since 8
   * October, with no invoice behind it — was in no jurisdiction at all, and
   * no longer counted as unassigned either.
   */
  const usDefinitions = await db
    .select({
      id: schema.taxDefinitions.id,
      jurisdiction: schema.taxDefinitions.jurisdiction,
      name: schema.taxDefinitions.name,
      ratePpm: schema.taxDefinitions.ratePpm,
      rateBp: schema.taxDefinitions.rateBp,
    })
    .from(schema.taxDefinitions)
    .where(
      and(
        eq(schema.taxDefinitions.organizationId, orgId),
        or(
          eq(schema.taxDefinitions.regime, "us"),
          like(schema.taxDefinitions.jurisdiction, "US-%"),
        ),
        isNotNull(schema.taxDefinitions.jurisdiction),
      ),
    );
  const wantedCodes = new Map<
    string,
    { jurisdiction: string; name: string; ratePpm: number }
  >();
  for (const def of usDefinitions) {
    if (!def.jurisdiction) continue;
    wantedCodes.set(`2200-${def.id.slice(0, 8)}`, {
      jurisdiction: def.jurisdiction.toUpperCase(),
      name: def.name,
      ratePpm: def.ratePpm ?? def.rateBp * 100,
    });
  }
  /*
   * `from` and `to` name days by their UTC dates, as the documents above store
   * theirs, and the ledger is read on each entry's own day where the business
   * is (`entryDay`) — a bill dated the 1st is the 1st in New York.
   */
  const zone = await timezoneFor(orgId);
  if (wantedCodes.size > 0) {
    const movements = await db
      .select({
        code: schema.accounts.code,
        source: schema.journalEntries.source,
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
          entryDayWithin({ from, to }, zone),
        ),
      );
    for (const line of movements) {
      const def = wantedCodes.get(line.code);
      if (!def) continue;
      const entry = byJurisdiction.get(def.jurisdiction) ?? {
        jurisdiction: def.jurisdiction,
        names: [],
        taxableCents: 0,
        taxCents: 0,
        ledgerTaxCents: 0,
        definitionIds: new Set<string>(),
      };
      const net = line.creditCents - line.debitCents;
      entry.ledgerTaxCents += net;
      /*
       * A Shop or till sale has no invoice and so no band: its own entries are
       * the document. Its tax is what it posted, and its taxable sales are
       * that tax at the definition's rate — a sale, a refund taking a share
       * back, a discount at the till taking its tax with it.
       */
      if (/^(shop-|pos-)/.test(line.source ?? "")) {
        entry.taxCents += net;
        if (def.ratePpm > 0) {
          entry.taxableCents += Math.round((net * 1_000_000) / def.ratePpm);
        }
        if (!entry.names.includes(def.name)) entry.names.push(def.name);
      }
      byJurisdiction.set(def.jurisdiction, entry);
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
        inArray(schema.invoices.status, [
          "open",
          "partial",
          "paid",
          "credited",
        ]),
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

  /*
   * Tax this return cannot see, stated rather than dropped.
   *
   * Every figure above comes from a tax definition's own account, because a
   * filing needs to know which jurisdiction a cent belongs to. A Shop or till
   * sale names its state's tax from where it was made, since 8 October, so it
   * is above. What is still on the shared account is tax nothing could name —
   * a sale with no state, or one posted before then — and it is read
   * separately and named. Not folded into a jurisdiction: guessing which one
   * it belongs to would be worse than saying so. Found 2026-09-28.
   */
  const unbandedCents = unbandedSalesTaxCents(
    await ledgerRows(orgId, { from, to }),
  );

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
    /** Sales tax on the shared account, which names no jurisdiction. */
    unbandedCents,
  };
}

export function registerUsFiling(ctx: ModuleContext) {
  ctx.app.get(
    "/api/invoicing/us-filing",
    requireSession(),
    requirePermission({ invoicing: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      /*
       * `periodFrom`, not two `new Date(...)` calls.
       *
       * "to=2026-03-31" read as an instant is midnight, and the period's last
       * day was then excluded from both columns of the return — the documents
       * and the ledger agreed with each other and both understated the
       * quarter by a day's sales, which is the hardest kind of wrong figure
       * to notice. The shared parser stretches a bare date to the whole of
       * it, which is what somebody typing a quarter end means.
       */
      const { from, to } = periodFrom((name) => c.req.query(name));
      if (!from || !to) {
        return c.json(
          { error: "which period? from and to are both required dates" },
          400,
        );
      }
      return c.json(await usFilingReport(orgId, from, to));
    },
  );
}
