import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, isNotNull, like, or, schema } from "@sentrello/db";
import type { ModuleContext } from "@sentrello/module-sdk";
import { usStateCode } from "./us-nexus-thresholds";

/**
 * US sales-tax rates for an address: the seam, and the free path through it.
 *
 * There is no national sales tax. State, county, city and special districts
 * stack on one sale, there are roughly thirteen thousand taxing
 * jurisdictions, and the rates change monthly — which is why
 * locality-accurate rates are a paid data product everywhere. The shape here
 * is the one the scope settled: a **rate provider is an integration the
 * business connects on its own account** in settings, the way a card
 * processor is, so the cost and the relationship are theirs; and the
 * **manually maintained rate table stays the free path**, because most of
 * the businesses this is sold to charge one or two jurisdictions' rates and
 * can type them in once.
 *
 * The manual path: name each rate with its jurisdiction — "US-TX" 6.25%,
 * "US-TX-AUSTIN" 2% — and this lookup returns everything that applies to an
 * address: the state rate always, a locality rate when the city (or, failing
 * that, the postcode) names it. They land on the invoice line as stacked
 * taxes, each frozen at its own rate, each posted to its own liability
 * account. A café that only ever sells in its own town sets its combined
 * rate as the default and never meets any of this.
 */

export interface UsRateQuery {
  state: string;
  city?: string | null;
  postcode?: string | null;
}

/** One jurisdiction's rate, whoever answered. */
export interface UsRate {
  name: string;
  /** Millionths: 6.25% is 62,500. */
  ratePpm: number;
  /** "US-TX", "US-TX-AUSTIN" — where the money is owed. */
  jurisdiction: string;
}

/**
 * A rate provider a business can connect on its own account.
 *
 * Deliberately the same shape as a payment provider: credentials live with
 * the provider's own settings (sealed, never echoed), `configured` says
 * whether this organisation has switched it on, and the lookup route asks
 * providers before falling back to the manual table. Nothing in the free
 * core implements one — this is the socket, not the plug.
 */
export interface UsRateProvider {
  id: string;
  configured(orgId: string): Promise<boolean>;
  ratesFor(orgId: string, query: UsRateQuery): Promise<UsRate[]>;
}

const providers: UsRateProvider[] = [];

export function registerUsRateProvider(provider: UsRateProvider): void {
  providers.push(provider);
}

/**
 * A provider's answer, made durable.
 *
 * Whatever answers the lookup, what lands on a document is a tax
 * *definition*: named, frozen at issue, banded on the document and posted to
 * a per-jurisdiction liability account. A provider rate is therefore found
 * or created as a definition — found by jurisdiction and rate, so a
 * jurisdiction whose rate changes gets a new definition and documents issued
 * under the old one keep meaning what they meant.
 */
export async function ensureUsTaxDefinition(
  orgId: string,
  rate: UsRate,
): Promise<{ id: string; name: string; ratePpm: number }> {
  const jurisdiction = rate.jurisdiction.trim().toUpperCase();
  const [existing] = await db
    .select({
      id: schema.taxDefinitions.id,
      name: schema.taxDefinitions.name,
      ratePpm: schema.taxDefinitions.ratePpm,
    })
    .from(schema.taxDefinitions)
    .where(
      and(
        eq(schema.taxDefinitions.organizationId, orgId),
        eq(schema.taxDefinitions.jurisdiction, jurisdiction),
        eq(schema.taxDefinitions.ratePpm, rate.ratePpm),
        eq(schema.taxDefinitions.active, true),
      ),
    )
    .limit(1);
  if (existing) {
    return { ...existing, ratePpm: existing.ratePpm ?? rate.ratePpm };
  }

  const [made] = await db
    .insert(schema.taxDefinitions)
    .values({
      organizationId: orgId,
      name: rate.name,
      rateBp: Math.round(rate.ratePpm / 100),
      ratePpm: rate.ratePpm,
      categoryCode: "S",
      appliesTo: "sales",
      // US sales tax on a purchase is part of the cost, never reclaimed.
      recoverable: false,
      regime: "us",
      jurisdiction,
    })
    .returning({
      id: schema.taxDefinitions.id,
      name: schema.taxDefinitions.name,
      ratePpm: schema.taxDefinitions.ratePpm,
    });
  if (!made) throw new Error("tax definition insert returned no row");
  return { ...made, ratePpm: made.ratePpm ?? rate.ratePpm };
}

/**
 * The manual table's answer for an address: the state's own rates, plus any
 * locality rate the city or postcode names. Everything matches uppercased,
 * because "us-tx-austin" and "US-TX-Austin" are the same place.
 */
export async function manualUsRates(
  orgId: string,
  query: UsRateQuery,
): Promise<
  { id: string; name: string; ratePpm: number; jurisdiction: string }[]
> {
  const state = usStateCode(query.state);
  if (!state) return [];

  const rows = await db
    .select({
      id: schema.taxDefinitions.id,
      name: schema.taxDefinitions.name,
      rateBp: schema.taxDefinitions.rateBp,
      ratePpm: schema.taxDefinitions.ratePpm,
      jurisdiction: schema.taxDefinitions.jurisdiction,
    })
    .from(schema.taxDefinitions)
    .where(
      and(
        eq(schema.taxDefinitions.organizationId, orgId),
        eq(schema.taxDefinitions.active, true),
        isNotNull(schema.taxDefinitions.jurisdiction),
        or(
          like(schema.taxDefinitions.jurisdiction, `US-${state}`),
          like(schema.taxDefinitions.jurisdiction, `US-${state}-%`),
        ),
      ),
    );

  const city = query.city?.trim().toUpperCase() ?? "";
  const postcode = query.postcode?.trim().toUpperCase() ?? "";
  return rows
    .filter((row) => {
      const j = row.jurisdiction?.toUpperCase() ?? "";
      if (j === `US-${state}`) return true;
      const locality = j.slice(`US-${state}-`.length);
      return locality !== "" && (locality === city || locality === postcode);
    })
    .map((row) => ({
      id: row.id,
      name: row.name,
      ratePpm: row.ratePpm ?? row.rateBp * 100,
      jurisdiction: row.jurisdiction?.toUpperCase() ?? "",
    }));
}

/**
 * The one lookup every caller routes through: a configured provider answers
 * first; the manual table is the free path and the fallback. Either way the
 * result is a list of definition ids ready to stack on an invoice line.
 */
export async function usTaxesFor(
  orgId: string,
  query: UsRateQuery,
): Promise<{
  source: string;
  taxes: { id: string; name: string; ratePpm: number; jurisdiction: string }[];
}> {
  for (const provider of providers) {
    if (!(await provider.configured(orgId))) continue;
    const rates = await provider.ratesFor(orgId, query);
    const taxes = [];
    for (const rate of rates) {
      const definition = await ensureUsTaxDefinition(orgId, rate);
      taxes.push({
        ...definition,
        jurisdiction: rate.jurisdiction.toUpperCase(),
      });
    }
    return { source: provider.id, taxes };
  }
  return { source: "manual", taxes: await manualUsRates(orgId, query) };
}

export function registerUsRates(ctx: ModuleContext) {
  ctx.app.get(
    "/api/invoicing/us-taxes",
    requireSession(),
    requirePermission({ invoicing: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const state = c.req.query("state") ?? "";
      if (!usStateCode(state)) {
        return c.json(
          { error: "which state? (two letters, or its name)" },
          400,
        );
      }
      const result = await usTaxesFor(orgId, {
        state,
        city: c.req.query("city") ?? null,
        postcode: c.req.query("postcode") ?? null,
      });
      return c.json(result);
    },
  );
}
