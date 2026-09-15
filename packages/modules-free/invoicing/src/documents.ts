import { and, db, eq, schema } from "@sentrello/db";
import {
  type Discount,
  type DocumentLine,
  MoneyError,
  bpToPpm,
  documentTotals,
} from "@sentrello/db/money";

/**
 * Writing an invoice or a quote, and the tax breakdown that goes with it.
 *
 * One path for both, because they are the same document at different moments:
 * a quote is what is being asked for, an invoice is what is owed, and the
 * arithmetic that decides either is identical. The reference keeps two nearly
 * identical services and they have already drifted — its quote totals do not
 * carry the banded tax its invoices do.
 *
 * Everything here runs inside the caller's transaction. A document whose lines
 * were written but whose tax bands were not is a document that will report one
 * figure on screen and another on a tax return.
 */

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface IncomingLine {
  billableItemId?: string | null;
  description?: unknown;
  /** Whole units, or thousandths for the fractional case. One or the other. */
  quantity?: unknown;
  quantityMilli?: unknown;
  /**
   * The price of one, in cents.
   *
   * Both spellings are accepted. `unitPrice` is what the recurring job, the
   * project and deal modules and every existing screen send; `unitPriceCents`
   * is the clearer name and what the column is called. Renaming without
   * accepting the old one would have silently refused every caller that has
   * been working for months.
   */
  unitPriceCents?: unknown;
  unitPrice?: unknown;
  unit?: unknown;
  taxDefinitionId?: string | null;
  /**
   * Every named rate on the line, in charging order.
   *
   * The multi-tax spelling — Canada's GST beside a PST is two entries here.
   * `taxDefinitionId` above remains the single-tax spelling every existing
   * caller sends; a line that sends both is read from this list alone.
   */
  taxDefinitionIds?: unknown;
  /** Millionths — 99,750 is 9.975%. Wins when both rate fields are sent. */
  taxRatePpm?: unknown;
  /** @deprecated Basis points, read as `bp × 100`. */
  taxRateBp?: unknown;
  /** Which invoice it came from, when several were merged. */
  sourceNumber?: string | null;
}

export interface PreparedDocument {
  lines: {
    billableItemId: string | null;
    description: string;
    quantity: number;
    quantityMilli: number;
    unitPriceCents: number;
    unit: string;
    taxDefinitionId: string | null;
    taxRateBp: number;
    taxRatePpm: number;
    /** Frozen copies of every named rate on the line; null for a bare rate. */
    taxes:
      | {
          taxDefinitionId: string | null;
          name: string;
          rateBp: number;
          ratePpm: number;
          categoryCode: string;
          compound: boolean;
        }[]
      | null;
    sortOrder: number;
    sourceNumber: string | null;
  }[];
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  bands: ReturnType<typeof documentTotals>["bands"];
}

/**
 * Quantity, in thousandths.
 *
 * A line may arrive either way: the screens send `quantityMilli` so "1.5
 * hours" survives, and everything written before them sends a whole
 * `quantity`. Accepting both means the older callers keep working rather than
 * silently billing a quarter of a day as nothing.
 */
function quantityMilliOf(line: IncomingLine, index: number): number {
  if (line.quantityMilli !== undefined) {
    const value = line.quantityMilli;
    if (!Number.isInteger(value) || (value as number) < 0) {
      throw new MoneyError(
        `line ${index + 1}: quantityMilli must be whole thousandths`,
      );
    }
    return value as number;
  }
  const whole = line.quantity ?? 1;
  if (typeof whole !== "number" || !Number.isFinite(whole) || whole < 0) {
    throw new MoneyError(`line ${index + 1}: quantity must be a number`);
  }
  return Math.round(whole * 1000);
}

/**
 * Everything a document needs written, worked out before anything is written.
 *
 * The tax rates are read from the definitions rather than trusted from the
 * browser: a line that names a rate must be charged at what that rate actually
 * is, or the price on the document and the price in the tax summary are two
 * different numbers. A line that names no definition may still carry a bare
 * rate, which is what the older callers send.
 */
export async function prepareDocument(
  orgId: string,
  incoming: IncomingLine[],
  discount: Discount = null,
): Promise<PreparedDocument> {
  if (!Array.isArray(incoming) || incoming.length === 0) {
    throw new MoneyError("a document needs at least one line");
  }

  /**
   * The named rates on a line, whichever way they were spelled.
   *
   * The multi-tax list wins when both arrive, because a browser that sends
   * both is a browser that was showing the list. A duplicate inside one line
   * is refused rather than deduplicated — charging the same tax twice is a
   * typo, and silently halving it hides the mistake from the person making it.
   */
  const idsOf = (line: IncomingLine, index: number): string[] => {
    if (line.taxDefinitionIds !== undefined) {
      if (!Array.isArray(line.taxDefinitionIds)) {
        throw new MoneyError(`line ${index + 1}: taxDefinitionIds is a list`);
      }
      const ids = line.taxDefinitionIds.filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      );
      if (ids.length !== line.taxDefinitionIds.length) {
        throw new MoneyError(`line ${index + 1}: unreadable tax on the line`);
      }
      if (new Set(ids).size !== ids.length) {
        throw new MoneyError(
          `line ${index + 1}: the same tax is on the line twice`,
        );
      }
      return ids;
    }
    return typeof line.taxDefinitionId === "string" && line.taxDefinitionId
      ? [line.taxDefinitionId]
      : [];
  };

  const wanted = [...new Set(incoming.flatMap((l, i) => idsOf(l, i)))];

  const definitions = new Map<
    string,
    {
      name: string;
      rateBp: number;
      ratePpm: number | null;
      categoryCode: string;
      compound: boolean;
    }
  >();
  for (const id of wanted) {
    const [found] = await db
      .select({
        id: schema.taxDefinitions.id,
        name: schema.taxDefinitions.name,
        rateBp: schema.taxDefinitions.rateBp,
        ratePpm: schema.taxDefinitions.ratePpm,
        categoryCode: schema.taxDefinitions.categoryCode,
        compound: schema.taxDefinitions.compound,
      })
      .from(schema.taxDefinitions)
      .where(
        and(
          eq(schema.taxDefinitions.id, id),
          eq(schema.taxDefinitions.organizationId, orgId),
        ),
      )
      .limit(1);
    // A rate from another business, or one that has been deleted outright, is
    // refused rather than treated as zero — charging no tax by accident is the
    // expensive direction.
    if (!found) throw new MoneyError("that tax rate does not exist");
    definitions.set(id, found);
  }

  const lines = incoming.map((line, i) => {
    const description = String(line.description ?? "").trim();
    if (!description)
      throw new MoneyError(`line ${i + 1}: a description is required`);

    const quantityMilli = quantityMilliOf(line, i);
    const unitPriceCents = line.unitPriceCents ?? line.unitPrice;
    if (!Number.isInteger(unitPriceCents)) {
      throw new MoneyError(
        `line ${i + 1}: unitPrice must be a whole number of cents`,
      );
    }

    // Every named rate on the line, frozen from its definition. Null when the
    // line carries only a bare rate, which is what the older callers send.
    const named = idsOf(line, i).map((id) => {
      const definition = definitions.get(id);
      if (!definition) throw new MoneyError("that tax rate does not exist");
      // A definition saved before the finer unit has only basis points;
      // ×100 is the identical rate.
      const ratePpm = definition.ratePpm ?? bpToPpm(definition.rateBp);
      return {
        taxDefinitionId: id,
        name: definition.name,
        rateBp: Math.round(ratePpm / 100),
        ratePpm,
        categoryCode: definition.categoryCode,
        compound: definition.compound,
      };
    });
    const first = named[0];
    const taxRatePpm = first
      ? first.ratePpm
      : Number.isInteger(line.taxRatePpm)
        ? (line.taxRatePpm as number)
        : Number.isInteger(line.taxRateBp)
          ? bpToPpm(line.taxRateBp as number)
          : 0;

    return {
      billableItemId: line.billableItemId ?? null,
      description,
      // Both kept: `quantity` is what everything written before this reads.
      quantity: Math.round(quantityMilli / 1000),
      quantityMilli,
      unitPriceCents: unitPriceCents as number,
      unit: String(line.unit ?? "piece").trim() || "piece",
      // The first tax also lands in the single-tax columns, so anything still
      // reading them sees a tax rather than none. The list is the truth.
      taxDefinitionId: first?.taxDefinitionId ?? null,
      taxRateBp: Math.round(taxRatePpm / 100),
      taxRatePpm,
      taxes: named.length > 0 ? named : null,
      sortOrder: i,
      sourceNumber: line.sourceNumber ?? null,
    };
  });

  const totals = documentTotals(
    lines.map(
      (l): DocumentLine => ({
        quantity: l.quantityMilli / 1000,
        unitPrice: l.unitPriceCents,
        taxRatePpm: l.taxRatePpm,
        taxDefinitionId: l.taxDefinitionId,
        taxes: l.taxes,
      }),
    ),
    discount,
  );

  return {
    lines,
    subtotalCents: totals.subtotal,
    discountCents: totals.discount,
    taxCents: totals.tax,
    totalCents: totals.total,
    bands: totals.bands,
  };
}

/**
 * Replaces a document's tax breakdown with the one just worked out.
 *
 * Deleted and rewritten rather than merged: a band that no longer applies —
 * because the only line at that rate was removed — has to disappear, and a
 * merge leaves it there reporting tax on a document that no longer charges it.
 */
export async function writeTaxBands(
  tx: Tx,
  orgId: string,
  documentType: "invoice" | "quote",
  documentId: string,
  bands: PreparedDocument["bands"],
): Promise<void> {
  await tx
    .delete(schema.documentTaxes)
    .where(
      and(
        eq(schema.documentTaxes.documentType, documentType),
        eq(schema.documentTaxes.documentId, documentId),
      ),
    );

  if (bands.length === 0) return;
  await tx.insert(schema.documentTaxes).values(
    bands.map((band) => ({
      organizationId: orgId,
      documentType,
      documentId,
      taxDefinitionId: band.taxDefinitionId,
      name: band.name,
      rateBp: band.rateBp,
      ratePpm: band.ratePpm,
      categoryCode: band.categoryCode,
      taxableCents: band.taxableCents,
      taxCents: band.taxCents,
    })),
  );
}

/** A discount as the browser sent it, or nothing. */
export function parseDiscount(body: {
  discountType?: unknown;
  discountValue?: unknown;
}): Discount {
  const type = body.discountType;
  if (type !== "percent" && type !== "amount") return null;
  const value = body.discountValue;
  if (!Number.isInteger(value)) {
    throw new MoneyError(
      type === "percent"
        ? "a percentage discount is whole basis points (500 = 5%)"
        : "a fixed discount is a whole number of cents",
    );
  }
  return { type, value: value as number };
}

/**
 * The early-payment offer as the browser sent it.
 *
 * Refused rather than silently dropped when it is half filled in: an offer of
 * 2% with no number of days is a discount with no deadline, which is a
 * discount for ever, and nobody would have meant that.
 */
export function parseEarlyPayment(body: {
  earlyDiscountType?: unknown;
  earlyDiscountValue?: unknown;
  earlyDiscountDays?: unknown;
}): { type: string | null; value: number; days: number | null } {
  const type = body.earlyDiscountType;
  if (type !== "percent" && type !== "amount") {
    return { type: null, value: 0, days: null };
  }
  const value = body.earlyDiscountValue;
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new MoneyError(
      type === "percent"
        ? "an early-payment percentage is whole basis points (200 = 2%)"
        : "an early-payment discount is a whole number of cents",
    );
  }
  const days = body.earlyDiscountDays;
  if (!Number.isInteger(days) || (days as number) < 0) {
    throw new MoneyError("how many days is the offer good for?");
  }
  return { type, value: value as number, days: days as number };
}

/**
 * A token for a link somebody can open without an account.
 *
 * The whole credential is in the URL, so it is long and random rather than
 * guessable. Twenty-four bytes: enough that guessing is not a strategy, short
 * enough to survive being pasted into an email client.
 */
export function shareToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
