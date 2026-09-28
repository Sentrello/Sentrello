import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, isNotNull, like, or, schema } from "@sentrello/db";
import type { PostedSale } from "@sentrello/db/sale-place";
import { postedSales } from "@sentrello/db/sale-place";
import type { ModuleContext } from "@sentrello/module-sdk";
import {
  US_NEXUS_CHECKED,
  US_NEXUS_THRESHOLDS,
  usStateCode,
} from "./us-nexus-thresholds";

/**
 * Where the business stands against each state's economic-nexus threshold.
 *
 * The same shape, and the same honesty, as the EU distance-selling watch: a
 * café selling in its own town should meet none of this machinery, and a
 * business two invoices from owing Ohio should hear about it *before* the
 * threshold is crossed — after is a registration made late, with the
 * penalties that come with that. Nothing here changes what an invoice
 * charges; it watches the figures and says which side of each state's line
 * the business is on. Registering is their decision, and their accountant's.
 *
 * What counts: every posted sale placed in a US state, however it was sold;
 * credit notes subtract, because the ledger reads them as negative movement on
 * income; sums are net of tax, in the organisation's base currency. What
 * cannot be counted is stated rather than hidden — a sale nobody placed, or
 * one whose state cannot be read, lands in `unattributed` instead of silently
 * in nobody's column.
 */

/**
 * The ways a company record can say "the United States".
 *
 * Exported because the rate lookup asks the same question, and the browser
 * used to ask it a fourth time with a shorter list — three spellings against
 * these five, so a customer whose country read "United States of America"
 * was quietly treated as foreign and charged no US tax at all.
 */
export const US_COUNTRY = new Set([
  "US",
  "USA",
  "UNITED STATES",
  "UNITED STATES OF AMERICA",
  "PUERTO RICO",
]);

export interface StateNexusPosition {
  state: string;
  yearCents: number;
  priorYearCents: number;
  yearTransactions: number;
  priorYearTransactions: number;
  threshold: {
    salesCents: number;
    transactions: number | null;
    rule: "or" | "and";
    note?: string;
  } | null;
  /**
   * Whether an active tax definition already collects for this state — the
   * signal that the business is registered there. The warning that matters
   * is a state over its threshold with nothing collecting.
   */
  collecting: boolean;
  /**
   * "over" | "approaching" | "under" against the threshold; "no-sales-tax"
   * where the state levies none; "unknown" when the books are not kept in
   * dollars, where the comparison is left to the reader.
   */
  status: "over" | "approaching" | "under" | "no-sales-tax" | "unknown";
}

export interface UsNexusPosition {
  currency: string;
  checked: string;
  states: StateNexusPosition[];
  /** US sales whose state could not be read — a floor on every column above. */
  unattributedCents: number;
  unattributedTransactions: number;
}

/** Approaching starts at 80% — early enough to talk to an accountant. */
const APPROACHING = 0.8;

function statusFor(
  entry: StateNexusPosition,
  inDollars: boolean,
): StateNexusPosition["status"] {
  const threshold = entry.threshold;
  if (!threshold) return "no-sales-tax";
  if (!inDollars) return "unknown";

  /**
   * Progress toward the threshold, worked out for the worse of the two
   * years — most states measure "previous or current calendar year", so
   * either year crossing is a crossing. Where a transaction test exists,
   * "or" states are as close as their *closest* test and "and" states
   * (Connecticut, New York) as close as their *furthest*, because that is
   * what has to happen before the obligation lands.
   */
  const progress = (cents: number, count: number): number => {
    const sales = cents / threshold.salesCents;
    if (threshold.transactions === null) return sales;
    const txn = count / threshold.transactions;
    return threshold.rule === "and"
      ? Math.min(sales, txn)
      : Math.max(sales, txn);
  };
  const worst = Math.max(
    progress(entry.yearCents, entry.yearTransactions),
    progress(entry.priorYearCents, entry.priorYearTransactions),
  );
  if (worst >= 1) return "over";
  if (worst >= APPROACHING) return "approaching";
  return "under";
}

export async function usNexusPosition(
  orgId: string,
  now: Date = new Date(),
): Promise<UsNexusPosition> {
  const [org] = await db
    .select({ baseCurrency: schema.organizations.baseCurrency })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId))
    .limit(1);
  const currency = org?.baseCurrency ?? "USD";

  /*
   * Read from posted entries and the place recorded on each sale, not from
   * invoice rows joined through a contact to a company.
   *
   * The join had the two faults the OSS return had. A sale a storefront raised
   * has no invoice row to find, and a consumer is a person with no company, so
   * the join removed them before any state was read — not into `unattributed`,
   * where a sale nobody can place belongs, but out of the figures entirely.
   * Economic nexus is a threshold on *volume into a state*, and the volume it
   * is usually crossed by is consumers buying from a website.
   */
  const yearOf = (year: number) => ({
    from: new Date(Date.UTC(year, 0, 1)),
    to: new Date(Date.UTC(year + 1, 0, 1) - 1),
  });
  const year = now.getUTCFullYear();
  const [thisYear, lastYear] = await Promise.all([
    postedSales(orgId, yearOf(year)),
    postedSales(orgId, yearOf(year - 1)),
  ]);

  const byState = new Map<string, StateNexusPosition>();
  let unattributedCents = 0;
  let unattributedTransactions = 0;

  /**
   * A transaction is a sale, not a reversal.
   *
   * The count is of sales made into the state, so a credit note subtracts from
   * the money and leaves the count alone — which is what the old reading of
   * `kind !== "credit_note"` meant, said in the ledger's own terms.
   */
  const countSales = (sales: PostedSale[], thisOne: boolean) => {
    for (const sale of sales) {
      const country = sale.place?.country?.trim().toUpperCase() ?? "";
      // Puerto Rico arrives either way: as the country, or as a state of one
      // of the US spellings. Anything not recognisably American is skipped —
      // but a sale with no place at all is not "not American", it is a sale
      // nobody placed, and it is counted as one.
      if (!sale.place) {
        unattributedCents += sale.netCents;
        if (sale.netCents > 0) unattributedTransactions += 1;
        continue;
      }
      if (!US_COUNTRY.has(country)) continue;
      const code =
        country === "PUERTO RICO" ? "PR" : usStateCode(sale.place.region);

      if (!code) {
        unattributedCents += sale.netCents;
        if (sale.netCents > 0) unattributedTransactions += 1;
        continue;
      }

      const entry = byState.get(code) ?? {
        state: code,
        yearCents: 0,
        priorYearCents: 0,
        yearTransactions: 0,
        priorYearTransactions: 0,
        threshold: null,
        collecting: false,
        status: "under" as const,
      };
      if (thisOne) {
        entry.yearCents += sale.netCents;
        if (sale.netCents > 0) entry.yearTransactions += 1;
      } else {
        entry.priorYearCents += sale.netCents;
        if (sale.netCents > 0) entry.priorYearTransactions += 1;
      }
      byState.set(code, entry);
    }
  };
  countSales(thisYear, true);
  countSales(lastYear, false);

  /**
   * "Already collecting there" is read off the rate table rather than asked
   * as a setting: a business registered in Texas has a rate whose
   * jurisdiction starts "US-TX", because it could not charge the tax
   * otherwise. One fact, kept once.
   */
  const definitions = await db
    .select({ jurisdiction: schema.taxDefinitions.jurisdiction })
    .from(schema.taxDefinitions)
    .where(
      and(
        eq(schema.taxDefinitions.organizationId, orgId),
        eq(schema.taxDefinitions.active, true),
        isNotNull(schema.taxDefinitions.jurisdiction),
        or(
          like(schema.taxDefinitions.jurisdiction, "US-%"),
          like(schema.taxDefinitions.jurisdiction, "us-%"),
        ),
      ),
    );
  const collectingStates = new Set(
    definitions
      .map((d) => d.jurisdiction?.toUpperCase().split("-")[1] ?? "")
      .filter((s) => s.length === 2),
  );

  const inDollars = currency === "USD";
  const states = [...byState.values()]
    .map((entry) => {
      const threshold = US_NEXUS_THRESHOLDS[entry.state];
      entry.threshold = threshold
        ? { rule: threshold.rule ?? "or", ...threshold }
        : null;
      entry.collecting = collectingStates.has(entry.state);
      entry.status = statusFor(entry, inDollars);
      return entry;
    })
    .sort((a, b) => b.yearCents - a.yearCents);

  return {
    currency,
    checked: US_NEXUS_CHECKED,
    states,
    unattributedCents,
    unattributedTransactions,
  };
}

/** The sentence beside each state, so the screen never invents its own. */
export function nexusAdvice(entry: StateNexusPosition): string {
  const name = entry.state;
  switch (entry.status) {
    case "no-sales-tax":
      return `${name} levies no general sales tax.`;
    case "over":
      return entry.collecting
        ? `Sales into ${name} are over its economic-nexus threshold, and a rate for ${name} is already set up.`
        : `Sales into ${name} are over its economic-nexus threshold and nothing is collecting there — talk to your accountant about registering, and add the state's rate under Taxes once you have.`;
    case "approaching":
      return entry.collecting
        ? `Sales into ${name} are approaching its economic-nexus threshold; a rate for ${name} is already set up.`
        : `Sales into ${name} are approaching its economic-nexus threshold — worth raising with your accountant before it is crossed.`;
    case "unknown":
      return `Your books are not kept in dollars; compare these totals with ${name}'s threshold yourself.`;
    default:
      return `Sales into ${name} are under its economic-nexus threshold.`;
  }
}

export function registerUsNexus(ctx: ModuleContext) {
  ctx.app.get(
    "/api/invoicing/us-nexus",
    requireSession(),
    requirePermission({ invoicing: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const position = await usNexusPosition(orgId);
      return c.json({
        ...position,
        states: position.states.map((s) => ({ ...s, advice: nexusAdvice(s) })),
        // The measurement caveat travels with the figures, always.
        basis:
          "Current and previous calendar year, from issued invoices net of tax. Most states measure either year; Texas measures a rolling twelve months. A customer without a company record, or without a readable state, is counted under 'unattributed'.",
      });
    },
  );
}
