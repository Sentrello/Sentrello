import { and, eq, gte, inArray, like, lte, or } from "drizzle-orm";
import { db } from "./client";
import { RATE_SCALE, toBaseCents } from "./currency";
import { type LedgerRow, ledgerRows } from "./ledger";
import * as schema from "./schema";

/**
 * Canadian sales tax returns, computed from the ledger.
 *
 * Canada is not one return. A business anywhere in the country files GST/HST
 * federally with the CRA; a business in British Columbia, Saskatchewan or
 * Manitoba files its province's own retail sales tax **separately**, to the
 * province; and a business in Quebec files QST with Revenu Québec — which
 * also administers that business's GST, on the same combined form, but the
 * two remain two taxes with two nets. One return with more boxes would be
 * wrong; this produces one return per authority.
 *
 * The dividing line that decides everything here is **recoverability**.
 * GST/HST paid on business purchases comes back as an input tax credit, and
 * QST comes back the same way as an input tax refund — so both returns have
 * a purchases side, and the net is collected minus recovered. PST does not
 * come back: what a business pays its own suppliers in PST is part of what
 * the thing cost, and a PST return reports what was collected, full stop.
 * Treating PST as recoverable would understate what is owed to the province
 * and overstate nothing anywhere it could be caught before an audit.
 *
 * **This computes; it does not file.** CRA NETFILE, My Business Account and
 * the provincial eTax portals are typed into by a person, and the figures
 * deserve to be seen and checked before that happens — the same reasoning
 * as the UK return, which this deliberately mirrors: every figure is read
 * from the ledger at the moment it is asked for, never from a running tally
 * that can drift from the books.
 *
 * Form shapes were checked against the sources on **15 September 2026**:
 * the CRA's "Complete and file a GST/HST return" (canada.ca) for lines 101,
 * 103–109, 110, 111, 205 and 405; Revenu Québec's FPZ-500-V for the QST
 * lines 201, 203–209 that mirror them; British Columbia's Guide to
 * completing the PST return (gov.bc.ca, form FIN 400) for boxes A–K;
 * Saskatchewan's PST return instructions (sets.saskatchewan.ca); and
 * Manitoba's RST bulletin 004 (gov.mb.ca). These change; the date travels
 * with the figures wherever they are shown.
 */

/** The account code a definition's collected tax is carried on. */
export const caTaxAccountCode = (definitionId: string): string =>
  `2200-${definitionId.slice(0, 8)}`;

export interface CaTaxDefinition {
  id: string;
  name: string;
  /** "CA", "CA-ON", "CA-QC", "CA-BC" — the authority the tax is owed to. */
  jurisdiction: string | null;
  recoverable: boolean;
}

/** Which authority's return a Canadian tax belongs on. */
export type CaReturnKind = "gst-hst" | "qst" | "pst";

/**
 * Classified from what the definition already says, not from its name.
 *
 * A non-recoverable Canadian tax is a provincial retail sales tax — BC's and
 * Saskatchewan's PST, Manitoba's RST — filed to its province. A recoverable
 * one in Quebec is QST, administered by Revenu Québec. Every other
 * recoverable one is GST or a province's HST, and they share one federal
 * return: the harmonised provinces differ in rate, never in form.
 */
export function caReturnKind(
  def: Pick<CaTaxDefinition, "jurisdiction" | "recoverable">,
): CaReturnKind {
  if (!def.recoverable) return "pst";
  if (def.jurisdiction === "CA-QC") return "qst";
  return "gst-hst";
}

/** One definition's period movement on the ledger, read entry by entry. */
export interface CaMovement {
  /** Credits less debits inside entries that touch income — collected on
   * sales, with credit notes already subtracted, since a credit note debits
   * the same account inside an entry that debits income. */
  saleCents: number;
  /** Debits less credits inside entries that touch expense — tax paid on
   * purchases, which is an input tax credit only where the tax comes back. */
  purchaseCents: number;
  /** Movements in entries that touch neither — manual adjustments, which
   * keep the account's own reading exactly as the UK return treats them. */
  aloneCreditCents: number;
  aloneDebitCents: number;
}

const emptyMovement = (): CaMovement => ({
  saleCents: 0,
  purchaseCents: 0,
  aloneCreditCents: 0,
  aloneDebitCents: 0,
});

/**
 * Which side of the return a tax movement belongs to is read from the entry
 * it arrived in, exactly as the UK return reads it: the account alone cannot
 * say. GST collected on a sale and GST reclaimed on a purchase are different
 * lines on the same form, and a credit note's debit is a reduction of what
 * was collected — never a purchase credit.
 */
export function caTaxMovements(
  rows: LedgerRow[],
  codes: Map<string, string>,
): Map<string, CaMovement> {
  const entries = new Map<
    string,
    {
      sale: boolean;
      purchase: boolean;
      taxes: Map<string, { credit: number; debit: number }>;
    }
  >();
  for (const row of rows) {
    const entry = entries.get(row.entryId) ?? {
      sale: false,
      purchase: false,
      taxes: new Map<string, { credit: number; debit: number }>(),
    };
    if (row.type === "income") entry.sale = true;
    if (row.type === "expense") entry.purchase = true;
    const definitionId = codes.get(row.code);
    if (definitionId) {
      const tax = entry.taxes.get(definitionId) ?? { credit: 0, debit: 0 };
      tax.credit += row.creditCents;
      tax.debit += row.debitCents;
      entry.taxes.set(definitionId, tax);
    }
    entries.set(row.entryId, entry);
  }

  const movements = new Map<string, CaMovement>();
  for (const entry of entries.values()) {
    for (const [definitionId, tax] of entry.taxes) {
      const movement = movements.get(definitionId) ?? emptyMovement();
      if (entry.sale) {
        movement.saleCents += tax.credit - tax.debit;
      } else if (entry.purchase) {
        movement.purchaseCents += tax.debit - tax.credit;
      } else {
        movement.aloneCreditCents += tax.credit;
        movement.aloneDebitCents += tax.debit;
      }
      movements.set(definitionId, movement);
    }
  }
  return movements;
}

/** One tax's figures, on whichever return it belongs to. */
export interface CaReturnLine {
  definitionId: string;
  name: string;
  jurisdiction: string | null;
  /** The ledger's answer: collected on sales, net of credit notes. */
  collectedCents: number;
  /** The ledger's answer for tax paid on purchases. Always zero for PST —
   * see the class comment; PST paid is cost, and a purchase entry that
   * debits a PST account is a posting to fix, not a credit to claim. */
  paidOnPurchasesCents: number;
  /** The same period's frozen document bands — the reconciliation column.
   * The two agreeing is the check an accountant runs before filing; the two
   * disagreeing is a posting bug surfaced on a screen, not at an audit. */
  documentTaxCents: number;
  documentTaxableCents: number;
}

/**
 * The GST/HST return the CRA asks for — form GST34, and the same lines
 * NETFILE asks for electronically.
 *
 * One federal return covers GST and every harmonised province's HST: the
 * provinces differ in the rate a sale carried, never in the form. Line
 * numbers are the CRA's own, because the person reading this is copying
 * figures onto a form that uses them.
 */
export interface GstHstReturn {
  /** Line 101: total sales and other revenue for the period, excluding
   * GST/HST — taxable, zero-rated and exempt alike. */
  line101SalesCents: number;
  /** Line 105: GST/HST collected or collectible, with adjustments (the
   * paper form's lines 103 + 104). Credit notes are already netted out. */
  line105CollectedCents: number;
  /** Line 108: input tax credits, with adjustments (lines 106 + 107) —
   * GST/HST the business paid on its own purchases, which comes back. */
  line108ItcsCents: number;
  /** Line 109: net tax, line 105 minus line 108. Signed: negative is a
   * refund position, claimed on line 114. */
  line109NetTaxCents: number;
  /** Lines the ledger cannot know, returned as explicit zeros rather than
   * omitted, because the boxes exist on the form and a business they apply
   * to must account for them itself: instalments paid (110), rebates (111),
   * tax on taxable real property purchases (205), other self-assessed
   * GST/HST (405). */
  line110InstalmentsCents: number;
  line111RebatesCents: number;
  line205RealPropertyCents: number;
  line405SelfAssessedCents: number;
  taxes: CaReturnLine[];
}

/**
 * The QST side of Revenu Québec's combined FPZ-500-V.
 *
 * A Quebec business files GST and QST together, to Revenu Québec — but they
 * are two taxes with two nets, and the GST side of that form is the same
 * federal return computed above. This is the QST half, whose lines mirror
 * the federal ones: 201 sales, 205 collected, 208 input tax refunds, 209
 * net. An ITR is to QST exactly what an ITC is to GST.
 */
export interface QstReturn {
  line201SalesCents: number;
  line205CollectedCents: number;
  line208ItrsCents: number;
  /** Signed, like line 109: negative is a refund position. */
  line209NetTaxCents: number;
  taxes: CaReturnLine[];
}

/**
 * A provincial retail sales tax return — BC's or Saskatchewan's PST,
 * Manitoba's RST. One per province, to that province, and deliberately
 * simple: what was sold, what was collected, what is due. There is no
 * purchases side because the tax is never recovered — that is the fact
 * about PST this whole module exists to keep straight.
 */
export interface PstReturn {
  /** "CA-BC" — the province the return is owed to. */
  jurisdiction: string;
  /** Total sales for the period, excluding tax — BC's box A asks for all
   * sales, taxable and not, and the others ask the same question. */
  salesCents: number;
  /** Collected on sales, net of credit notes and manual adjustments. */
  collectedCents: number;
  /** What is due before the province's own reductions — the on-time filing
   * commissions are conditional on conduct the ledger cannot see, so they
   * are described in the notes rather than computed here. */
  dueCents: number;
  taxes: CaReturnLine[];
}

export interface CaReturns {
  /** Base-currency cents throughout, like every ledger figure. */
  currency: string;
  /** Null when the business has no definitions of the kind — a business in
   * one province sees its own returns and never meets the machinery for a
   * province it has never charged a cent for. */
  gstHst: GstHstReturn | null;
  qst: QstReturn | null;
  pst: PstReturn[];
}

export interface CaDocumentFigures {
  taxCents: number;
  taxableCents: number;
}

/**
 * The returns, assembled from ledger rows and the definitions they answer
 * to. Pure over its inputs so the arithmetic is testable the way the UK
 * return's is; `caReturnsFor` below reads the database and calls this.
 */
export function caReturns(
  rows: LedgerRow[],
  definitions: CaTaxDefinition[],
  documents: Map<string, CaDocumentFigures> = new Map(),
  currency = "CAD",
): CaReturns {
  const codes = new Map<string, string>();
  for (const def of definitions) codes.set(caTaxAccountCode(def.id), def.id);
  const movements = caTaxMovements(rows, codes);

  /*
   * Total sales and other revenue, excluding tax — which the income accounts
   * already are, because tax posts to its own liability accounts. Income is
   * credited when earned; a debit against it is a credit note and reduces
   * the figure. The federal line 101, Quebec's 201 and BC's box A all ask
   * this same question, so it is computed once.
   */
  const salesCents = rows
    .filter((row) => row.type === "income")
    .reduce((sum, row) => sum + row.creditCents - row.debitCents, 0);

  const lineFor = (def: CaTaxDefinition): CaReturnLine => {
    const movement = movements.get(def.id) ?? emptyMovement();
    const doc = documents.get(def.id) ?? { taxCents: 0, taxableCents: 0 };
    if (!def.recoverable) {
      /*
       * PST: collected on sales, adjusted by anything posted by hand. A
       * purchase entry that debits a PST account is ignored on purpose —
       * counting it as recovered would understate what the province is
       * owed, and PST on a purchase belongs in the purchase's cost.
       */
      return {
        definitionId: def.id,
        name: def.name,
        jurisdiction: def.jurisdiction,
        collectedCents:
          movement.saleCents +
          movement.aloneCreditCents -
          movement.aloneDebitCents,
        paidOnPurchasesCents: 0,
        documentTaxCents: doc.taxCents,
        documentTaxableCents: doc.taxableCents,
      };
    }
    return {
      definitionId: def.id,
      name: def.name,
      jurisdiction: def.jurisdiction,
      collectedCents: movement.saleCents + movement.aloneCreditCents,
      paidOnPurchasesCents: movement.purchaseCents + movement.aloneDebitCents,
      documentTaxCents: doc.taxCents,
      documentTaxableCents: doc.taxableCents,
    };
  };

  const byKind = new Map<CaReturnKind, CaReturnLine[]>();
  for (const def of definitions) {
    const kind = caReturnKind(def);
    const lines = byKind.get(kind) ?? [];
    lines.push(lineFor(def));
    byKind.set(kind, lines);
  }

  const sum = (lines: CaReturnLine[], pick: (l: CaReturnLine) => number) =>
    lines.reduce((total, line) => total + pick(line), 0);

  let gstHst: GstHstReturn | null = null;
  const gstLines = byKind.get("gst-hst");
  if (gstLines) {
    const collected = sum(gstLines, (l) => l.collectedCents);
    const itcs = sum(gstLines, (l) => l.paidOnPurchasesCents);
    gstHst = {
      line101SalesCents: salesCents,
      line105CollectedCents: collected,
      line108ItcsCents: itcs,
      line109NetTaxCents: collected - itcs,
      line110InstalmentsCents: 0,
      line111RebatesCents: 0,
      line205RealPropertyCents: 0,
      line405SelfAssessedCents: 0,
      taxes: gstLines,
    };
  }

  let qst: QstReturn | null = null;
  const qstLines = byKind.get("qst");
  if (qstLines) {
    const collected = sum(qstLines, (l) => l.collectedCents);
    const itrs = sum(qstLines, (l) => l.paidOnPurchasesCents);
    qst = {
      line201SalesCents: salesCents,
      line205CollectedCents: collected,
      line208ItrsCents: itrs,
      line209NetTaxCents: collected - itrs,
      taxes: qstLines,
    };
  }

  /*
   * One PST return per province: what BC is owed and what Manitoba is owed
   * are two returns to two governments, even when one business owes both.
   */
  const pstByProvince = new Map<string, CaReturnLine[]>();
  for (const line of byKind.get("pst") ?? []) {
    const jurisdiction = line.jurisdiction ?? "CA";
    const lines = pstByProvince.get(jurisdiction) ?? [];
    lines.push(line);
    pstByProvince.set(jurisdiction, lines);
  }
  const pst: PstReturn[] = [...pstByProvince.entries()]
    .map(([jurisdiction, lines]) => {
      const collected = sum(lines, (l) => l.collectedCents);
      return {
        jurisdiction,
        salesCents,
        collectedCents: collected,
        dueCents: collected,
        taxes: lines,
      };
    })
    .sort((a, b) => a.jurisdiction.localeCompare(b.jurisdiction));

  return { currency, gstHst, qst, pst };
}

/**
 * The returns for a period, read from the database: the business's Canadian
 * tax definitions, the ledger rows, and the frozen document bands that make
 * the reconciliation column. Everything is scoped to the organization, both
 * in the queries and in the rows they join to.
 */
export async function caReturnsFor(
  orgId: string,
  period: { from?: Date; to?: Date } = {},
): Promise<CaReturns> {
  const definitionRows = await db
    .select({
      id: schema.taxDefinitions.id,
      name: schema.taxDefinitions.name,
      jurisdiction: schema.taxDefinitions.jurisdiction,
      recoverable: schema.taxDefinitions.recoverable,
    })
    .from(schema.taxDefinitions)
    .where(
      and(
        eq(schema.taxDefinitions.organizationId, orgId),
        or(
          eq(schema.taxDefinitions.regime, "ca"),
          eq(schema.taxDefinitions.jurisdiction, "CA"),
          like(schema.taxDefinitions.jurisdiction, "CA-%"),
        ),
      ),
    );
  if (definitionRows.length === 0) {
    return { currency: "CAD", gstHst: null, qst: null, pst: [] };
  }

  const [org] = await db
    .select({ baseCurrency: schema.organizations.baseCurrency })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId))
    .limit(1);

  const rows = await ledgerRows(orgId, period);

  /*
   * The document side: every band of Canadian tax on an invoice issued in
   * the period, converted at each document's own stored rate. Credit notes
   * subtract — a credited sale is tax the business no longer owes — which is
   * the same reading the ledger side gets from the reversal entry, so the
   * two columns measure one truth two ways.
   */
  const bands = await db
    .select({
      definitionId: schema.documentTaxes.taxDefinitionId,
      taxableCents: schema.documentTaxes.taxableCents,
      taxCents: schema.documentTaxes.taxCents,
      kind: schema.invoices.kind,
      rateMicro: schema.invoices.rateMicro,
    })
    .from(schema.documentTaxes)
    .innerJoin(
      schema.invoices,
      eq(schema.documentTaxes.documentId, schema.invoices.id),
    )
    .where(
      and(
        eq(schema.documentTaxes.organizationId, orgId),
        eq(schema.documentTaxes.documentType, "invoice"),
        eq(schema.invoices.organizationId, orgId),
        inArray(
          schema.documentTaxes.taxDefinitionId,
          definitionRows.map((d) => d.id),
        ),
        inArray(schema.invoices.status, ["open", "partial", "paid"]),
        ...(period.from ? [gte(schema.invoices.issueDate, period.from)] : []),
        ...(period.to ? [lte(schema.invoices.issueDate, period.to)] : []),
      ),
    );

  const documents = new Map<string, CaDocumentFigures>();
  for (const band of bands) {
    if (!band.definitionId) continue;
    const sign = band.kind === "credit_note" ? -1 : 1;
    const rate = band.rateMicro ?? RATE_SCALE;
    const doc = documents.get(band.definitionId) ?? {
      taxCents: 0,
      taxableCents: 0,
    };
    doc.taxCents += sign * toBaseCents(band.taxCents, rate);
    doc.taxableCents += sign * toBaseCents(band.taxableCents, rate);
    documents.set(band.definitionId, doc);
  }

  return caReturns(rows, definitionRows, documents, org?.baseCurrency ?? "CAD");
}
