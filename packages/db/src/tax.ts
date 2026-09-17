import { type LedgerRow, isTaxPayableCode } from "./ledger";

/**
 * A UK VAT return, computed from the ledger.
 *
 * Nine boxes, which is what HMRC asks for and what any UK VAT-registered
 * business fills in four times a year. The accounting tax summary answers
 * three questions — charged, reclaimed, due — and a return needs the turnover
 * figures as well, which are a different sum over different accounts.
 *
 * **This computes; it does not file.** Filing is Making Tax Digital, needs an
 * HMRC application and an authorised connection, and is deliberately separate:
 * a business should be able to see its return, check it, and disagree with it
 * before anything is sent anywhere. A number that appears for the first time on
 * a submission screen is a number nobody has checked.
 *
 * Every figure is integer pence. HMRC wants boxes 1 to 5 to two decimal places
 * and boxes 6 to 9 as whole pounds, and that rounding happens at the edge where
 * the return is presented — not here, where it would compound.
 *
 * Beside the ledger readers rather than in a module, because both halves of
 * the product read it: the screens that show a return and the MTD path that
 * files one are not always in the same package.
 */

export interface VatReturn {
  /** VAT due on sales and other outputs. */
  vatDueSales: number;
  /**
   * VAT due on acquisitions from EU member states.
   *
   * Northern Ireland only since Brexit — a business in Great Britain has
   * nothing to put here. Zero rather than absent, because the box still exists
   * on the form and an omitted box is not the same as a nil one.
   */
  vatDueAcquisitions: number;
  /** Box 3: the total of boxes 1 and 2. HMRC checks this arithmetic. */
  totalVatDue: number;
  /** VAT reclaimed on purchases and other inputs. */
  vatReclaimedCurrPeriod: number;
  /**
   * Box 5: the difference. Positive means owed to HMRC, and HMRC wants this
   * box as an absolute value with the direction implied by boxes 3 and 4.
   */
  netVatDue: number;
  /** Box 6: total value of sales excluding VAT. */
  totalValueSalesExVAT: number;
  /** Box 7: total value of purchases excluding VAT. */
  totalValuePurchasesExVAT: number;
  /** Boxes 8 and 9: supplies to and acquisitions from the EU. NI only. */
  totalValueGoodsSuppliedExVAT: number;
  totalAcquisitionsExVAT: number;
}

/**
 * The nine boxes, in pence.
 *
 * Boxes 1 and 4 come from the VAT account: charged on a sale is a credit,
 * reclaimed on a purchase is a debit. Boxes 6 and 7 come from the income and
 * expense accounts — the turnover the VAT was charged on, which is a
 * different question from the VAT itself and the reason a return needs more
 * than the tax summary already gives.
 *
 * Which box a VAT movement belongs to is read from the entry it arrived in,
 * because the account alone cannot say. A credit note on a sale debits the
 * VAT account, but it is not input VAT reclaimed — HMRC's rule is that it
 * *reduces* box 1 — and a return that put it in box 4 declared both boxes
 * higher than the truth by the same amount. Box 5 netted out, so nobody's
 * payment was wrong, but boxes 1 and 4 are each figures HMRC reads. So: VAT
 * in an entry that touches income belongs to the sales side and nets into
 * box 1; VAT in an entry that touches expenses nets into box 4; VAT that
 * moved alone — an adjustment posted by hand — keeps the account's own
 * reading, credit to box 1 and debit to box 4, which is what it always got.
 *
 * Boxes 2, 8 and 9 are zero. They are the Northern Ireland Protocol boxes and
 * this platform has no concept of an EU acquisition; returning zero is honest,
 * and a business that needs them cannot use this return unaided. That is
 * written on the screen rather than left for them to discover on a form.
 */
export function vatReturn(rows: LedgerRow[]): VatReturn {
  const entries = new Map<
    string,
    { sale: boolean; purchase: boolean; vatCredit: number; vatDebit: number }
  >();
  for (const row of rows) {
    const entry = entries.get(row.entryId) ?? {
      sale: false,
      purchase: false,
      vatCredit: 0,
      vatDebit: 0,
    };
    if (row.type === "income") entry.sale = true;
    if (row.type === "expense") entry.purchase = true;
    if (isTaxPayableCode(row.code)) {
      entry.vatCredit += row.creditCents;
      entry.vatDebit += row.debitCents;
    }
    entries.set(row.entryId, entry);
  }

  let vatDueSales = 0;
  let vatReclaimedCurrPeriod = 0;
  for (const entry of entries.values()) {
    if (entry.sale) {
      vatDueSales += entry.vatCredit - entry.vatDebit;
    } else if (entry.purchase) {
      vatReclaimedCurrPeriod += entry.vatDebit - entry.vatCredit;
    } else {
      vatDueSales += entry.vatCredit;
      vatReclaimedCurrPeriod += entry.vatDebit;
    }
  }

  /*
   * Turnover, net of VAT — which it already is, because the VAT on a sale is
   * posted to the VAT account rather than to income. Income is credited when
   * earned, so a credit balance is sales; a debit against income is a credit
   * note and reduces the figure, which is what the box should show.
   */
  const income = rows.filter((row) => row.type === "income");
  const totalValueSalesExVAT = income.reduce(
    (sum, row) => sum + row.creditCents - row.debitCents,
    0,
  );

  const expense = rows.filter((row) => row.type === "expense");
  const totalValuePurchasesExVAT = expense.reduce(
    (sum, row) => sum + row.debitCents - row.creditCents,
    0,
  );

  const vatDueAcquisitions = 0;
  const totalVatDue = vatDueSales + vatDueAcquisitions;

  return {
    vatDueSales,
    vatDueAcquisitions,
    totalVatDue,
    vatReclaimedCurrPeriod,
    /*
     * The absolute difference. HMRC's own field is described as the difference
     * between boxes 3 and 4, and a business in a repayment position puts the
     * amount it is owed here — not a negative number.
     */
    netVatDue: Math.abs(totalVatDue - vatReclaimedCurrPeriod),
    totalValueSalesExVAT,
    totalValuePurchasesExVAT,
    totalValueGoodsSuppliedExVAT: 0,
    totalAcquisitionsExVAT: 0,
  };
}

/**
 * The return in the shape and units HMRC's API accepts.
 *
 * Boxes 1 to 5 to two decimal places, boxes 6 to 9 as whole pounds — HMRC's
 * rule, not a preference, and getting it wrong is a rejected submission.
 *
 * Rounding here rather than in the computation, so the figures a business
 * checks on screen and the figures that are sent are the same numbers rounded
 * once. Rounding twice is how a return disagrees with the report it came from
 * by a penny, and a penny is enough to make somebody distrust the whole thing.
 */
export function forHmrc(vat: VatReturn): Record<string, number> {
  const pounds = (pence: number) => Math.round(pence) / 100;
  /*
   * Boxes 6 to 9 are whole pounds, rounded *down*. HMRC's guidance is to round
   * down the value of supplies, which favours the taxpayer on the turnover
   * boxes and is what their own examples show.
   */
  const wholePounds = (pence: number) => Math.floor(pence / 100);

  return {
    vatDueSales: pounds(vat.vatDueSales),
    vatDueAcquisitions: pounds(vat.vatDueAcquisitions),
    totalVatDue: pounds(vat.totalVatDue),
    vatReclaimedCurrPeriod: pounds(vat.vatReclaimedCurrPeriod),
    netVatDue: pounds(vat.netVatDue),
    totalValueSalesExVAT: wholePounds(vat.totalValueSalesExVAT),
    totalValuePurchasesExVAT: wholePounds(vat.totalValuePurchasesExVAT),
    totalValueGoodsSuppliedExVAT: wholePounds(vat.totalValueGoodsSuppliedExVAT),
    totalAcquisitionsExVAT: wholePounds(vat.totalAcquisitionsExVAT),
  };
}

/**
 * The Flat Rate Scheme return — the same nine boxes, computed HMRC's other way.
 *
 * Under the scheme a business still charges VAT at the normal rates, but what
 * it *owes* is a single sector percentage applied to its gross, VAT-inclusive
 * turnover — and in exchange it gives up the ordinary box 4 reclaim on
 * purchases. Which sector, and therefore which percentage, is the business's
 * own election with HMRC; it arrives here as a setting and is never guessed.
 *
 * The percentage is in millionths, like every rate in this package:
 * 14.5% is 145,000.
 *
 * Box 6 is the gross flat-rate turnover *including* VAT — HMRC's rule for this
 * scheme, and the one thing here that looks wrong to anybody used to the
 * standard return. The field keeps its name because HMRC's API keeps its name.
 *
 * Boxes 4 and 7 are zero. The scheme's one exception — reclaiming VAT on a
 * single capital asset purchase of £2,000 or more — is not modelled, and the
 * screen says so rather than leaving it to be discovered at an inspection.
 */
export function flatRateVatReturn(
  rows: LedgerRow[],
  sectorRatePpm: number,
): VatReturn {
  const gross = flatRateTurnoverCents(rows);
  const vatDueSales = Math.round((gross * sectorRatePpm) / 1_000_000);

  return {
    vatDueSales,
    vatDueAcquisitions: 0,
    totalVatDue: vatDueSales,
    vatReclaimedCurrPeriod: 0,
    netVatDue: Math.abs(vatDueSales),
    totalValueSalesExVAT: gross,
    totalValuePurchasesExVAT: 0,
    totalValueGoodsSuppliedExVAT: 0,
    totalAcquisitionsExVAT: 0,
  };
}

/**
 * Gross, VAT-inclusive turnover — what the flat rate percentage applies to.
 *
 * Walked entry by entry rather than summed account by account, because the VAT
 * account alone cannot say which of its movements were charged on sales: a
 * purchase's reclaimable VAT lands in the same account from the other side.
 * The VAT that belongs in the turnover is the VAT posted in the same entry as
 * income — an invoice, a card sale, a credit note — and an entry with no
 * income line contributed nothing to turnover, whatever else it moved.
 */
export function flatRateTurnoverCents(rows: LedgerRow[]): number {
  const entries = new Map<string, { income: number; vat: number }>();
  for (const row of rows) {
    const entry = entries.get(row.entryId) ?? { income: 0, vat: 0 };
    if (row.type === "income") {
      entry.income += row.creditCents - row.debitCents;
    } else if (isTaxPayableCode(row.code)) {
      entry.vat += row.creditCents - row.debitCents;
    }
    entries.set(row.entryId, entry);
  }

  let gross = 0;
  for (const entry of entries.values()) {
    if (entry.income !== 0) gross += entry.income + entry.vat;
  }
  return gross;
}

/**
 * The figures the limited cost trader determination is made from.
 *
 * A business whose *relevant goods* cost less than 2% of its gross turnover —
 * or less than £1,000 a year even when over 2% — pays the 16.5% limited cost
 * rate instead of its sector's. But "relevant goods" is a legal category the
 * ledger cannot see: it excludes services, capital, vehicles, food and fuel by
 * rules that need a human who knows the business, and getting the call wrong
 * on somebody's behalf is worse than not making it.
 *
 * So this returns the ingredients and no verdict: the gross turnover, 2% of
 * it, and everything recorded as an expense — which is *broader* than relevant
 * goods, and said so wherever these figures are shown. No boolean, no chosen
 * rate. That determination is the accountant's, on purpose.
 */
export interface LimitedCostFigures {
  /** Gross, VAT-inclusive flat-rate turnover for the period. */
  grossTurnoverCents: number;
  /** 2% of it — the threshold relevant goods are measured against. */
  twoPercentOfTurnoverCents: number;
  /**
   * Everything recorded as an expense in the period. An upper bound on
   * relevant goods, never the figure itself.
   */
  spendingCents: number;
}

export function limitedCostFigures(rows: LedgerRow[]): LimitedCostFigures {
  const grossTurnoverCents = flatRateTurnoverCents(rows);
  const spendingCents = rows
    .filter((row) => row.type === "expense")
    .reduce((sum, row) => sum + row.debitCents - row.creditCents, 0);
  return {
    grossTurnoverCents,
    twoPercentOfTurnoverCents: Math.round(
      (grossTurnoverCents * 20_000) / 1_000_000,
    ),
    spendingCents,
  };
}
