import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import {
  and,
  asc,
  db,
  desc,
  eq,
  gte,
  inArray,
  like,
  lt,
  lte,
  or,
  schema,
} from "@sentrello/db";
import { RATE_SCALE } from "@sentrello/db/currency";
import { percentFromPpm } from "@sentrello/db/money";
import { csvDownload, toCsv } from "@sentrello/module-sdk";
import type { ModuleContext } from "@sentrello/module-sdk";
import { euCountry, isConsumerSupply } from "./distance-selling";

/**
 * The EU One Stop Shop return, quarter by quarter: the figures a business
 * copies into its portal.
 *
 * Once cross-border sales to EU consumers pass €10,000 a year, VAT is due at
 * the *customer's* rate in the customer's country — and rather than register
 * in each of them, a business files one Union scheme return through its own
 * member state. We already watch the threshold and say when it has been
 * crossed. This is the other half: having told somebody they have a filing
 * obligation, work out what goes on the filing.
 *
 * **It computes; it does not file.** There is no EU-wide submission API —
 * there are twenty-seven national portals, typed into by a person. Saying so
 * is not modesty, it is the thing that stops a business assuming a deadline
 * was met on its behalf, and it is written on the screen, in the file and in
 * the response rather than only in this comment.
 *
 * What the return asks for, and this produces, is one row per member state of
 * consumption per rate of VAT applied: the taxable amount exclusive of VAT and
 * the VAT due, in euro, and the total. Beside it, corrections — see below —
 * and the date it has to be in by.
 */

/** The VAT liability accounts: the shared one, and the per-definition splits. */
const VAT_ACCOUNT = "2200";

/** Services and goods are separate parts of the return; so are the unknowns. */
export type SupplyType = "goods" | "services" | "unclassified";

export interface OssLine {
  /** The member state of consumption — where the customer is. */
  memberState: string;
  /** The rate actually applied, in millionths. 190,000 is 19%. */
  ratePpm: number;
  supplyType: SupplyType;
  /** Exclusive of VAT, in euro cents. */
  taxableCents: number;
  /** In euro cents. */
  vatCents: number;
}

/**
 * A correction to an earlier quarter, which is its own panel on the return.
 *
 * The original return cannot be amended: a correction goes on a *subsequent*
 * return, naming the member state, the period it relates to, and the VAT being
 * adjusted. So a credit note raised this quarter against last quarter's
 * invoice does not quietly reduce this quarter's supplies — it appears here,
 * pointing at the quarter it belongs to.
 */
export interface OssCorrection {
  memberState: string;
  /** The quarter being corrected, as the portals write it: "2026-Q2". */
  period: string;
  taxableCents: number;
  vatCents: number;
  /**
   * Whether it can still go on a return at all.
   *
   * Corrections are accepted for three years from the date the original return
   * was due. Past that the member state has to be approached directly, and a
   * business needs to hear that from us rather than from a rejected filing.
   */
  withinThreeYears: boolean;
}

export interface OssConversion {
  /** The currency the books are kept in. */
  from: string;
  /** What one euro was worth in it, in millionths. */
  rateMicro: number;
  /** The day that rate was recorded for. */
  asOf: Date;
  /**
   * Whether it is the rate the rules prescribe — the ECB's for the quarter's
   * last day, or the next day it published. False means the nearest earlier
   * one was used because that day's had never been recorded, and the figures
   * are an estimate until it is.
   */
  prescribed: boolean;
}

export interface OssReturn {
  /** False for a seller outside the EU: the Union scheme is not theirs. */
  applies: boolean;
  year: number;
  /** 1–4. */
  quarter: number;
  from: Date;
  to: Date;
  /** The last day of the month after the quarter — return and payment both. */
  dueDate: Date;
  /** Always EUR. OSS returns are filed in euro. */
  currency: "EUR";
  /** Null for a business whose books are already in euro, or see `problem`. */
  conversion: OssConversion | null;
  lines: OssLine[];
  corrections: OssCorrection[];
  totalTaxableCents: number;
  /** Lines and corrections together — what is actually owed for the quarter. */
  totalVatCents: number;
  /** Why there are no figures, where there are none and there should be. */
  problem: string | null;
  /** The sentence that has to be read before anything is typed into a portal. */
  filing: string;
  /** Limits worth knowing before trusting the figures. See the screen. */
  caveats: string[];
}

export const OSS_FILING_NOTICE =
  "This computes your return; it does not file it. Nothing here is sent anywhere. Your OSS return is submitted through your own member state's portal, by you, by the last day of the month after the quarter ends.";

/** The quarter a date falls in, 1–4. */
export function quarterOf(date: Date): number {
  return Math.floor(date.getUTCMonth() / 3) + 1;
}

/**
 * A calendar quarter's bounds and its deadline.
 *
 * The end is the last instant of the quarter rather than the first of the
 * next, because every comparison downstream is inclusive and an exclusive
 * bound written inclusively loses the last day's trading. The due date is the
 * end of the month following — day zero of the month after that, which is how
 * the last day of a month is written without a table of month lengths.
 */
export function quarterBounds(year: number, quarter: number) {
  return {
    from: new Date(Date.UTC(year, (quarter - 1) * 3, 1)),
    to: new Date(Date.UTC(year, quarter * 3, 1) - 1),
    dueDate: new Date(Date.UTC(year, quarter * 3 + 1, 0)),
  };
}

/**
 * Splits a posted total across a document's tax bands in proportion to them.
 *
 * One document can carry two rates — books at 7% beside electronics at 19% —
 * and the ledger holds one figure for the pair. The bands say how it divides;
 * the spare cent goes to the largest, so the reported lines sum to exactly
 * what was posted. A split that does not reconcile is the failure the whole
 * "derive it from the ledger" rule exists to prevent.
 */
function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const parts = weights.map((w) => Math.round((total * w) / sum));
  let biggest = 0;
  for (let i = 1; i < weights.length; i += 1) {
    if ((weights[i] ?? 0) > (weights[biggest] ?? 0)) biggest = i;
  }
  parts[biggest] =
    (parts[biggest] ?? 0) + (total - parts.reduce((a, b) => a + b, 0));
  return parts;
}

/**
 * The euro rate the rules prescribe, or the nearest honest thing to it.
 *
 * Supplies in another currency are converted at the rate the European Central
 * Bank published on the quarter's last day, or the next day it published — so
 * the right row is the *earliest* one recorded on or after that day, which
 * covers both halves of the rule including the quarters that end on a weekend.
 * Failing that, the closest earlier rate, marked as not the prescribed one.
 * Failing that, nothing: converting at whatever rate is lying around produces
 * a return that is plausible, wrong, and signed.
 */
async function euroRate(
  orgId: string,
  lastDay: Date,
): Promise<Omit<OssConversion, "from"> | null> {
  const day = new Date(
    Date.UTC(
      lastDay.getUTCFullYear(),
      lastDay.getUTCMonth(),
      lastDay.getUTCDate(),
    ),
  );
  const [onOrAfter] = await db
    .select({
      rateMicro: schema.exchangeRates.rateMicro,
      asOf: schema.exchangeRates.asOf,
    })
    .from(schema.exchangeRates)
    .where(
      and(
        eq(schema.exchangeRates.organizationId, orgId),
        eq(schema.exchangeRates.code, "EUR"),
        gte(schema.exchangeRates.asOf, day),
      ),
    )
    .orderBy(asc(schema.exchangeRates.asOf))
    .limit(1);
  if (onOrAfter?.rateMicro) return { ...onOrAfter, prescribed: true };

  const [before] = await db
    .select({
      rateMicro: schema.exchangeRates.rateMicro,
      asOf: schema.exchangeRates.asOf,
    })
    .from(schema.exchangeRates)
    .where(
      and(
        eq(schema.exchangeRates.organizationId, orgId),
        eq(schema.exchangeRates.code, "EUR"),
        lt(schema.exchangeRates.asOf, day),
      ),
    )
    .orderBy(desc(schema.exchangeRates.asOf))
    .limit(1);
  if (before?.rateMicro) return { ...before, prescribed: false };
  return null;
}

/** Base-currency cents as euro cents, at what one euro costs. Integers only. */
function toEuroCents(baseCents: number, conversion: OssConversion | null) {
  if (!conversion) return baseCents;
  return Math.round((baseCents * RATE_SCALE) / conversion.rateMicro);
}

interface DocumentFigures {
  memberState: string;
  supplyType: SupplyType;
  netCents: number;
  vatCents: number;
  kind: string;
  referenceInvoiceId: string | null;
}

/**
 * The quarter's return.
 *
 * Every figure is read off posted journal entries. The period is the entries'
 * own posting dates, so a draft nobody issued contributes nothing and a
 * reversal subtracts; the taxable amount is the entry's movement on income and
 * the VAT is its movement on the VAT liability accounts, both already in
 * base-currency cents because the ledger converts on the way in. The documents
 * supply only the classification — which country, which rate, goods or
 * services — because no chart of accounts has ever carried a line called "net
 * sales to Germany at 19%", and a report that recomputed the money from
 * invoice rows could disagree with the books it claims to summarise.
 */
export async function ossReturn(
  orgId: string,
  year: number,
  quarter: number,
): Promise<OssReturn> {
  const { from, to, dueDate } = quarterBounds(year, quarter);
  const [org] = await db
    .select({
      countryCode: schema.organizations.countryCode,
      baseCurrency: schema.organizations.baseCurrency,
    })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId))
    .limit(1);

  const seller = euCountry(org?.countryCode);
  const empty: OssReturn = {
    applies: false,
    year,
    quarter,
    from,
    to,
    dueDate,
    currency: "EUR",
    conversion: null,
    lines: [],
    corrections: [],
    totalTaxableCents: 0,
    totalVatCents: 0,
    problem: null,
    filing: OSS_FILING_NOTICE,
    caveats: [],
  };
  if (!seller) return empty;

  const baseCurrency = org?.baseCurrency ?? "EUR";
  let conversion: OssConversion | null = null;
  if (baseCurrency !== "EUR") {
    const rate = await euroRate(orgId, to);
    if (!rate) {
      return {
        ...empty,
        applies: true,
        problem: `Your books are kept in ${baseCurrency} and an OSS return is filed in euro. Record the European Central Bank euro rate for ${to.toISOString().slice(0, 10)} — the rate the rules prescribe — and this return will compute.`,
      };
    }
    conversion = { from: baseCurrency, ...rate };
  }

  /**
   * The ledger side: every entry raised by a sales document and posted inside
   * the quarter, with its movement on income and on VAT. Credits less debits
   * on both, which gives an invoice a positive figure and a credit note a
   * negative one without anywhere having to ask which it was.
   */
  const lines = await db
    .select({
      source: schema.journalEntries.source,
      type: schema.accounts.type,
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
        gte(schema.journalEntries.postedAt, from),
        lte(schema.journalEntries.postedAt, to),
        or(
          like(schema.journalEntries.source, "invoice:%"),
          like(schema.journalEntries.source, "credit-note:%"),
        ),
      ),
    );

  const posted = new Map<string, { netCents: number; vatCents: number }>();
  for (const line of lines) {
    const documentId = line.source?.split(":")[1];
    if (!documentId) continue;
    const figures = posted.get(documentId) ?? { netCents: 0, vatCents: 0 };
    const movement = line.creditCents - line.debitCents;
    if (line.type === "income") figures.netCents += movement;
    if (line.code === VAT_ACCOUNT || line.code.startsWith(`${VAT_ACCOUNT}-`)) {
      figures.vatCents += movement;
    }
    posted.set(documentId, figures);
  }
  if (posted.size === 0) {
    return { ...empty, applies: true, conversion, caveats: caveatsFor([]) };
  }

  /**
   * The classification side. Which member state and whether the customer is a
   * consumer come from the company record; a customer saved only as a person
   * has no country, so such a sale cannot be placed and is a known floor.
   */
  const documentIds = [...posted.keys()];
  const documents = await db
    .select({
      id: schema.invoices.id,
      kind: schema.invoices.kind,
      referenceInvoiceId: schema.invoices.referenceInvoiceId,
      buyerCountry: schema.companies.country,
      buyerTaxId: schema.companies.taxIdentifier,
      buyerTaxIdValid: schema.companies.taxIdentifierValid,
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
        // The same fence on every join: a contact or company row reattached
        // across organisations must not put a stranger's sales on this return.
        eq(schema.contacts.organizationId, orgId),
        eq(schema.companies.organizationId, orgId),
        inArray(schema.invoices.id, documentIds),
      ),
    );

  const qualifying = new Map<string, DocumentFigures>();
  for (const document of documents) {
    const buyer = euCountry(document.buyerCountry);
    if (!buyer || buyer === seller) continue; // domestic, or outside the EU
    if (!isConsumerSupply(document.buyerTaxId, document.buyerTaxIdValid)) {
      continue; // registered and unrefuted: B2B, taxed where the customer is
    }
    const figures = posted.get(document.id);
    if (!figures) continue;
    qualifying.set(document.id, {
      memberState: buyer,
      supplyType: "unclassified",
      netCents: figures.netCents,
      vatCents: figures.vatCents,
      kind: document.kind,
      referenceInvoiceId: document.referenceInvoiceId,
    });
  }
  if (qualifying.size === 0) {
    return { ...empty, applies: true, conversion, caveats: caveatsFor([]) };
  }

  const ids = [...qualifying.keys()];
  const referenced = [...qualifying.values()]
    .map((d) => d.referenceInvoiceId)
    .filter((id): id is string => Boolean(id));
  const [bands, items, originals] = await Promise.all([
    db
      .select({
        documentId: schema.documentTaxes.documentId,
        rateBp: schema.documentTaxes.rateBp,
        ratePpm: schema.documentTaxes.ratePpm,
        taxableCents: schema.documentTaxes.taxableCents,
        taxCents: schema.documentTaxes.taxCents,
      })
      .from(schema.documentTaxes)
      .where(
        and(
          eq(schema.documentTaxes.organizationId, orgId),
          eq(schema.documentTaxes.documentType, "invoice"),
          inArray(schema.documentTaxes.documentId, ids),
        ),
      ),
    /*
     * Goods or services, from the catalogue — the return has separate parts
     * for them. Only lines that came from a catalogue item can say; a line
     * somebody typed is a description, not a classification.
     *
     * The credited invoices are read too, because a credit note's own line is
     * "Credit against invoice INV-0031" and classifies nothing. Without them a
     * credit note landed in a row of its own beside the sale it reverses, and
     * the return showed the full supply in one part and the credit in another.
     */
    db
      .select({
        invoiceId: schema.invoiceLines.invoiceId,
        kind: schema.billableItems.kind,
      })
      .from(schema.invoiceLines)
      .innerJoin(
        schema.billableItems,
        eq(schema.invoiceLines.billableItemId, schema.billableItems.id),
      )
      .where(
        and(
          eq(schema.billableItems.organizationId, orgId),
          inArray(schema.invoiceLines.invoiceId, [...ids, ...referenced]),
        ),
      ),
    /*
     * When each credited invoice reached the books, which is what decides
     * whether a credit note is this quarter's business or a correction to an
     * earlier return. The ledger's own answer, not the document's date.
     */
    correctedPeriods(orgId, referenced),
  ]);

  const kinds = new Map<string, Set<string>>();
  for (const item of items) {
    const set = kinds.get(item.invoiceId) ?? new Set<string>();
    set.add(item.kind);
    kinds.set(item.invoiceId, set);
  }
  for (const [id, document] of qualifying) {
    const set =
      kinds.get(id) ??
      (document.referenceInvoiceId
        ? kinds.get(document.referenceInvoiceId)
        : undefined);
    if (set?.size === 1) {
      document.supplyType = set.has("product") ? "goods" : "services";
    }
  }

  const bandsByDocument = new Map<string, typeof bands>();
  for (const band of bands) {
    const list = bandsByDocument.get(band.documentId) ?? [];
    list.push(band);
    bandsByDocument.set(band.documentId, list);
  }

  /*
   * Accumulated in base-currency cents and converted once, when the row is
   * final. Converting each document as it arrives and adding the results gives
   * a different total from converting the total, and the figures on a return
   * have to add up in front of whoever is copying them into a portal.
   */
  const rows = new Map<string, OssLine>();
  const fixes = new Map<string, OssCorrection>();
  for (const [id, document] of qualifying) {
    /*
     * A credit note against an earlier quarter's invoice is a correction: the
     * original return cannot be amended, so it goes on this one naming the
     * period it relates to. Against this quarter's own invoice it simply nets
     * off, because both movements are inside the period being reported. With
     * no original named at all it belongs to this quarter — nothing identifies
     * an earlier one to correct.
     */
    const original =
      document.kind === "credit_note" && document.referenceInvoiceId
        ? originals.get(document.referenceInvoiceId)
        : undefined;
    if (original && (original.year !== year || original.quarter !== quarter)) {
      const period = `${original.year}-Q${original.quarter}`;
      const key = `${document.memberState}|${period}`;
      const fix = fixes.get(key) ?? {
        memberState: document.memberState,
        period,
        taxableCents: 0,
        vatCents: 0,
        withinThreeYears:
          dueDate <=
          new Date(
            Date.UTC(
              original.year + 3,
              original.quarter * 3 + 1,
              0,
              23,
              59,
              59,
              999,
            ),
          ),
      };
      fix.taxableCents += document.netCents;
      fix.vatCents += document.vatCents;
      fixes.set(key, fix);
      continue;
    }

    const documentBands = bandsByDocument.get(id) ?? [];
    const nets = allocate(
      document.netCents,
      documentBands.map((b) => b.taxableCents),
    );
    const vats = allocate(
      document.vatCents,
      documentBands.map((b) => b.taxCents),
    );
    const split =
      documentBands.length > 0
        ? documentBands.map((band, index) => ({
            ratePpm: band.ratePpm ?? band.rateBp * 100,
            netCents: nets[index] ?? 0,
            vatCents: vats[index] ?? 0,
          }))
        : // No band at all: a cross-border sale with nothing charged on it.
          // Reported at 0% rather than dropped — it is a supply, and the
          // return has a place for it.
          [{ ratePpm: 0, netCents: document.netCents, vatCents: 0 }];

    for (const part of split) {
      const key = `${document.memberState}|${part.ratePpm}|${document.supplyType}`;
      const row = rows.get(key) ?? {
        memberState: document.memberState,
        ratePpm: part.ratePpm,
        supplyType: document.supplyType,
        taxableCents: 0,
        vatCents: 0,
      };
      row.taxableCents += part.netCents;
      row.vatCents += part.vatCents;
      rows.set(key, row);
    }
  }

  const ordered = [...rows.values()]
    .map((row) => ({
      ...row,
      taxableCents: toEuroCents(row.taxableCents, conversion),
      vatCents: toEuroCents(row.vatCents, conversion),
    }))
    .sort(
      (a, b) =>
        a.memberState.localeCompare(b.memberState) ||
        a.ratePpm - b.ratePpm ||
        a.supplyType.localeCompare(b.supplyType),
    );
  const corrections = [...fixes.values()]
    .map((fix) => ({
      ...fix,
      taxableCents: toEuroCents(fix.taxableCents, conversion),
      vatCents: toEuroCents(fix.vatCents, conversion),
    }))
    .sort(
      (a, b) =>
        a.memberState.localeCompare(b.memberState) ||
        a.period.localeCompare(b.period),
    );

  return {
    applies: true,
    year,
    quarter,
    from,
    to,
    dueDate,
    currency: "EUR",
    conversion,
    lines: ordered,
    corrections,
    totalTaxableCents:
      ordered.reduce((sum, row) => sum + row.taxableCents, 0) +
      corrections.reduce((sum, fix) => sum + fix.taxableCents, 0),
    totalVatCents:
      ordered.reduce((sum, row) => sum + row.vatCents, 0) +
      corrections.reduce((sum, fix) => sum + fix.vatCents, 0),
    problem: null,
    filing: OSS_FILING_NOTICE,
    caveats: caveatsFor(ordered),
  };
}

/** Which quarter each credited invoice was posted in, from the ledger. */
async function correctedPeriods(
  orgId: string,
  invoiceIds: string[],
): Promise<Map<string, { year: number; quarter: number }>> {
  const periods = new Map<string, { year: number; quarter: number }>();
  if (invoiceIds.length === 0) return periods;
  const entries = await db
    .select({
      source: schema.journalEntries.source,
      postedAt: schema.journalEntries.postedAt,
    })
    .from(schema.journalEntries)
    .where(
      and(
        eq(schema.journalEntries.organizationId, orgId),
        inArray(
          schema.journalEntries.source,
          invoiceIds.map((id) => `invoice:${id}`),
        ),
      ),
    );
  for (const entry of entries) {
    const id = entry.source?.split(":")[1];
    if (!id) continue;
    periods.set(id, {
      year: entry.postedAt.getUTCFullYear(),
      quarter: quarterOf(entry.postedAt),
    });
  }
  return periods;
}

/**
 * The limits, said out loud on the screen rather than discovered on a portal.
 *
 * Only the ones that apply: a caveat list nobody can act on is read once and
 * then ignored, taking the one that mattered with it.
 */
function caveatsFor(lines: OssLine[]): string[] {
  const caveats = [
    "Customers saved only as a person have no country on record, so their sales cannot be placed in a member state and are not counted here.",
    "Goods dispatched from a member state other than your own, and services supplied from an establishment in another member state, need extra parts of the return this report does not produce.",
  ];
  if (lines.length === 0) {
    caveats.unshift(
      "No cross-border sales to EU consumers this quarter. A quarter with nothing in it still needs a nil return — the obligation is to file, not to have traded.",
    );
  }
  if (lines.some((line) => line.supplyType === "unclassified")) {
    caveats.unshift(
      "Some supplies could not be told apart as goods or services — the lines did not come from your catalogue, or mixed both. The return has separate parts for them: classify the items, or split those rows by hand.",
    );
  }
  return caveats;
}

/**
 * The return as a file, because a tax figure is asked about years later.
 *
 * Records behind an OSS return have to be kept for ten years and produced
 * electronically on request, and a figure that exists only inside a running
 * application is not kept. The period, the currency and the rate used are rows
 * in the file rather than context from the screen, so it explains itself.
 */
export function ossReturnCsv(report: OssReturn): string {
  const euros = (cents: number) => (cents / 100).toFixed(2);
  const rows: unknown[][] = [
    [
      "Period",
      `${report.from.toISOString().slice(0, 10)} to ${report.to.toISOString().slice(0, 10)}`,
    ],
    ["Return and payment due", report.dueDate.toISOString().slice(0, 10)],
    ["Currency", "EUR"],
    report.conversion
      ? [
          "Exchange rate",
          `1 EUR = ${(report.conversion.rateMicro / RATE_SCALE).toFixed(6)} ${report.conversion.from}`,
          `ECB rate for ${report.conversion.asOf.toISOString().slice(0, 10)}`,
          report.conversion.prescribed
            ? "the prescribed quarter-end rate"
            : "NOT the prescribed quarter-end rate — record it and re-run",
        ]
      : ["Exchange rate", "none needed; books are kept in euro"],
    [report.filing],
    [],
    ["Member State", "VAT rate", "Supply", "Taxable amount", "VAT due"],
  ];
  for (const line of report.lines) {
    rows.push([
      line.memberState,
      `${percentFromPpm(line.ratePpm)}%`,
      line.supplyType,
      euros(line.taxableCents),
      euros(line.vatCents),
    ]);
  }
  if (report.corrections.length > 0) {
    rows.push([]);
    rows.push([
      "Corrections to earlier periods",
      "Period corrected",
      "",
      "Taxable adjustment",
      "VAT adjustment",
    ]);
    for (const fix of report.corrections) {
      rows.push([
        fix.memberState,
        fix.period,
        fix.withinThreeYears ? "" : "outside the three-year window",
        euros(fix.taxableCents),
        euros(fix.vatCents),
      ]);
    }
  }
  rows.push([]);
  rows.push([
    "Total",
    "",
    "",
    euros(report.totalTaxableCents),
    euros(report.totalVatCents),
  ]);
  for (const caveat of report.caveats) rows.push([caveat]);
  return toCsv(
    ["EU One Stop Shop return", `${report.year} Q${report.quarter}`],
    rows,
  );
}

export function registerOssReturn(ctx: ModuleContext) {
  ctx.app.get(
    "/api/invoicing/oss-return",
    requireSession(),
    requirePermission({ invoicing: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const now = new Date();
      const year = Number(c.req.query("year") ?? now.getUTCFullYear());
      const quarter = Number(c.req.query("quarter") ?? quarterOf(now));
      if (!Number.isInteger(year) || year < 2021 || year > 2100) {
        // 2021 is when the One Stop Shop replaced the Mini One Stop Shop;
        // there is no Union scheme quarter before it to report on.
        return c.json({ error: "which year? 2021 or later" }, 400);
      }
      if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
        return c.json({ error: "which quarter? 1, 2, 3 or 4" }, 400);
      }
      const report = await ossReturn(orgId, year, quarter);
      if (c.req.query("format") === "csv") {
        return c.body(
          ossReturnCsv(report),
          200,
          csvDownload(`oss-return-${report.year}-Q${report.quarter}.csv`),
        );
      }
      return c.json(report);
    },
  );
}
