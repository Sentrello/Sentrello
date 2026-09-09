import type { LedgerRow } from "./reports";

/**
 * A UK VAT return, computed from the ledger.
 *
 * Nine boxes, which is what HMRC asks for and what any UK VAT-registered
 * business fills in four times a year. The existing tax summary answers three
 * questions — charged, reclaimed, due — and a return needs the turnover figures
 * as well, which are a different sum over different accounts.
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
 */

/** The account code VAT is carried on. */
const VAT_ACCOUNT = "2200";

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
 * Boxes 2, 8 and 9 are zero. They are the Northern Ireland Protocol boxes and
 * this module has no concept of an EU acquisition; returning zero is honest,
 * and a business that needs them cannot use this return unaided. That is
 * written on the screen rather than left for them to discover on a form.
 */
export function vatReturn(rows: LedgerRow[]): VatReturn {
  const vat = rows.filter((row) => row.code === VAT_ACCOUNT);
  const vatDueSales = vat.reduce((sum, row) => sum + row.creditCents, 0);
  const vatReclaimedCurrPeriod = vat.reduce(
    (sum, row) => sum + row.debitCents,
    0,
  );

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
