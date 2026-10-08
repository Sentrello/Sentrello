import { afterEach, expect, test } from "bun:test";
import { briefMoney, formatMoney, setFormats } from "./ui";

/**
 * A figure with no currency of its own is in the business's money, not dollars.
 *
 * Which sign goes in front of a total came from a *person's* preference, and that
 * preference defaulted to USD. Around a hundred of the free core's figures are
 * drawn without naming a currency — a dashboard, a report, a summary card,
 * anything that is not a document with one of its own — so on a British or
 * Canadian instance all of them read as dollars until each person went to their
 * profile and typed three letters. Correctly punctuated dollars, which is the
 * part that made it look deliberate rather than broken.
 *
 * `formats` is one module-scope value for the whole process, so every test here
 * puts it back: a leak out of this file is a hundred other assertions reading a
 * currency they never set.
 */
afterEach(() => {
  setFormats({ currency: "", businessCurrency: "", countryCode: "" });
});

test("an instance that has said nothing still falls back to the dollar", () => {
  expect(formatMoney(1_050)).toBe("$10.50");
});

test("a business's own books decide the sign", () => {
  setFormats({ businessCurrency: "GBP", countryCode: "GB" });
  expect(formatMoney(1_050)).toBe("£10.50");

  setFormats({ businessCurrency: "CAD", countryCode: "CA" });
  // The form a Canadian business's own documents are written in, which is not
  // the `CA$` you get from outside it.
  expect(formatMoney(1_050)).toContain("10.50");
  expect(formatMoney(1_050)).not.toContain("CA$");
});

/** A person who wants their employer's figures in their own money still can. */
test("a person's own choice outranks the business", () => {
  setFormats({ currency: "EUR", businessCurrency: "GBP", countryCode: "GB" });
  expect(formatMoney(1_050)).toBe("€10.50");
});

/** And a chart's axis follows the same order, because it reads the same value. */
test("a short figure follows the business too", () => {
  setFormats({ businessCurrency: "GBP", countryCode: "GB" });
  expect(briefMoney(1_500_000)).toContain("£");
});
