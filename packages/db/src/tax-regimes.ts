import { db } from "./client";
import { eq } from "./orm";
import * as schema from "./schema";

/**
 * Which tax regimes exist, and which nav screen each one gates.
 *
 * Which regimes a business operates in is a setting, not an inference from
 * its country: a t-shirt shop that sells only at home needs one, and the same
 * shop selling across the US, Canada, the UK and the EU — the case Sentrello
 * itself is in — needs all four at once. Left unfiltered, every business saw
 * every regime's screen in its sidebar regardless of where it traded, which
 * reads as unfinished to the business that sells in exactly one of them.
 *
 * `navId` is the nav entry the regime gates, where one exists. EU VAT has none
 * today: its features — VIES checks, e-invoicing, distance selling — already
 * show themselves only where the data calls for them, rather than as a nav
 * entry offered to everybody.
 */
export interface TaxRegime {
  id: string;
  label: string;
  navId?: string;
}

export const TAX_REGIMES: TaxRegime[] = [
  { id: "uk-vat", label: "UK VAT", navId: "accounting-vat" },
  {
    id: "ca-tax",
    label: "Canada (GST/HST, QST, PST)",
    navId: "accounting-ca-tax",
  },
  { id: "us-sales-tax", label: "US sales tax", navId: "invoicing-us-tax" },
  { id: "eu-vat", label: "EU VAT" },
];

const KNOWN_REGIME_IDS = new Set(TAX_REGIMES.map((r) => r.id));

/** Which regime, if any, a nav entry belongs to. */
export const NAV_TAX_REGIME = new Map(
  TAX_REGIMES.filter((r) => r.navId).map((r) => [r.navId as string, r.id]),
);

/**
 * What a fresh instance operates in, before it says otherwise.
 *
 * US sales tax alone — Sentrello's first market, see CLAUDE.md's build order
 * — so a brand-new instance's sidebar is not empty. Never applied silently
 * once a business has actually chosen: this is only what `taxRegimesFor`
 * answers when no row exists yet.
 */
export const DEFAULT_TAX_REGIMES: string[] = ["us-sales-tax"];

/** Keeps only ids this instance recognises, deduplicated. */
export function cleanTaxRegimes(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  return [
    ...new Set(input.map(String).filter((id) => KNOWN_REGIME_IDS.has(id))),
  ];
}

/**
 * The regimes this business has chosen, or the default when it has not chosen
 * yet.
 *
 * Read from `ledgerSettings`, which a fresh organization has no row in at
 * all — the same lazy-row pattern `vatSchemeFor` uses. Nothing here deletes a
 * regime's data when it is turned off; it only decides what nav a business is
 * offered, in `/api/_meta`.
 */
export async function taxRegimesFor(orgId: string): Promise<string[]> {
  const [row] = await db
    .select({ taxRegimes: schema.ledgerSettings.taxRegimes })
    .from(schema.ledgerSettings)
    .where(eq(schema.ledgerSettings.organizationId, orgId))
    .limit(1);
  // No row at all is "never chosen" and gets the default. A row with an
  // empty array is a business that chose to turn everything off, which is
  // its call to make and stays exactly that — an empty sidebar section, not
  // a silent fallback to what a fresh instance starts with.
  if (!row) return DEFAULT_TAX_REGIMES;
  return row.taxRegimes;
}

/** Saves the regimes a business has chosen. Never deletes anything else's row. */
export async function setTaxRegimes(
  orgId: string,
  regimes: string[],
): Promise<void> {
  await db
    .insert(schema.ledgerSettings)
    .values({ organizationId: orgId, taxRegimes: regimes })
    .onConflictDoUpdate({
      target: schema.ledgerSettings.organizationId,
      set: { taxRegimes: regimes, updatedAt: new Date() },
    });
}
