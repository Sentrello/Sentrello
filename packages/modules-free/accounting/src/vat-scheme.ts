import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, eq, schema } from "@sentrello/db";
import { percentFromPpm } from "@sentrello/db/money";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";
import { cashBasisVatRowsFor } from "./cash-basis";
import { ledgerRows, periodFrom } from "./reports";
import {
  type LimitedCostFigures,
  type VatReturn,
  flatRateVatReturn,
  forHmrc,
  limitedCostFigures,
  vatReturn,
} from "./vat-return";

/**
 * Which VAT scheme a business is on, and the return computed under it.
 *
 * Two schemes beyond the standard one, both common among the businesses this
 * is sold to. The **Flat Rate Scheme** replaces the arithmetic: VAT due is a
 * sector percentage of gross turnover, and the ordinary input reclaim goes
 * away. **Cash accounting** replaces the timing: VAT follows the money, not
 * the invoice. They combine — the flat rate on cash-based turnover is HMRC's
 * own variant of the scheme.
 *
 * Both are elections a business makes with HMRC, so both are settings and
 * neither is ever inferred. The sector percentage in particular is chosen
 * from HMRC's table by the business — their accountant, properly — and the
 * software's whole job is to apply the choice, not to make it.
 *
 * Scheme eligibility figures quoted to the user below were checked against
 * gov.uk (vat-flat-rate-scheme, vat-cash-accounting-scheme) on
 * 15 September 2026: flat rate is open under £150,000 of annual turnover
 * (excluding VAT) and left above £230,000 (including VAT); cash accounting is
 * open up to £1.35m and left above £1.6m; the limited cost rate is 16.5%,
 * against relevant goods under 2% of turnover or under £1,000 a year. These
 * change; the date travels with the figures wherever they are shown.
 */

export interface VatScheme {
  scheme: "standard" | "flat-rate";
  /** The sector percentage in millionths, null until the business sets it. */
  flatRatePpm: number | null;
  basis: "accrual" | "cash";
}

export async function vatSchemeFor(orgId: string): Promise<VatScheme> {
  const [row] = await db
    .select({
      vatScheme: schema.ledgerSettings.vatScheme,
      vatFlatRatePpm: schema.ledgerSettings.vatFlatRatePpm,
      vatBasis: schema.ledgerSettings.vatBasis,
    })
    .from(schema.ledgerSettings)
    .where(eq(schema.ledgerSettings.organizationId, orgId))
    .limit(1);
  return {
    scheme: row?.vatScheme === "flat-rate" ? "flat-rate" : "standard",
    flatRatePpm: row?.vatFlatRatePpm ?? null,
    basis: row?.vatBasis === "cash" ? "cash" : "accrual",
  };
}

/**
 * The nine boxes for a period, computed under whatever scheme the business
 * elected — the one computation the preview screen and the MTD submission
 * both read, so what a person checks and what is filed cannot be two
 * different arithmetics.
 *
 * The figures come from the ledger and the stored election, never from a
 * request body. That is what keeps the digital-links property true across
 * every scheme: a browser cannot supply a box, only a period.
 */
export async function vatBoxesFor(
  orgId: string,
  period: { from?: Date; to?: Date },
): Promise<{
  scheme: VatScheme;
  boxes: VatReturn;
  limitedCost?: LimitedCostFigures;
}> {
  const scheme = await vatSchemeFor(orgId);
  /*
   * The cash basis reads the whole history: the VAT on a March invoice paid
   * in May belongs to May's return, and May's rows alone cannot say so.
   */
  const rows =
    scheme.basis === "cash"
      ? await cashBasisVatRowsFor(orgId, period)
      : await ledgerRows(orgId, period);

  if (scheme.scheme === "flat-rate") {
    if (scheme.flatRatePpm === null) {
      throw new Error(
        "the flat rate scheme needs its sector percentage set before a return can be computed",
      );
    }
    return {
      scheme,
      boxes: flatRateVatReturn(rows, scheme.flatRatePpm),
      limitedCost: limitedCostFigures(rows),
    };
  }
  return { scheme, boxes: vatReturn(rows) };
}

/**
 * What the screen says under the boxes — the scheme, its consequences, and
 * the honest limits. Words rather than flags, because the reader is a person
 * deciding whether to attest to a legal declaration.
 */
export function vatReturnNotes(out: {
  scheme: VatScheme;
  limitedCost?: LimitedCostFigures;
}): string[] {
  const notes: string[] = [];

  if (out.scheme.scheme === "flat-rate" && out.scheme.flatRatePpm !== null) {
    notes.push(
      `Computed under the Flat Rate Scheme at your sector's ${percentFromPpm(out.scheme.flatRatePpm)}% of gross (VAT-inclusive) turnover. Box 6 shows that gross turnover — HMRC's rule for this scheme. VAT on purchases is not reclaimed; the scheme's exception for single capital asset purchases of £2,000 or more is not modelled here, so if you make one, account for it yourself.`,
    );
  }

  if (out.limitedCost) {
    const pounds = (cents: number) => `£${(cents / 100).toFixed(2)}`;
    notes.push(
      `Limited cost check — the figures, not the verdict: gross turnover ${pounds(out.limitedCost.grossTurnoverCents)}; 2% of that is ${pounds(out.limitedCost.twoPercentOfTurnoverCents)}; everything recorded as an expense this period totals ${pounds(out.limitedCost.spendingCents)}. If the relevant goods you bought — goods only, excluding services, capital, vehicles, food and fuel by HMRC's rules — cost less than 2% of turnover, or less than £1,000 a year even if over 2%, the 16.5% limited cost rate applies instead of your sector's. Recorded expenses are broader than relevant goods, so that call is yours or your accountant's, and this software does not make it. Thresholds per gov.uk, checked 15 September 2026.`,
    );
  }

  if (out.scheme.basis === "cash") {
    notes.push(
      "Computed under the cash accounting scheme: VAT counts when money moves, not when an invoice is raised. One limit: a debt you write off is treated here as settled, so its VAT still appears — under the scheme an invoice nobody pays owes no VAT, so adjust for write-offs before filing.",
    );
  }

  notes.push(
    "Boxes 2, 8 and 9 — acquisitions from and supplies to the EU — are zero. If you are in Northern Ireland and trade with the EU, these need to come from somewhere else.",
    "Reverse charge, margin schemes and partial exemption are not modelled. If any apply to you, check these figures against your own records before filing.",
  );
  return notes;
}

export function registerVatScheme(ctx: ModuleContext) {
  ctx.app.get(
    "/api/accounting/vat-scheme",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const scheme = await vatSchemeFor(orgId);
      return c.json({
        ...scheme,
        /**
         * The eligibility figures, dated. Whether a business may use a scheme
         * is between it and HMRC; what the software owes it is the current
         * thresholds and the date they were checked, since they change.
         */
        reference: {
          checked: "2026-09-15",
          source: "gov.uk",
          flatRate: {
            joinUnderCents: 15_000_000,
            joinUnderIncludesVat: false,
            leaveOverCents: 23_000_000,
            leaveOverIncludesVat: true,
            limitedCostRatePpm: 165_000,
            firstYearDiscountPpm: 10_000,
          },
          cash: {
            joinUnderCents: 135_000_000,
            leaveOverCents: 160_000_000,
          },
        },
      });
    },
  );

  ctx.app.put(
    "/api/accounting/vat-scheme",
    requireSession(),
    requirePermission({ bookkeeping: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      const scheme = body.scheme ?? "standard";
      if (scheme !== "standard" && scheme !== "flat-rate") {
        return c.json({ error: "the scheme is standard or flat-rate" }, 400);
      }
      const basis = body.basis ?? "accrual";
      if (basis !== "accrual" && basis !== "cash") {
        return c.json({ error: "the basis is accrual or cash" }, 400);
      }

      /*
       * The sector percentage, in millionths. Required with the flat rate
       * scheme — a flat-rate return without it has nothing to compute — and
       * bounded to a percentage that could conceivably be one: HMRC's table
       * runs from 4% to 16.5%, and a typo'd 145% should be refused at the
       * door rather than filed.
       */
      let flatRatePpm: number | null = null;
      if (scheme === "flat-rate") {
        const raw = body.flatRatePpm;
        if (
          typeof raw !== "number" ||
          !Number.isInteger(raw) ||
          raw <= 0 ||
          raw > 200_000
        ) {
          return c.json(
            {
              error:
                "the flat rate scheme needs your sector's percentage, in millionths: 14.5% is 145000",
            },
            400,
          );
        }
        flatRatePpm = raw;
      }

      await db
        .insert(schema.ledgerSettings)
        .values({
          organizationId: orgId,
          vatScheme: scheme,
          vatFlatRatePpm: flatRatePpm,
          vatBasis: basis,
        })
        .onConflictDoUpdate({
          target: schema.ledgerSettings.organizationId,
          set: {
            vatScheme: scheme,
            vatFlatRatePpm: flatRatePpm,
            vatBasis: basis,
            updatedAt: new Date(),
          },
        });

      return c.json({ scheme, flatRatePpm, basis });
    },
  );

  /**
   * The return itself, under the elected scheme, for the period asked for.
   *
   * This is what the filing screen shows before anything can be submitted,
   * and it is computed by the same function the submission recomputes with —
   * so the figures a person attests to and the figures that go to HMRC are
   * one computation read twice, never two arithmetics that happen to agree.
   */
  ctx.app.get(
    "/api/accounting/vat-return",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const period = periodFrom((name) => c.req.query(name));
      let out: Awaited<ReturnType<typeof vatBoxesFor>>;
      try {
        out = await vatBoxesFor(orgId, period);
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }
      return c.json({
        boxes: out.boxes,
        asSubmitted: forHmrc(out.boxes),
        scheme: out.scheme,
        limitedCost: out.limitedCost ?? null,
        notCovered: vatReturnNotes(out),
      });
    },
  );
}
