import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, schema } from "@sentrello/db";
import type {
  ModuleContext,
  RouteContext,
  SentrelloEnv,
} from "@sentrello/module-sdk";
import type { MiddlewareHandler } from "hono";
import { isUuid } from "./chart";

/**
 * Tax, in the four markets Sentrello sells into and no others.
 *
 * The US first, then Canada, the UK and the EU. That is a scoping instrument
 * rather than a shortlist: it decides which regimes exist at all, and a rate
 * for a country we do not sell into is a rate nobody can maintain.
 *
 * The rates themselves live in `tax_definitions`, which Invoicing already owns
 * and writes — one table, because a rate charged on a sale and reclaimed on a
 * purchase is the same rate, and two tables would be two answers to what the
 * standard rate is. What Accounting adds is the part invoicing does not need:
 * whether a rate compounds, whether it is withheld, whether it comes back on a
 * purchase, and which jurisdiction it belongs to.
 */

export type Regime = "us" | "ca" | "uk" | "eu";

export interface TaxPreset {
  name: string;
  rateBp: number;
  categoryCode: string;
  description?: string;
  appliesTo?: "sales" | "purchases" | "both";
  compound?: boolean;
  withholding?: boolean;
  recoverable?: boolean;
  jurisdiction?: string;
}

/**
 * What each regime's rates are, as at the day this was written.
 *
 * Rates move, and a stale rate in a book is worse than no rate — so these are a
 * starting point a business edits, every one of them nameable and every one
 * editable afterwards. Nothing here is applied automatically to a document.
 */
export const TAX_PRESETS: Record<Regime, TaxPreset[]> = {
  /**
   * US sales tax is set by state and often by county and city on top, so there
   * is no national rate to ship. What is shipped is the shape: a rate charged
   * on sales that the business does *not* reclaim on its purchases, because
   * sales tax paid on a purchase is part of what the purchase cost.
   */
  us: [
    {
      name: "Sales Tax",
      rateBp: 0,
      categoryCode: "S",
      description:
        "Set your state and local rate — US sales tax has no national figure",
      appliesTo: "sales",
      recoverable: false,
    },
    {
      name: "Exempt",
      rateBp: 0,
      categoryCode: "E",
      description: "Resale or exemption certificate held",
      appliesTo: "sales",
      recoverable: false,
    },
  ],
  /**
   * Canada: GST federally, HST where it is harmonised, and the provincial
   * systems that sit beside it — PST, and Quebec's QST.
   */
  ca: [
    { name: "GST 5%", rateBp: 500, categoryCode: "S", jurisdiction: "CA" },
    {
      name: "HST 13% (Ontario)",
      rateBp: 1300,
      categoryCode: "S",
      jurisdiction: "CA-ON",
    },
    {
      name: "HST 15% (Atlantic)",
      rateBp: 1500,
      categoryCode: "S",
      jurisdiction: "CA-NS",
    },
    {
      name: "QST 9.975%",
      rateBp: 998,
      categoryCode: "S",
      description: "Charged alongside GST in Quebec",
      jurisdiction: "CA-QC",
    },
    {
      name: "PST 7% (British Columbia)",
      rateBp: 700,
      categoryCode: "S",
      // PST is not a value-added tax: a business does not reclaim it.
      recoverable: false,
      jurisdiction: "CA-BC",
    },
    {
      name: "Zero-rated",
      rateBp: 0,
      categoryCode: "Z",
      jurisdiction: "CA",
    },
  ],
  uk: [
    { name: "VAT 20%", rateBp: 2000, categoryCode: "S", jurisdiction: "GB" },
    {
      name: "VAT 5% (reduced)",
      rateBp: 500,
      categoryCode: "AA",
      jurisdiction: "GB",
    },
    { name: "Zero-rated", rateBp: 0, categoryCode: "Z", jurisdiction: "GB" },
    { name: "Exempt", rateBp: 0, categoryCode: "E", jurisdiction: "GB" },
  ],
  /**
   * The EU has a standard rate per member state, so what ships is the
   * machinery rather than twenty-seven numbers: a standard rate to set, the
   * reverse charge that applies to cross-border business supplies, and the
   * zero rate for intra-community supplies.
   */
  eu: [
    {
      name: "VAT (standard)",
      rateBp: 0,
      categoryCode: "S",
      description: "Set your member state's standard rate",
    },
    {
      name: "Reverse charge",
      rateBp: 0,
      categoryCode: "AE",
      description:
        "Cross-border business supply — the customer accounts for the tax",
    },
    {
      name: "Intra-community supply",
      rateBp: 0,
      categoryCode: "Z",
      description: "Goods to a VAT-registered customer in another member state",
    },
    { name: "Exempt", rateBp: 0, categoryCode: "E" },
  ],
};

export const REGIMES = Object.keys(TAX_PRESETS) as Regime[];

export function registerTaxes(
  ctx: ModuleContext,
  proOnly: MiddlewareHandler<SentrelloEnv>,
) {
  ctx.app.get(
    "/api/accounting/taxes/presets",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    proOnly,
    async (c: RouteContext) =>
      c.json({ regimes: REGIMES, presets: TAX_PRESETS }),
  );

  /**
   * Installs a regime's rates, skipping any this business already named.
   *
   * Idempotent by name for the same reason the standard chart is: a second
   * press must not give a business two rates called "VAT 20%", because the
   * next invoice would be raised against whichever one the picker listed
   * first and the tax summary would show the business's VAT in two rows.
   */
  ctx.app.post(
    "/api/accounting/taxes/presets",
    requireSession(),
    requirePermission({ bookkeeping: ["create"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = await c.req.json().catch(() => ({}));
      const regime = String(body.regime ?? "") as Regime;
      if (!REGIMES.includes(regime)) {
        return c.json(
          { error: `regime must be one of ${REGIMES.join(", ")}` },
          400,
        );
      }

      const existing = await db
        .select({ name: schema.taxDefinitions.name })
        .from(schema.taxDefinitions)
        .where(eq(schema.taxDefinitions.organizationId, orgId));
      const named = new Set(existing.map((row) => row.name));

      const missing = TAX_PRESETS[regime].filter(
        (preset) => !named.has(preset.name),
      );
      if (missing.length > 0) {
        await db.insert(schema.taxDefinitions).values(
          missing.map((preset) => ({
            organizationId: orgId,
            name: preset.name,
            rateBp: preset.rateBp,
            categoryCode: preset.categoryCode,
            description: preset.description ?? null,
            appliesTo: preset.appliesTo ?? "both",
            compound: preset.compound ?? false,
            withholding: preset.withholding ?? false,
            recoverable: preset.recoverable ?? true,
            regime,
            jurisdiction: preset.jurisdiction ?? null,
          })),
        );
      }
      return c.json({ added: missing.length, regime });
    },
  );

  /**
   * The part of a rate that only the books care about.
   *
   * Invoicing owns the name, the rate and the category, because they are what
   * appears on a document. Whether the tax compounds, is withheld or comes back
   * on a purchase changes the journal entry rather than the document, so it is
   * set here.
   */
  ctx.app.patch(
    "/api/accounting/taxes/:id",
    requireSession(),
    requirePermission({ bookkeeping: ["update"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("id") ?? "";
      if (!isUuid(id)) return c.json({ error: "not found" }, 404);
      const body = await c.req.json().catch(() => ({}));

      if (
        body.appliesTo !== undefined &&
        !["sales", "purchases", "both"].includes(String(body.appliesTo))
      ) {
        return c.json(
          { error: "appliesTo must be sales, purchases or both" },
          400,
        );
      }
      if (
        body.regime !== undefined &&
        body.regime !== null &&
        !REGIMES.includes(String(body.regime) as Regime)
      ) {
        return c.json(
          { error: `regime must be one of ${REGIMES.join(", ")}` },
          400,
        );
      }

      const [row] = await db
        .update(schema.taxDefinitions)
        .set({
          ...(body.appliesTo !== undefined
            ? { appliesTo: String(body.appliesTo) }
            : {}),
          ...(typeof body.compound === "boolean"
            ? { compound: body.compound }
            : {}),
          ...(typeof body.withholding === "boolean"
            ? { withholding: body.withholding }
            : {}),
          ...(typeof body.recoverable === "boolean"
            ? { recoverable: body.recoverable }
            : {}),
          ...(body.regime !== undefined
            ? { regime: body.regime ? String(body.regime) : null }
            : {}),
          ...(body.jurisdiction !== undefined
            ? { jurisdiction: body.jurisdiction || null }
            : {}),
        })
        .where(
          and(
            eq(schema.taxDefinitions.id, id),
            eq(schema.taxDefinitions.organizationId, orgId),
          ),
        )
        .returning();
      if (!row) return c.json({ error: "not found" }, 404);
      return c.json({ tax: row });
    },
  );
}

/**
 * What a set of rates comes to on one amount, in the order they stack.
 *
 * Simple rates are charged on the net. A compound rate is charged on the net
 * *plus* whatever the simple rates already added — which is what "compound"
 * means, and getting it wrong understates the tax on every document in a
 * province that stacks.
 */
export function taxOn(
  netCents: number,
  rates: { rateBp: number; compound?: boolean }[],
): number {
  const simple = rates.filter((rate) => !rate.compound);
  const compound = rates.filter((rate) => rate.compound);

  let tax = 0;
  for (const rate of simple) {
    tax += Math.round((netCents * rate.rateBp) / 10000);
  }
  for (const rate of compound) {
    tax += Math.round(((netCents + tax) * rate.rateBp) / 10000);
  }
  return tax;
}
