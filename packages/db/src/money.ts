/**
 * Tax rates are integer millionths of the base — parts per million.
 *
 * 1% is 10,000; Quebec's QST, 9.975%, is exactly 99,750. The unit was basis
 * points (1% = 100) until that rate proved it too coarse: 9.975% has no whole
 * number of basis points, and shipping the nearest one overstates the tax on
 * every Quebec document. Millionths were chosen over tenths of a basis point
 * because real rates in the four markets already use three decimal places of
 * a percent (QST 9.975%, New York City 8.875%), and a unit with exactly one
 * more place of headroom absorbs the next odd rate without another migration.
 * The arithmetic stays strictly integer: per-line tax is
 * `Math.round(net * ratePpm / 1_000_000)`, and the intermediate product for
 * any realistic line (up to tens of millions of dollars) is far inside
 * `Number.MAX_SAFE_INTEGER`.
 *
 * Basis-point fields survive as deprecated inputs, read as `bp × 100`, so a
 * caller not yet converted computes exactly what it always did.
 */
export const RATE_SCALE_PPM = 1_000_000;

/** Basis points to millionths: 875 (8.75%) → 87,500. Lossless. */
export function bpToPpm(rateBp: number): number {
  return rateBp * 100;
}

/**
 * A rate in millionths as a percentage string, in integers throughout:
 * 99,750 → "9.975", 200,000 → "20.00". At least two decimal places, so the
 * e-invoice keeps stating "20.00" as it always has; up to four, so a fine
 * rate is stated exactly rather than rounded back to the error this unit
 * exists to remove.
 */
export function percentFromPpm(ppm: number): string {
  const sign = ppm < 0 ? "-" : "";
  const magnitude = Math.abs(ppm);
  const whole = Math.floor(magnitude / 10_000);
  const frac4 = String(magnitude % 10_000).padStart(4, "0");
  const trimmed = frac4.replace(/0+$/, "");
  return `${sign}${whole}.${trimmed.length < 2 ? frac4.slice(0, 2) : trimmed}`;
}

export type TaxedLine = {
  quantity: number;
  unitPrice: number;
  /** Millionths: 99,750 is 9.975%. Wins when both fields are present. */
  taxRatePpm?: number | null;
  /** @deprecated Basis points, read as `bp × 100`. */
  taxRateBp?: number | null;
};

/**
 * Money is integer cents and tax is millionths, so anything else is a bug
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

/**
 * The rate a line or tax actually carries, in millionths.
 *
 * The millionths field governs when present; the deprecated basis-point
 * field is honoured at ×100 so everything written before the finer unit —
 * rows, callers, whole repos — still totals to the identical cent.
 */
function resolveRatePpm(
  ppm: number | null | undefined,
  bp: number | null | undefined,
  field: string,
): number {
  if (ppm !== null && ppm !== undefined) return cents(ppm, field);
  if (bp !== null && bp !== undefined) return bpToPpm(cents(bp, field));
  return 0;
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
    const ratePpm = resolveRatePpm(
      l?.taxRatePpm,
      l?.taxRateBp,
      `line ${i + 1}: taxRatePpm`,
    );

    // Rounded per line: a fractional quantity times a price in cents is not
    // necessarily a whole number of cents, and the total must be.
    const net = Math.round(quantity * unitPrice);
    subtotal += net;
    tax += Math.round((net * ratePpm) / RATE_SCALE_PPM);
  }
  return { subtotal, tax, total: subtotal + tax };
}

/**
 * How an invoice stands, from what it asks for and what has settled it.
 *
 * Two kinds of settlement, kept apart because the word on the screen makes a
 * claim about the world: `paidCents` is money that arrived, `creditedCents`
 * is debt the business gave up by credit note. Both settle the invoice
 * identically — the balance cannot tell them apart — but the customer can,
 * and an invoice that said "paid" when nobody paid it was a false statement
 * to whoever read it. Settled entirely by credit reads `credited`.
 *
 * Partly paid and then credited for the rest reads `paid`, deliberately:
 * money did change hands, and `credited` would erase real takings from the
 * screen the way `paid` used to invent them. Neither single word tells the
 * whole mixed story, so the status keeps the claim that is true in cash
 * terms and the detail screen states the split (paid −X, credited −Y).
 *
 * Partly credited with a balance outstanding reads `partial`, the same as a
 * part payment: what matters to everyone chasing or being chased is that
 * money is still owed, and the balance says how much.
 */
export function invoiceStatus(
  totalCents: number,
  paidCents: number,
  creditedCents = 0,
) {
  const due = totalCents - paidCents - creditedCents;
  return {
    balanceDue: due,
    status:
      due <= 0
        ? creditedCents > 0 && paidCents <= 0
          ? "credited"
          : "paid"
        : paidCents + creditedCents > 0
          ? "partial"
          : "open",
  };
}

/**
 * Late is strictly past the moment it was due, and only while money is owed.
 *
 * One definition, because three had grown: the portal said `dueDate < now`,
 * the customer's account page `dueDate <= now`, and the invoice list's
 * "overdue" tab a third thing again in SQL. The gap is a single instant and
 * nobody would ever have seen it, which is exactly why it would have stayed —
 * and a rule about whether somebody is late should not have three readings.
 *
 * Strictly past is the kinder reading and the one the chase job already used:
 * at the instant a bill falls due, it is due, not late.
 */
export function isOverdue(
  dueDate: Date | string | null | undefined,
  balanceDueCents: number,
  now: Date = new Date(),
): boolean {
  if (balanceDueCents <= 0 || !dueDate) return false;
  const due = dueDate instanceof Date ? dueDate : new Date(dueDate);
  return !Number.isNaN(due.getTime()) && due.getTime() < now.getTime();
}

/** What a customer is shown. Not the stored column, which is a filter key. */
export type InvoiceBadge =
  | "draft"
  | "due"
  | "part paid"
  | "overdue"
  | "paid"
  | "credited"
  | "void";

export interface SettledInvoice {
  /** The stored `status` column — read here only for draft and void. */
  status: string;
  totalCents: number;
  /** Given up for paying early: it reduces the debt, and no money arrived. */
  earlyDiscountTakenCents?: number | null;
  dueDate?: Date | string | null;
}

/**
 * The whole of what a screen says about one invoice, from one computation.
 *
 * The badge and the balance beside it used to be two answers: the badge read
 * the stored `status` column, the balance was worked out live from payments
 * and credit notes. Two ways of computing one number is how they drift, and
 * this pair is shown to the customer — a row reading `paid` above a total
 * saying they owe money is the business calling itself unreliable on the one
 * page it cannot explain itself on.
 *
 * So nothing displayed comes from the column. The column stays, because the
 * invoice list filters, counts and sorts on it in SQL and deriving it there
 * would mean a correlated subquery over payments and credit notes for every
 * row of every tab; but every caller here already holds the payments and the
 * credits it needs, so deriving the badge costs no query at all.
 *
 * Two readings of the column survive, and only two: a draft was never sent
 * and a void was taken back. Neither is a debt, whatever has been paid
 * against it, and no arithmetic over payments can discover that.
 *
 * `balanceDue` never goes below zero. An overpayment is the business holding
 * the customer's money, not the customer owing a negative sum, and a page
 * that showed it that way would be stating something untrue.
 */
export function invoiceState(
  invoice: SettledInvoice,
  paidCents: number,
  creditedCents = 0,
  now: Date = new Date(),
): { balanceDue: number; status: string; badge: InvoiceBadge } {
  if (invoice.status === "draft" || invoice.status === "void") {
    return {
      balanceDue: 0,
      status: invoice.status,
      badge: invoice.status as InvoiceBadge,
    };
  }

  const { balanceDue, status } = invoiceStatus(
    invoice.totalCents - (invoice.earlyDiscountTakenCents ?? 0),
    paidCents,
    creditedCents,
  );
  const owed = Math.max(0, balanceDue);
  return {
    balanceDue: owed,
    status,
    badge:
      status === "paid"
        ? "paid"
        : status === "credited"
          ? "credited"
          : isOverdue(invoice.dueDate, owed, now)
            ? "overdue"
            : status === "partial"
              ? "part paid"
              : "due",
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

/**
 * One tax on a line, frozen at the moment it was charged.
 *
 * A line may carry several of these — Canada's GST beside a provincial PST,
 * Quebec's QST beside GST — and each is a distinct tax owed to a distinct
 * authority. The name and category are copied from the definition rather than
 * joined, for the same reason `document_taxes` copies them: what a document
 * charged must not change when a rate is renamed later.
 */
export interface LineTax {
  taxDefinitionId?: string | null;
  name?: string | null;
  /** Millionths: 50,000 is 5%. Wins when both fields are present. */
  ratePpm?: number | null;
  /** @deprecated Basis points, read as `bp × 100`. */
  rateBp?: number | null;
  categoryCode?: string | null;
  /**
   * Charged on the net plus the taxes already computed on this line, rather
   * than on the net alone. The same meaning, and the same simple-first order,
   * as the accounting side's stacking — two answers to what "compound" means
   * would disagree on every document in a province that stacks.
   */
  compound?: boolean;
}

export type DocumentLine = TaxedLine & {
  /** Which named rate this was charged at, for the banded breakdown. */
  taxDefinitionId?: string | null;
  taxName?: string | null;
  categoryCode?: string | null;
  /**
   * Every tax on the line, when it carries more than a single bare rate.
   *
   * Absent or empty, the single-tax fields above govern — which is every
   * document written before a line could carry two taxes, and most written
   * after. When present, this list is the whole truth and the fields above
   * are ignored.
   */
  taxes?: LineTax[] | null;
};

export type Discount =
  | { type: "percent"; value: number }
  | { type: "amount"; value: number }
  | null;

export interface TaxBand {
  taxDefinitionId: string | null;
  name: string;
  /** Millionths — the exact rate the band was charged at. */
  ratePpm: number;
  /** @deprecated The rate to the nearest basis point; read `ratePpm`. */
  rateBp: number;
  categoryCode: string;
  taxableCents: number;
  taxCents: number;
}

/**
 * The tax inside a gross amount, or on top of a net one.
 *
 * Two formulas, and reaching for the wrong one is not a rounding error — it is
 * the rate. The UK and the EU quote gross: a price list says £120 and the VAT
 * is already inside it. The US quotes net and adds the tax at the till.
 *
 * The same function the Shop half of the platform has always priced baskets
 * with, moved here so both halves of one platform answer "what is the VAT on
 * £120" with one number rather than two implementations of it.
 */
export function taxOf(
  amountCents: number,
  ratePpm: number,
  inclusive: boolean,
): number {
  if (ratePpm <= 0 || amountCents === 0) return 0;
  return inclusive
    ? Math.round((amountCents * ratePpm) / (RATE_SCALE_PPM + ratePpm))
    : Math.round((amountCents * ratePpm) / RATE_SCALE_PPM);
}

/** One tax on a line, as charged: the base it was worked out on, and the tax. */
export interface LineCharge {
  tax: LineTax;
  ratePpm: number;
  /** What this tax was charged on — for a compound tax, including the ones under it. */
  baseCents: number;
  taxCents: number;
}

/**
 * What a line amount is worth net, and what each tax on it comes to.
 *
 * Exclusive is the forward direction: the amount *is* the net, and each tax is
 * a share of it. Simple rates first, compound afterwards on the running total.
 *
 * Inclusive runs the same sum backwards, and it has to run backwards in the
 * same order, mirrored — the compound taxes went on last, so they come off
 * first. Taking each one out with `gross × r ÷ (1 + r)` leaves exactly the base
 * it was charged on, which is what makes the two directions inverses rather
 * than two approximations of each other.
 *
 * Then the simple rates come out together, against the sum of their rates: a
 * line at 5% GST and 7% PST holds its net plus 12%, not its net plus 5% and
 * then that plus 7%. Each tax rounds once, and the net is whatever the amount
 * has left afterwards — so **net + every tax is the gross the customer was
 * quoted, to the cent, always.** Nothing is derived twice and no residue has to
 * be chased into a line somewhere; a quoted £120 invoice totals £120.
 */
export function lineCharges(
  amountCents: number,
  taxes: LineTax[],
  pricesIncludeTax: boolean,
  field = "taxRatePpm",
): { netCents: number; charges: LineCharge[] } {
  const rated = taxes.map((tax) => ({
    tax,
    ratePpm: resolveRatePpm(tax?.ratePpm, tax?.rateBp, field),
  }));
  const simple = rated.filter((r) => !r.tax.compound);
  const compound = rated.filter((r) => r.tax.compound);

  if (!pricesIncludeTax) {
    const charges: LineCharge[] = [];
    let stacked = 0;
    for (const { tax, ratePpm } of [...simple, ...compound]) {
      const baseCents = tax.compound ? amountCents + stacked : amountCents;
      const taxCents = taxOf(baseCents, ratePpm, false);
      stacked += taxCents;
      charges.push({ tax, ratePpm, baseCents, taxCents });
    }
    return { netCents: amountCents, charges };
  }

  // Backwards, outermost first: the last compound tax applied is the first out.
  const unstacked: LineCharge[] = [];
  let remaining = amountCents;
  for (let i = compound.length - 1; i >= 0; i -= 1) {
    const { tax, ratePpm } = compound[i] as (typeof compound)[number];
    const taxCents = taxOf(remaining, ratePpm, true);
    remaining -= taxCents;
    // What is left is precisely the base this tax was charged on.
    unstacked.unshift({ tax, ratePpm, baseCents: remaining, taxCents });
  }

  // `remaining` is now the net plus the simple taxes, so they come out of it
  // against their combined rate. With one tax this is `taxOf(x, r, true)`.
  const combinedPpm = simple.reduce(
    (sum, r) => sum + Math.max(0, r.ratePpm),
    0,
  );
  const simpleCharges = simple.map(({ tax, ratePpm }) => ({
    tax,
    ratePpm,
    baseCents: 0,
    taxCents:
      ratePpm <= 0 || remaining === 0
        ? 0
        : Math.round((remaining * ratePpm) / (RATE_SCALE_PPM + combinedPpm)),
  }));
  const netCents =
    remaining - simpleCharges.reduce((sum, ch) => sum + ch.taxCents, 0);
  for (const charge of simpleCharges) charge.baseCents = netCents;

  return { netCents, charges: [...simpleCharges, ...unstacked] };
}

export interface DocumentTotals {
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  bands: TaxBand[];
}

export interface DocumentTotalsOptions {
  /**
   * The unit prices on these lines already contain the tax.
   *
   * How the UK and the EU quote: a price list says £120 and the VAT is inside
   * it, so £120 is what the customer pays. The US quotes net and adds tax at
   * the till, which is the default here and everything written before this.
   *
   * What changes is only where the tax comes from, never the shape of the
   * answer: `subtotal` stays net of tax, `tax` is the tax, and `total` is what
   * the document asks for — which for a gross-quoted document is exactly the
   * figure that was typed into it, to the cent.
   */
  pricesIncludeTax?: boolean;
}

export function documentTotals(
  lines: DocumentLine[],
  discount: Discount = null,
  options: DocumentTotalsOptions = {},
): DocumentTotals {
  const inclusive = options.pricesIncludeTax === true;

  /**
   * What each line comes to at the price it was quoted at.
   *
   * Net when the business quotes net, gross when it quotes gross — and the
   * discount is a share of the same thing either way, which is the point. A
   * £10 code off a gross-quoted invoice takes £10 off what the customer pays,
   * not £10 off a net figure they were never shown.
   */
  const amounts: number[] = [];
  const charged: LineTax[][] = [];
  let quoted = 0;
  for (const [i, l] of lines.entries()) {
    const quantity = l?.quantity;
    if (typeof quantity !== "number" || !Number.isFinite(quantity)) {
      throw new MoneyError(`line ${i + 1}: quantity must be a number`);
    }
    const unitPrice = cents(l?.unitPrice, `line ${i + 1}: unitPrice`);
    resolveRatePpm(l?.taxRatePpm, l?.taxRateBp, `line ${i + 1}: taxRatePpm`);
    const amount = Math.round(quantity * unitPrice);
    amounts.push(amount);
    quoted += amount;

    // The multi-tax list when the line carries one; otherwise the single-tax
    // fields, spelled as a one-entry list so there is one loop, not two.
    charged.push(
      l?.taxes?.length
        ? l.taxes
        : [
            {
              taxDefinitionId: l?.taxDefinitionId ?? null,
              name: l?.taxName ?? null,
              ratePpm: l?.taxRatePpm,
              rateBp: l?.taxRateBp,
              categoryCode: l?.categoryCode ?? null,
            },
          ],
    );
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
        ? Math.round((quoted * value) / 10000)
        : value;
    // A discount larger than the document is a typo, not a refund. Capping it
    // keeps the total at zero rather than producing an invoice that owes the
    // customer money — which is what a credit note is for.
    discountCents = Math.min(discountCents, quoted);
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
  const relief: number[] = amounts.map((amount) =>
    quoted > 0 ? Math.round((discountCents * amount) / quoted) : 0,
  );
  const spread = relief.reduce((sum, r) => sum + r, 0);
  if (spread !== discountCents && relief.length > 0) {
    let biggest = 0;
    for (let i = 1; i < amounts.length; i += 1) {
      if ((amounts[i] as number) > (amounts[biggest] as number)) biggest = i;
    }
    relief[biggest] = (relief[biggest] as number) + (discountCents - spread);
  }

  /**
   * **Each tax is computed and rounded per line, not on a per-tax subtotal
   * across the document.** The decision, and why it is safe to rely on:
   *
   * - It is what the single-tax path has always done, so every document
   *   written before a line could carry two taxes totals to the cent exactly
   *   as it did — the migration guarantee, proven by test rather than argued.
   * - The CRA explicitly permits rounding GST/HST on each invoice line, and
   *   the provincial taxes follow the same practice — so a Canadian document
   *   built this way is one its authorities accept.
   * - EN 16931 permits line-level calculation; the e-invoice states each
   *   category's amounts as the sum of its per-line figures, so the XML, the
   *   screen and the ledger all quote the same numbers.
   *
   * Each tax on a line rounds independently: GST and PST on the same line are
   * two computations on the same base, not one computation split afterwards —
   * which is exactly how the two filings will want them.
   *
   * A gross-quoted line runs the identical banding over the identical bases;
   * only the direction the net and the tax are derived in differs, and
   * `lineCharges` owns that.
   */
  const byBand = new Map<string, TaxBand>();
  let tax = 0;
  let netAfterDiscount = 0;
  let netBeforeDiscount = 0;
  for (const [i, l] of lines.entries()) {
    const taxable = (amounts[i] as number) - (relief[i] as number);
    const ordered = charged[i] as LineTax[];
    const field = `line ${i + 1}: taxRatePpm`;

    const after = lineCharges(taxable, ordered, inclusive, field);
    netAfterDiscount += after.netCents;
    /*
     * The subtotal is what the goods came to before the discount was taken
     * off, because that is the line a document shows above the one that takes
     * it off. Net-quoted, that is the quoted amount itself. Gross-quoted, the
     * tax has to come out of the undiscounted amount too — the same back-out,
     * against the same rates.
     */
    netBeforeDiscount += inclusive
      ? lineCharges(amounts[i] as number, ordered, true, field).netCents
      : (amounts[i] as number);

    for (const { tax: t, ratePpm, baseCents, taxCents } of after.charges) {
      tax += taxCents;

      // Banded by the rate actually charged, not by the definition: two rates
      // that happen to be equal are one line on a tax summary, and a rate that
      // was renamed is still the rate this document was issued at.
      const key = `${t.taxDefinitionId ?? ""}|${ratePpm}|${t.categoryCode ?? "S"}`;
      const band = byBand.get(key) ?? {
        taxDefinitionId: t.taxDefinitionId ?? null,
        name:
          t.name ?? (ratePpm === 0 ? "No tax" : `${percentFromPpm(ratePpm)}%`),
        ratePpm,
        rateBp: Math.round(ratePpm / 100),
        categoryCode: t.categoryCode ?? "S",
        taxableCents: 0,
        taxCents: 0,
      };
      // The base the tax was actually charged on — for a compound tax that
      // includes the taxes under it, which is what its return will ask for.
      band.taxableCents += baseCents;
      band.taxCents += taxCents;
      byBand.set(key, band);
    }
  }

  /*
   * Everything a document states is stated net of tax except the total, which
   * is what is actually owed — and the three add up exactly, in both
   * directions, because the discount is reported as the net it relieved rather
   * than as the gross figure somebody typed. A £10 code on a 20% VAT invoice
   * relieves £8.33 of net and £1.67 of VAT, and the customer pays £10 less.
   */
  const discountReported = inclusive
    ? netBeforeDiscount - netAfterDiscount
    : discountCents;

  return {
    subtotal: netBeforeDiscount,
    discount: discountReported,
    tax,
    total: netAfterDiscount + tax,
    bands: [...byBand.values()].sort((a, b) => b.ratePpm - a.ratePpm),
  };
}

/**
 * An amount as a whole number of cents, or null if it cannot be read.
 *
 * The other direction from everything above: text arriving from outside —
 * a bank's CSV export, a figure typed into a form — turned into integer
 * cents. Every bank writes amounts slightly differently: quoted fields,
 * amounts in parentheses for money out, currency symbols, thousands
 * separators. This is the smallest reader that copes with all of that.
 *
 * Null rather than zero, always. A row whose amount could not be parsed is a
 * row the business has to look at — importing it as nothing would silently
 * lose money from a reconciliation that then never balances.
 */
export function parseAmountToCents(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;

  // Accountants' parentheses mean money out: (1,234.56) is -1234.56.
  const negative = /^\(.*\)$/.test(text) || text.startsWith("-");
  const digits = text.replace(/[()\-\s]/g, "").replace(/[^0-9.,]/g, "");
  if (!digits) return null;

  /**
   * Which separator is the decimal point.
   *
   * "1.234,56" is a European thousand separator and a comma decimal; "1,234.56"
   * is the other way round. The last separator in the string is the decimal one
   * when it is followed by exactly two digits, and a thousands separator
   * otherwise — which is how "1,234" stays 1234 rather than becoming 12.34.
   */
  const lastComma = digits.lastIndexOf(",");
  const lastDot = digits.lastIndexOf(".");
  const lastSeparator = Math.max(lastComma, lastDot);
  const decimals = lastSeparator >= 0 ? digits.length - lastSeparator - 1 : 0;

  let normalized: string;
  if (lastSeparator >= 0 && (decimals === 1 || decimals === 2)) {
    normalized = `${digits.slice(0, lastSeparator).replace(/[.,]/g, "")}.${digits.slice(
      lastSeparator + 1,
    )}`;
  } else {
    normalized = digits.replace(/[.,]/g, "");
  }

  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  const cents = Math.round(value * 100);
  return negative ? -cents : cents;
}
