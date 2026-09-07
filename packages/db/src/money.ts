export type TaxedLine = {
  quantity: number;
  unitPrice: number;
  taxRateBp: number;
};

/**
 * Money is integer cents and tax is basis points, so anything else is a bug
 * upstream — a missing field, a string from a form, a float from a spreadsheet.
 *
 * This used to let it through: a line with the wrong field name multiplied out
 * to NaN, sailed through the totals, and only stopped at Postgres, which
 * answered with a 500 and a stack trace. Money arithmetic must not be able to
 * produce a value that is not money, and the failure belongs here, where every
 * caller routes through, rather than in each route that builds a line.
 */
export class MoneyError extends Error {}

function cents(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MoneyError(`${field} must be a number in cents`);
  }
  if (!Number.isInteger(value)) {
    throw new MoneyError(`${field} must be a whole number of cents`);
  }
  return value;
}

export function lineTotals(lines: TaxedLine[]) {
  let subtotal = 0;
  let tax = 0;
  for (const [i, l] of lines.entries()) {
    // Quantity may legitimately be fractional — 2.5 hours, 1.5 metres — so it
    // is checked for being a finite number, not for being whole.
    const quantity = l?.quantity;
    if (typeof quantity !== "number" || !Number.isFinite(quantity)) {
      throw new MoneyError(`line ${i + 1}: quantity must be a number`);
    }
    const unitPrice = cents(l?.unitPrice, `line ${i + 1}: unitPrice`);
    const taxRateBp = cents(l?.taxRateBp ?? 0, `line ${i + 1}: taxRateBp`);

    // Rounded per line: a fractional quantity times a price in cents is not
    // necessarily a whole number of cents, and the total must be.
    const net = Math.round(quantity * unitPrice);
    subtotal += net;
    tax += Math.round((net * taxRateBp) / 10000);
  }
  return { subtotal, tax, total: subtotal + tax };
}

export function invoiceStatus(totalCents: number, paidCents: number) {
  const due = totalCents - paidCents;
  return {
    balanceDue: due,
    status: due <= 0 ? "paid" : paidCents > 0 ? "partial" : "open",
  };
}

/**
 * Pay early, pay less.
 *
 * Skonto: an invoice offers a percentage or a fixed sum off if it is settled
 * within so many days of being issued. Widespread in Germany and Austria,
 * ordinary enough elsewhere, and the reference product supports it — a
 * business that offers 2% for 10 days and cannot say so on the invoice is
 * doing the arithmetic in an email instead.
 *
 * Worked out here rather than in the route because three places need the same
 * answer and must not disagree: the form that offers it, the page the customer
 * opens, and the moment a payment is recorded against it. Two of those are
 * read by somebody deciding whether to pay today.
 */
export interface EarlyPaymentOffer {
  type: string | null;
  /** Basis points when percent, cents when an amount. */
  value: number;
  days: number | null;
  issueDate: Date;
  totalCents: number;
}

export interface EarlyPaymentTerms {
  /** Null when nothing is offered. */
  deadline: Date | null;
  savingCents: number;
  /** What settles the invoice in full if paid by the deadline. */
  discountedTotalCents: number;
  /** Whether the offer stands at the moment asked about. */
  open: boolean;
}

export function earlyPaymentTerms(
  offer: EarlyPaymentOffer,
  on: Date = new Date(),
): EarlyPaymentTerms {
  const none: EarlyPaymentTerms = {
    deadline: null,
    savingCents: 0,
    discountedTotalCents: offer.totalCents,
    open: false,
  };
  if (!offer.type || offer.value <= 0) return none;
  if (offer.days === null || !Number.isInteger(offer.days) || offer.days < 0) {
    return none;
  }
  if (Number.isNaN(offer.issueDate.getTime())) return none;

  /**
   * The end of the day, not the moment of issue plus n×24h.
   *
   * "Within 10 days" means the tenth day counts, all of it. Somebody paying at
   * four in the afternoon on the last day has met the terms, and an invoice
   * that says otherwise is one nobody trusts twice.
   */
  const deadline = new Date(offer.issueDate);
  deadline.setDate(deadline.getDate() + offer.days);
  deadline.setHours(23, 59, 59, 999);

  const raw =
    offer.type === "percent"
      ? Math.round((offer.totalCents * offer.value) / 10000)
      : offer.value;
  // Never more than the invoice: a mistyped offer must not produce a document
  // that owes the customer money. That is what a credit note is for.
  const savingCents = Math.max(0, Math.min(raw, offer.totalCents));

  return {
    deadline,
    savingCents,
    discountedTotalCents: offer.totalCents - savingCents,
    open: on.getTime() <= deadline.getTime(),
  };
}

/**
 * A document total, with a discount and the tax banded by rate.
 *
 * `lineTotals` above answers "what do these lines come to". This answers what
 * a document actually asks for, which is a different and harder question once
 * there is a discount on it — because a discount changes the taxable amount,
 * and the tax has to be worked out after it rather than before.
 *
 * The order is the one every tax authority expects and the reference gets
 * right: net line totals, then the discount, then tax on what is left. Taxing
 * first and discounting after overstates the tax, which is money the business
 * pays and cannot get back.
 */

export type DocumentLine = TaxedLine & {
  /** Which named rate this was charged at, for the banded breakdown. */
  taxDefinitionId?: string | null;
  taxName?: string | null;
  categoryCode?: string | null;
};

export type Discount =
  | { type: "percent"; value: number }
  | { type: "amount"; value: number }
  | null;

export interface TaxBand {
  taxDefinitionId: string | null;
  name: string;
  rateBp: number;
  categoryCode: string;
  taxableCents: number;
  taxCents: number;
}

export interface DocumentTotals {
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  bands: TaxBand[];
}

export function documentTotals(
  lines: DocumentLine[],
  discount: Discount = null,
): DocumentTotals {
  // Net per line first, so the discount has something to be a share of.
  const nets: number[] = [];
  let subtotal = 0;
  for (const [i, l] of lines.entries()) {
    const quantity = l?.quantity;
    if (typeof quantity !== "number" || !Number.isFinite(quantity)) {
      throw new MoneyError(`line ${i + 1}: quantity must be a number`);
    }
    const unitPrice = cents(l?.unitPrice, `line ${i + 1}: unitPrice`);
    cents(l?.taxRateBp ?? 0, `line ${i + 1}: taxRateBp`);
    const net = Math.round(quantity * unitPrice);
    nets.push(net);
    subtotal += net;
  }

  let discountCents = 0;
  if (discount) {
    const value = cents(
      discount.value,
      discount.type === "percent" ? "discount basis points" : "discount cents",
    );
    if (value < 0) throw new MoneyError("a discount cannot be negative");
    discountCents =
      discount.type === "percent"
        ? Math.round((subtotal * value) / 10000)
        : value;
    // A discount larger than the document is a typo, not a refund. Capping it
    // keeps the total at zero rather than producing an invoice that owes the
    // customer money — which is what a credit note is for.
    discountCents = Math.min(discountCents, subtotal);
  }

  /**
   * The discount spread across the lines, so each band is taxed on what it
   * actually cost.
   *
   * Apportioned by share of the subtotal, with the remainder given to the
   * largest line. Splitting a 10.00 discount across three equal lines is
   * 3.33 + 3.33 + 3.33 = 9.99, and the missing cent has to land somewhere or
   * the bands will not add up to the total.
   */
  const relief: number[] = nets.map((net) =>
    subtotal > 0 ? Math.round((discountCents * net) / subtotal) : 0,
  );
  const spread = relief.reduce((sum, r) => sum + r, 0);
  if (spread !== discountCents && relief.length > 0) {
    let biggest = 0;
    for (let i = 1; i < nets.length; i += 1) {
      if ((nets[i] as number) > (nets[biggest] as number)) biggest = i;
    }
    relief[biggest] = (relief[biggest] as number) + (discountCents - spread);
  }

  const byBand = new Map<string, TaxBand>();
  let tax = 0;
  for (const [i, l] of lines.entries()) {
    const rateBp = l?.taxRateBp ?? 0;
    const taxable = (nets[i] as number) - (relief[i] as number);
    const lineTax = Math.round((taxable * rateBp) / 10000);
    tax += lineTax;

    // Banded by the rate actually charged, not by the definition: two rates
    // that happen to be equal are one line on a tax summary, and a rate that
    // was renamed is still the rate this document was issued at.
    const key = `${l?.taxDefinitionId ?? ""}|${rateBp}|${l?.categoryCode ?? "S"}`;
    const band = byBand.get(key) ?? {
      taxDefinitionId: l?.taxDefinitionId ?? null,
      name: l?.taxName ?? (rateBp === 0 ? "No tax" : `${rateBp / 100}%`),
      rateBp,
      categoryCode: l?.categoryCode ?? "S",
      taxableCents: 0,
      taxCents: 0,
    };
    band.taxableCents += taxable;
    band.taxCents += lineTax;
    byBand.set(key, band);
  }

  return {
    subtotal,
    discount: discountCents,
    tax,
    total: subtotal - discountCents + tax,
    bands: [...byBand.values()].sort((a, b) => b.rateBp - a.rateBp),
  };
}
