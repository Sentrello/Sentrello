import { expect, test } from "bun:test";
import { currencyForCountry } from "./country-data";

/**
 * The currency a country keeps its books in, and where there is no answer.
 *
 * It fills the Currency field when somebody picks a country, because most people
 * set the country for the tax rules and never think about the currency — which
 * is how every Free instance outside the United States came to keep its books in
 * dollars. Null is the important half: the EU is not the euro, and handing
 * Poland euros would be the same fault one size smaller.
 */
test("a country's currency, where there is one to know", () => {
  expect(currencyForCountry("US")).toBe("USD");
  expect(currencyForCountry("ca")).toBe("CAD");
  expect(currencyForCountry("GB")).toBe("GBP");
  // The product's own docs use UK in one or two places; both mean the same
  // country and neither should be a guess this cannot make.
  expect(currencyForCountry("UK")).toBe("GBP");
  expect(currencyForCountry("IE")).toBe("EUR");
  expect(currencyForCountry("DE")).toBe("EUR");
});

test("and nothing at all where the EU is not the euro", () => {
  for (const code of ["PL", "SE", "DK", "CZ", "HU", "RO", "BG"]) {
    expect(currencyForCountry(code)).toBeNull();
  }
  // And for anywhere this product does not serve, rather than a dollar.
  expect(currencyForCountry("JP")).toBeNull();
  expect(currencyForCountry("")).toBeNull();
});
