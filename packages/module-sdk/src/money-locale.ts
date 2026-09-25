/**
 * How a business writes a number, from the country on its settings screen.
 *
 * ## Why this is a table and not `en-${country}`
 *
 * It was `en-${country}` — `en-DE`, `en-CA`, `en-FR` — and on a Mac that
 * works: macOS carries a recent CLDR, which gives `en-DE` Germany's
 * separators. **On Linux it does not.** The same call in the container this
 * product ships in returns `€1,279.97` for `en-DE`, because number symbols
 * are inherited from the *language* and only newer data adds the European
 * `en-150` branch underneath it.
 *
 * Nothing throws and nothing warns. `Intl.NumberFormat.supportedLocalesOf`
 * even answers that `en-DE` is supported, and then formats it as `en`. So the
 * whole of the money work landed, passed on the machine it was written on,
 * and would have been a no-op on every instance anybody actually runs — found
 * because the tests assert the *string a customer reads* rather than the tag,
 * and CI runs on Linux.
 *
 * Each market maps to a real locale instead, which every ICU build has had
 * for twenty years. The language is the one the country's own invoices are
 * written in; only the number matters here, so nothing else in the product
 * changes language with it.
 *
 * The four markets are the whole list on purpose — the US, Canada, the UK and
 * the EU is where this product sells, and a country missing from here falls
 * back to `en-US` rather than guessing.
 */
const LOCALES: Record<string, string> = {
  US: "en-US",
  CA: "en-CA",
  GB: "en-GB",
  IE: "en-IE",
  // The EU, as `distance-selling.ts` counts it. Belgium and Luxembourg each
  // have more than one official language and identical number conventions in
  // both, so either tag gives the same figure.
  AT: "de-AT",
  BE: "nl-BE",
  BG: "bg-BG",
  HR: "hr-HR",
  CY: "el-CY",
  CZ: "cs-CZ",
  DK: "da-DK",
  EE: "et-EE",
  FI: "fi-FI",
  FR: "fr-FR",
  DE: "de-DE",
  GR: "el-GR",
  // Greece as the VAT register spells it, for a record typed that way.
  EL: "el-GR",
  HU: "hu-HU",
  IT: "it-IT",
  LV: "lv-LV",
  LT: "lt-LT",
  LU: "fr-LU",
  MT: "mt-MT",
  NL: "nl-NL",
  PL: "pl-PL",
  PT: "pt-PT",
  RO: "ro-RO",
  SK: "sk-SK",
  SI: "sl-SI",
  ES: "es-ES",
  SE: "sv-SE",
};

/**
 * The locale a business's own documents are written in, from its country.
 *
 * `en-US` when the country is missing, malformed, or somewhere this product
 * does not sell into — which is the behaviour every instance had before any
 * of this, so a business that has never filled the field in sees no change.
 */
export function moneyLocale(countryCode?: string | null): string {
  const region = (countryCode ?? "").trim().toUpperCase();
  return LOCALES[region] ?? "en-US";
}

/** The markets with a convention of their own, for the tests that walk them. */
export const MONEY_MARKETS = Object.keys(LOCALES);
