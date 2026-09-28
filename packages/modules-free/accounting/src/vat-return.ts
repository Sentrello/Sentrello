/**
 * The UK VAT return lives in `@sentrello/db/tax` now, beside the money
 * arithmetic: both halves of the product read it, and `db` is the package
 * linked everywhere. Re-exported so every caller here keeps working.
 */
export {
  flatRateVatReturn,
  forHmrc,
  limitedCostFigures,
  type LimitedCostFigures,
  vatReturn,
  type VatReturn,
} from "@sentrello/db/tax";
