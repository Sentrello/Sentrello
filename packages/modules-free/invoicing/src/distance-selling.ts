import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, inArray, ne, schema } from "@sentrello/db";
import type { PostedSale } from "@sentrello/db/sale-place";
import { postedSales } from "@sentrello/db/sale-place";
import type { ModuleContext } from "@sentrello/module-sdk";

/**
 * The EU distance-selling threshold, watched rather than guessed at.
 *
 * An EU business selling to consumers in other member states charges its own
 * country's VAT — until its cross-border B2C sales pass €10,000 across the
 * union, after which VAT is due in each customer's country instead, normally
 * reported through the Union OSS scheme. The old per-country thresholds are
 * gone; this one figure is the whole rule.
 *
 * A one-person business selling a few hundred euros over a border should not
 * meet OSS machinery on day one, so nothing here changes what an invoice
 * charges. This watches the figures and says, plainly, which side of the
 * line the business is on — the decision to register is theirs, and their
 * accountant's.
 */

/**
 * €10,000, in cents, across the whole EU per calendar year — the current
 * *and* the preceding one both have to stay under it for home-country VAT to
 * keep applying. Article 59c of Directive 2006/112/EC; figure confirmed
 * against the Commission's OSS portal (vat-one-stop-shop.ec.europa.eu),
 * checked 15 September 2026.
 */
export const DISTANCE_SELLING_THRESHOLD_CENTS = 1_000_000;

/** The member states, by the atlas codes company records carry. */
const EU_MEMBERS = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "EL", // Greece as the VAT register spells it, for the record typed that way
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
]);

export const euCountry = (raw: string | null | undefined): string | null => {
  const code = raw?.trim().toUpperCase() ?? "";
  if (!EU_MEMBERS.has(code)) return null;
  return code === "EL" ? "GR" : code;
};

/**
 * Whether a sale to this customer is B2C — the question both the threshold and
 * the OSS return turn on, asked once.
 *
 * No VAT number on record is a consumer: a registration is what makes a sale
 * B2B, and its absence is the only signal there is. A number VIES has said is
 * *invalid* is a consumer too — the register having refused it is precisely the
 * case where the seller cannot rely on the reverse charge, so the supply is
 * B2C for VAT whatever the customer believes. A number nobody has checked is
 * taken at face value, because a business that recorded one meant something by
 * it and the platform is not its tax inspector.
 *
 * Shared rather than written twice: a threshold position and a return that
 * disagreed about which sales were B2C would leave a business unable to
 * reconcile the two figures we showed it.
 */
export function isConsumerSupply(
  taxIdentifier: string | null | undefined,
  taxIdentifierValid: boolean | null | undefined,
): boolean {
  if (!taxIdentifier?.trim()) return true;
  return taxIdentifierValid === false;
}

export interface DistanceSalesPosition {
  /** False for a seller outside the EU — the threshold is not theirs. */
  applies: boolean;
  /** The organisation's base currency; the sums below are in its cents. */
  currency?: string;
  yearCents?: number;
  priorYearCents?: number;
  /**
   * Sales in the two years that nothing placed in any country.
   *
   * Beside the totals rather than folded into them: a business sitting under
   * the threshold needs to know whether it is under it or merely unable to
   * say. Zero here means every sale was placed, which is a different fact
   * from a small figure above.
   */
  unplacedCents?: number;
  /**
   * Member states sold into with no VAT charged and no rate on record.
   *
   * A different problem from the threshold beside it, and a worse one. The
   * threshold is a line a business may cross next year; this is money already
   * owed. VAT on a cross-border sale to a consumer is due in the customer's
   * own country from the first sale, with no small-seller threshold under it
   * for a digital supply — so a shop that has not set a Belgian rate and sold
   * a download into Belgium has kept Belgium's VAT without knowing.
   *
   * Only where nothing recorded a rate at all. A band saying 0% is a zero
   * somebody chose, and it is not this.
   */
  unratedStates?: { memberState: string; sales: number; netCents: number }[];
  /** Null when the base currency is not the euro — see below. */
  thresholdCents?: number | null;
  exceeded?: boolean | null;
}

/**
 * Where the business stands against the threshold, from its own books.
 *
 * What counts: sales to consumers in *other* member states — no VAT number on
 * record is what makes a sale B2C for VAT. Credit notes subtract, because the
 * ledger reads them as negative movement on income without anybody having to
 * ask which kind of document it was. Sums are net of VAT, because the
 * directive counts the value of the supplies and tax posts to its own account.
 *
 * Read from posted entries and the place recorded on each sale. It used to
 * read invoice rows and join through a contact to a company for the country,
 * which had the two faults the OSS return had: a storefront sale has no
 * invoice row to find, and a consumer is a person with no company, so the join
 * dropped exactly the customer this threshold is about. A threshold for
 * business-to-consumer distance selling that could not see a consumer would
 * have told a business it was under €10,000 while it was over.
 *
 * The nine member states outside the euro state the threshold in their own
 * currency; for a base currency other than EUR the totals are reported and the
 * comparison left open, with the threshold null.
 */
export async function distanceSalesPosition(
  orgId: string,
  now: Date = new Date(),
): Promise<DistanceSalesPosition> {
  const [org] = await db
    .select({
      countryCode: schema.organizations.countryCode,
      baseCurrency: schema.organizations.baseCurrency,
    })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId))
    .limit(1);

  const seller = euCountry(org?.countryCode);
  if (!seller) return { applies: false };

  const yearOf = (year: number) => ({
    from: new Date(Date.UTC(year, 0, 1)),
    to: new Date(Date.UTC(year + 1, 0, 1) - 1),
  });
  const year = now.getUTCFullYear();
  const [thisYear, lastYear] = await Promise.all([
    postedSales(orgId, yearOf(year)),
    postedSales(orgId, yearOf(year - 1)),
  ]);

  let unplacedCents = 0;
  /** Cross-border consumer sales that carried no VAT — see `unratedStates`. */
  const untaxed: {
    memberState: string;
    documentId: string | null;
    netCents: number;
  }[] = [];
  const crossBorderToConsumers = (sales: PostedSale[]): number => {
    let cents = 0;
    for (const sale of sales) {
      if (!sale.place) {
        unplacedCents += sale.netCents;
        continue;
      }
      const buyer = euCountry(sale.place.country);
      if (!buyer || buyer === seller) continue; // domestic or outside the EU
      // Registered and unrefuted: B2B, and not distance selling.
      if (
        !isConsumerSupply(
          sale.place.taxIdentifier,
          sale.place.taxIdentifierValid,
        )
      ) {
        continue;
      }
      if (sale.vatCents === 0) {
        untaxed.push({
          memberState: buyer,
          documentId: sale.place.documentId,
          netCents: sale.netCents,
        });
      }
      cents += sale.netCents;
    }
    return cents;
  };
  const yearCents = crossBorderToConsumers(thisYear);
  const priorYearCents = crossBorderToConsumers(lastYear);
  const unratedStates = await unrated(orgId, untaxed);

  const inEuros = (org?.baseCurrency ?? "USD") === "EUR";
  return {
    applies: true,
    currency: org?.baseCurrency ?? "USD",
    yearCents,
    priorYearCents,
    unplacedCents,
    unratedStates,
    thresholdCents: inEuros ? DISTANCE_SELLING_THRESHOLD_CENTS : null,
    exceeded: inEuros
      ? yearCents > DISTANCE_SELLING_THRESHOLD_CENTS ||
        priorYearCents > DISTANCE_SELLING_THRESHOLD_CENTS
      : null,
  };
}

/**
 * Which member states were sold into with nothing charged and no rate set.
 *
 * The distinction this turns on is the whole point of it: a sale with a tax
 * band saying 0% was charged nothing on purpose — somebody recorded that rate
 * — and belongs nowhere near a warning. A sale with no band at all had no rate
 * to apply, and the zero is the shape of a lookup that found nothing.
 *
 * States whose sales net to nothing or less drop out. A country whose only
 * trade was refunded is not a country anybody needs to set a rate for.
 */
async function unrated(
  orgId: string,
  untaxed: {
    memberState: string;
    documentId: string | null;
    netCents: number;
  }[],
): Promise<{ memberState: string; sales: number; netCents: number }[]> {
  if (untaxed.length === 0) return [];
  const ids = untaxed
    .map((sale) => sale.documentId)
    .filter((id): id is string => Boolean(id));
  const rated = new Set<string>();
  if (ids.length > 0) {
    const bands = await db
      .select({ documentId: schema.documentTaxes.documentId })
      .from(schema.documentTaxes)
      .where(
        and(
          eq(schema.documentTaxes.organizationId, orgId),
          ne(schema.documentTaxes.documentType, "quote"),
          inArray(schema.documentTaxes.documentId, ids),
        ),
      );
    for (const band of bands) rated.add(band.documentId);
  }

  const byState = new Map<
    string,
    { memberState: string; sales: number; netCents: number }
  >();
  for (const sale of untaxed) {
    if (sale.documentId && rated.has(sale.documentId)) continue;
    const found = byState.get(sale.memberState) ?? {
      memberState: sale.memberState,
      sales: 0,
      netCents: 0,
    };
    found.sales += 1;
    found.netCents += sale.netCents;
    byState.set(sale.memberState, found);
  }
  return [...byState.values()]
    .filter((state) => state.netCents > 0)
    .sort((a, b) => a.memberState.localeCompare(b.memberState));
}

export function registerDistanceSelling(ctx: ModuleContext) {
  ctx.app.get(
    "/api/invoicing/distance-sales",
    requireSession(),
    requirePermission({ invoicing: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const position = await distanceSalesPosition(orgId);
      /*
       * Said first, and said even to a business under the threshold.
       *
       * The threshold decides *where* VAT on a cross-border sale is due. It
       * does not decide whether any is due at all — a digital supply to a
       * consumer is taxable in their own country from the first one, with no
       * threshold under it — so a business sitting comfortably under €10,000
       * can still be keeping VAT it owes. Reading only the reassuring sentence
       * below is how it would stay that way.
       */
      const unrated = position.unratedStates ?? [];
      const warning =
        unrated.length === 0
          ? null
          : `You have sold to consumers in ${unrated.map((s) => s.memberState).join(", ")} and charged no VAT, with no rate set for ${unrated.length === 1 ? "it" : "them"}. VAT on a cross-border sale to a consumer is due in their country from the first sale — there is no threshold under it for digital supplies. Set a rate for each, then talk to your accountant about the sales already made.`;
      return c.json({
        ...position,
        warning,
        advice: !position.applies
          ? null
          : position.exceeded
            ? "Cross-border sales to EU consumers have passed the €10,000 EU-wide threshold: VAT is due in each customer's country. The Union OSS scheme reports it all through your own country's portal — talk to your accountant about registering."
            : position.exceeded === false
              ? "Cross-border sales to EU consumers are under the €10,000 EU-wide threshold in both this year and last, so your own country's VAT applies to them."
              : "Your base currency is not the euro, so compare these totals with the threshold in your member state's own currency.",
      });
    },
  );
}
