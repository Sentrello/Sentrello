import { expect, test } from "bun:test";
import {
  DEFAULT_TAX_REGIMES,
  NAV_TAX_REGIME,
  TAX_REGIMES,
  cleanTaxRegimes,
  defaultTaxRegimesFor,
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

/**
 * The default follows the country, because the screen it gates is a return.
 *
 * Every business got US sales tax until it went looking for this setting, so a
 * business in Toronto saw the American screen in its sidebar and not its own
 * GST/HST return — built, correct, and reachable only by opening a settings list
 * it had no reason to open. Three of the four markets this is sold into.
 *
 * Asked of each market by name rather than in a loop, because a loop over the
 * same table that produces the answer would pass whatever that table said.
 */
test("the default regime follows where the business trades", () => {
  expect(defaultTaxRegimesFor("US")).toEqual(["us-sales-tax"]);
  expect(defaultTaxRegimesFor("CA")).toEqual(["ca-tax"]);
  expect(defaultTaxRegimesFor("GB")).toEqual(["uk-vat"]);
  expect(defaultTaxRegimesFor("DE")).toEqual(["eu-vat"]);
  expect(defaultTaxRegimesFor("IE")).toEqual(["eu-vat"]);

  // Lower case and padding, because this is a text column somebody typed into.
  expect(defaultTaxRegimesFor(" ca ")).toEqual(["ca-tax"]);

  // "UK" is not a country code and is storable, since Settings checks only that
  // there are two letters. A British business is not refused its own return
  // over that.
  expect(defaultTaxRegimesFor("UK")).toEqual(["uk-vat"]);

  // Greece as the VAT register spells it.
  expect(defaultTaxRegimesFor("EL")).toEqual(["eu-vat"]);
});

/**
 * And a business outside the four markets keeps the old fallback.
 *
 * Not an empty set: a sidebar with no tax screen at all reads as unfinished, and
 * we have no rules to offer a business in Australia either way. The fallback is
 * what a fresh instance has always started with.
 */
test("a country with no rules of ours falls back rather than guessing", () => {
  expect(defaultTaxRegimesFor("AU")).toEqual(DEFAULT_TAX_REGIMES);
  expect(defaultTaxRegimesFor(null)).toEqual(DEFAULT_TAX_REGIMES);
  expect(defaultTaxRegimesFor("")).toEqual(DEFAULT_TAX_REGIMES);
  expect(defaultTaxRegimesFor(undefined)).toEqual(DEFAULT_TAX_REGIMES);
});

/** Whatever it answers has to be a regime this instance recognises. */
test("every market's default is a known regime", () => {
  for (const country of ["US", "CA", "GB", "FR", "AU"]) {
    const chosen = defaultTaxRegimesFor(country);
    expect(cleanTaxRegimes(chosen)).toEqual(chosen);
  }
});
