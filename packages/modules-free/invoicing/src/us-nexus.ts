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
  or,
  schema,
} from "@sentrello/db";
import { RATE_SCALE, toBaseCents } from "@sentrello/db/currency";
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
 * What counts: issued invoices (open, partial, paid) to customers whose
 * company record puts them in a US state; credit notes subtract; sums are
 * net of tax, converted to the organisation's base currency. What cannot be
 * counted is stated rather than hidden — a customer with no company record,
 * or one whose state cannot be read, lands in `unattributed` instead of
 * silently in nobody's column.
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

  const priorYearStart = new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1));
  const rows = await db
    .select({
      kind: schema.invoices.kind,
      issueDate: schema.invoices.issueDate,
      subtotalCents: schema.invoices.subtotalCents,
      discountCents: schema.invoices.discountCents,
      rateMicro: schema.invoices.rateMicro,
      buyerCountry: schema.companies.country,
      buyerState: schema.companies.state,
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
        inArray(schema.invoices.status, [
          "open",
          "partial",
          "paid",
          "credited",
        ]),
        gte(schema.invoices.issueDate, priorYearStart),
      ),
    );

  const byState = new Map<string, StateNexusPosition>();
  let unattributedCents = 0;
  let unattributedTransactions = 0;

  for (const row of rows) {
    const country = row.buyerCountry?.trim().toUpperCase() ?? "";
    const state = usStateCode(row.buyerState);
    // Puerto Rico arrives either way: as the country, or as a state of one
    // of the US spellings. Anything not recognisably American is skipped.
    const code = country === "PUERTO RICO" ? "PR" : state;
    if (!US_COUNTRY.has(country)) continue;

    const net = toBaseCents(
      row.subtotalCents - row.discountCents,
      row.rateMicro ?? RATE_SCALE,
    );
    const signed = row.kind === "credit_note" ? -net : net;
    const thisYear = row.issueDate.getUTCFullYear() === now.getUTCFullYear();

    if (!code) {
      unattributedCents += signed;
      if (row.kind !== "credit_note") unattributedTransactions += 1;
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
    if (thisYear) {
      entry.yearCents += signed;
      if (row.kind !== "credit_note") entry.yearTransactions += 1;
    } else {
      entry.priorYearCents += signed;
      if (row.kind !== "credit_note") entry.priorYearTransactions += 1;
    }
    byState.set(code, entry);
  }

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
