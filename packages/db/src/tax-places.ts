import { and, eq, ne, sql } from "drizzle-orm";
import { db, schema } from "./index";
import { ensureAccount } from "./ledger";

/**
 * Which named taxes a sale at a place, at a rate, was.
 *
 * An invoice line names its tax definitions, and the posting splits its tax by
 * them onto each authority's own account — the account a US or Canadian return
 * reads. A Shop or till sale carries one blended rate per line and named
 * nothing, so its tax went to the shared Tax Payable and neither return could
 * see it. This is the naming, for a sale that has only a place and a rate.
 */

export interface TaxComponent {
  label: string;
  ratePpm: number;
}

const GST: TaxComponent = { label: "GST", ratePpm: 50_000 };

/**
 * What a Canadian province's one combined rate is made of.
 *
 * Harmonised provinces are one line, because HST *is* one tax. The rates are
 * the ones in force: Nova Scotia came down to 14% on 1 April 2025. The till
 * prints its receipts from this table too, so the receipt and the books split a
 * sale the same way.
 */
export const CANADA: Record<string, TaxComponent[]> = {
  AB: [GST],
  BC: [GST, { label: "PST", ratePpm: 70_000 }],
  MB: [GST, { label: "RST", ratePpm: 70_000 }],
  NB: [{ label: "HST", ratePpm: 150_000 }],
  NL: [{ label: "HST", ratePpm: 150_000 }],
  NS: [{ label: "HST", ratePpm: 140_000 }],
  NT: [GST],
  NU: [GST],
  ON: [{ label: "HST", ratePpm: 130_000 }],
  PE: [{ label: "HST", ratePpm: 150_000 }],
  QC: [GST, { label: "QST", ratePpm: 99_750 }],
  SK: [GST, { label: "PST", ratePpm: 60_000 }],
  YT: [GST],
};

/**
 * A Canadian rate's components, when they add up to exactly what was charged.
 *
 * A rate typed wrongly, or a province that has moved its own tax since this
 * table was written, is not split: inventing a component that was not charged
 * is a claim about money that is untrue.
 */
export function canadianComponents(
  region: string | null | undefined,
  ratePpm: number,
): TaxComponent[] | null {
  const province = CANADA[(region ?? "").toUpperCase()];
  if (!province) return null;
  const sum = province.reduce((n, c) => n + c.ratePpm, 0);
  return sum === ratePpm ? province : null;
}

/**
 * Cents divided by weights, cumulatively, so the parts always sum to the whole.
 *
 * Rounding each part on its own leaves a cent adrift; the difference of two
 * running allocations cannot.
 */
export function apportion(cents: number, weights: number[]): number[] {
  const total = weights.reduce((n, w) => n + w, 0);
  if (total <= 0) return weights.map((_, i) => (i === 0 ? cents : 0));
  let before = 0;
  let running = 0;
  return weights.map((w) => {
    running += w;
    const upTo = Math.round((cents * running) / total);
    const part = upTo - before;
    before = upTo;
    return part;
  });
}

export interface SaleTax {
  taxDefinitionId: string;
  name: string;
  ratePpm: number;
}

/**
 * A definition, found by what makes it the same tax, or made.
 *
 * Found by jurisdiction and rate, as the US provider path has always found
 * them: a jurisdiction whose rate changes gets a new definition, and what was
 * charged under the old one keeps meaning what it meant.
 */
async function ensureDefinition(
  orgId: string,
  want: {
    name: string;
    ratePpm: number;
    regime: "us" | "ca";
    jurisdiction: string;
    recoverable: boolean;
  },
): Promise<SaleTax> {
  const [existing] = await db
    .select({
      id: schema.taxDefinitions.id,
      name: schema.taxDefinitions.name,
    })
    .from(schema.taxDefinitions)
    .where(
      and(
        eq(schema.taxDefinitions.organizationId, orgId),
        eq(schema.taxDefinitions.jurisdiction, want.jurisdiction),
        eq(schema.taxDefinitions.ratePpm, want.ratePpm),
        eq(schema.taxDefinitions.active, true),
        // A rate kept for purchases only is not the sales tax it shares a
        // number with.
        ne(schema.taxDefinitions.appliesTo, "purchases"),
      ),
    )
    .limit(1);
  if (existing) {
    return {
      taxDefinitionId: existing.id,
      name: existing.name,
      ratePpm: want.ratePpm,
    };
  }
  const [made] = await db
    .insert(schema.taxDefinitions)
    .values({
      organizationId: orgId,
      name: want.name,
      rateBp: Math.round(want.ratePpm / 100),
      ratePpm: want.ratePpm,
      categoryCode: "S",
      appliesTo: "sales",
      recoverable: want.recoverable,
      regime: want.regime,
      jurisdiction: want.jurisdiction,
      description: "Named for sales taken through the Shop or the till",
    })
    .returning({
      id: schema.taxDefinitions.id,
      name: schema.taxDefinitions.name,
    });
  if (!made) throw new Error("tax definition insert returned no row");
  return { taxDefinitionId: made.id, name: made.name, ratePpm: want.ratePpm };
}

/**
 * The named taxes one rate at one place was, or null when it cannot be named.
 *
 * - **United States**: one tax, for the state (`US-<ST>`) at the rate charged.
 *   A blended state-and-local rate stays one figure, because that is what was
 *   charged; the return groups it under the state.
 * - **Canada**: the province's components — GST beside PST, RST or QST, or HST
 *   alone — when they add up to the rate. A province's PST and RST are not
 *   reclaimable; everything else is.
 * - **Anywhere else**: null. A VAT return reads the shared account already.
 *
 * Null for a rate of nought too: no tax was charged, so there is nothing to
 * name.
 */
export async function saleTaxesFor(
  orgId: string,
  place: { country: string | null; region: string | null },
  ratePpm: number,
): Promise<SaleTax[] | null> {
  if (ratePpm <= 0) return null;
  const country = (place.country ?? "").toUpperCase();
  const region = (place.region ?? "").toUpperCase();
  if (country === "US") {
    const jurisdiction = region ? `US-${region}` : "US";
    return [
      await ensureDefinition(orgId, {
        name: region ? `${region} sales tax` : "Sales tax",
        ratePpm,
        regime: "us",
        jurisdiction,
        recoverable: false,
      }),
    ];
  }
  if (country === "CA") {
    const parts = canadianComponents(region, ratePpm);
    if (!parts) return null;
    const named: SaleTax[] = [];
    for (const part of parts) {
      const federal = part.label === "GST";
      named.push(
        await ensureDefinition(orgId, {
          name: federal ? "GST" : `${part.label} ${region}`,
          ratePpm: part.ratePpm,
          regime: "ca",
          jurisdiction: federal ? "CA" : `CA-${region}`,
          // A province's own sales tax is a cost to a business that pays it;
          // GST, HST and QST come back as input credits.
          recoverable: part.label !== "PST" && part.label !== "RST",
        }),
      );
    }
    return named;
  }
  return null;
}

/** The account one named tax is owed on, as every posting names it. */
export function taxAccountFor(
  orgId: string,
  tax: { taxDefinitionId: string; name: string },
): Promise<string> {
  return ensureAccount(orgId, {
    code: `2200-${tax.taxDefinitionId.slice(0, 8)}`,
    name: `Tax Payable — ${tax.name}`,
    type: "liability",
  });
}

/**
 * One blended charge, divided among the taxes it was.
 *
 * In proportion to their rates — GST 5% and PST 7% on a 12% charge take five
 * twelfths and seven — each share rounded down and the spare cents given to
 * the largest. That is exactly how the till's receipt divides it, and it has
 * to be: a receipt saying GST 4 and PST 7 beside books saying 5 and 6 is the
 * customer and the return holding two different documents.
 */
export function splitCharge(
  cents: number,
  taxes: SaleTax[],
): { tax: SaleTax; cents: number }[] {
  const sign = cents < 0 ? -1 : 1;
  const whole = Math.abs(cents);
  const total = taxes.reduce((n, t) => n + t.ratePpm, 0);
  const parts = taxes.map((t) =>
    total > 0 ? Math.floor((whole * t.ratePpm) / total) : 0,
  );
  let spare = whole - parts.reduce((n, p) => n + p, 0);
  const largestFirst = taxes
    .map((t, i) => [t.ratePpm, i] as const)
    .sort((a, b) => b[0] - a[0]);
  while (spare > 0 && largestFirst.length > 0) {
    for (const [, i] of largestFirst) {
      if (spare <= 0) break;
      parts[i] = (parts[i] ?? 0) + 1;
      spare -= 1;
    }
  }
  return taxes.map((tax, i) => ({ tax, cents: sign * (parts[i] ?? 0) }));
}

/**
 * Where a posted entry put its tax, account by account, and at what rate.
 *
 * Read from the entry rather than worked out again, so whatever later takes a
 * share of that tax back — a discount at the till, a part refund — takes it
 * off the accounts the sale actually credited. `ratePpm` is the named tax's
 * own rate, and null on the shared account, which names nothing.
 */
export async function taxAccountsOf(
  orgId: string,
  source: string,
): Promise<{ accountId: string; cents: number; ratePpm: number | null }[]> {
  const rows = await db
    .select({
      accountId: schema.journalLines.accountId,
      code: schema.accounts.code,
      cents: sql<string>`sum(${schema.journalLines.creditCents} - ${schema.journalLines.debitCents})`,
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
        eq(schema.journalEntries.source, source),
        sql`(${schema.accounts.code} = '2200' or ${schema.accounts.code} like '2200-%')`,
      ),
    )
    .groupBy(schema.journalLines.accountId, schema.accounts.code);
  const definitions = await db
    .select({
      id: schema.taxDefinitions.id,
      ratePpm: schema.taxDefinitions.ratePpm,
      rateBp: schema.taxDefinitions.rateBp,
    })
    .from(schema.taxDefinitions)
    .where(eq(schema.taxDefinitions.organizationId, orgId));
  const rateOf = (code: string) => {
    const prefix = code.startsWith("2200-") ? code.slice(5) : null;
    const def = prefix
      ? definitions.find((d) => d.id.startsWith(prefix))
      : undefined;
    return def ? (def.ratePpm ?? def.rateBp * 100) : null;
  };
  return rows
    .map((r) => ({
      accountId: r.accountId,
      cents: Number(r.cents),
      ratePpm: rateOf(r.code),
    }))
    .filter((r) => r.cents !== 0);
}
