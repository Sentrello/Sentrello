import { expect, test } from "bun:test";
import {
  DEFAULT_TAX_REGIMES,
  NAV_TAX_REGIME,
  TAX_REGIMES,
  cleanTaxRegimes,
} from "./tax-regimes";

test("cleanTaxRegimes keeps only ids this instance recognises, deduplicated", () => {
  expect(cleanTaxRegimes(["uk-vat", "uk-vat", "made-up-regime"])).toEqual([
    "uk-vat",
  ]);
  expect(cleanTaxRegimes(["us-sales-tax", "eu-vat"])).toEqual([
    "us-sales-tax",
    "eu-vat",
  ]);
  expect(cleanTaxRegimes([])).toEqual([]);
});

test("cleanTaxRegimes refuses anything that is not a list", () => {
  expect(cleanTaxRegimes("uk-vat")).toBeNull();
  expect(cleanTaxRegimes(undefined)).toBeNull();
  expect(cleanTaxRegimes({ id: "uk-vat" })).toBeNull();
});

test("the default is US sales tax alone, and it is a known regime", () => {
  expect(DEFAULT_TAX_REGIMES).toEqual(["us-sales-tax"]);
  expect(cleanTaxRegimes(DEFAULT_TAX_REGIMES)).toEqual(DEFAULT_TAX_REGIMES);
});

test("every regime with a nav entry is reachable from its nav id", () => {
  for (const regime of TAX_REGIMES) {
    if (!regime.navId) continue;
    expect(NAV_TAX_REGIME.get(regime.navId)).toBe(regime.id);
  }
  // EU VAT gates the One Stop Shop return, which is the only screen it has.
  expect(TAX_REGIMES.find((r) => r.id === "eu-vat")?.navId).toBe(
    "invoicing-oss",
  );
});
