/**
 * Which country somebody is in, chosen rather than typed.
 *
 * It was a text box with the hint `Two letters — "US", "CA", "GB"`, and the
 * field it filled is the most load-bearing one on the settings screen: it
 * decides how every figure on every document this business sends is written,
 * which tax label its receipts carry, and whether a sale into the EU is a
 * reverse charge or a domestic one. Type `UK` and nothing complains — `en-UK`
 * is a structurally valid tag that resolves to plain `en`, so a British
 * business quietly keeps the American conventions. Type `Germany` on a
 * customer's record and the VAT rules stop seeing an EU customer at all.
 *
 * A list is the whole fix. The codes are data; the names come from `Intl`,
 * so they arrive in the reader's own language and nobody maintains 250
 * strings by hand.
 */

/** The markets this product is built for, and deliberately no others. */
export const SERVED = [
  "US",
  "CA",
  "GB",
  // The EU, as the VAT rules and `distance-selling.ts` count it.
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
];

/**
 * Everywhere else, because a customer is not bound by where we sell.
 *
 * A business in Boston invoices a customer in Tokyo, and that sale is a
 * zero-rated export rather than a data-entry mistake. ISO 3166-1 alpha-2,
 * minus the codes reserved or not assigned to a country.
 */
export const ELSEWHERE = `
  AD AE AF AG AI AL AM AO AQ AR AS AU AW AX AZ
  BA BB BD BF BH BI BJ BL BM BN BO BQ BR BS BT
  BV BW BY BZ CC CD CF CG CH CI CK CL CM CN CO
  CR CU CV CW CX DJ DM DO DZ EC EG EH ER ET FJ
  FK FM FO GA GD GE GF GG GH GI GL GM GN GP GQ
  GS GT GU GW GY HK HM HN HT ID IL IM IN IO IQ
  IR IS JE JM JO JP KE KG KH KI KM KN KP KR KW
  KY KZ LA LB LC LI LK LR LS LY MA MC MD ME MF
  MG MH MK ML MM MN MO MP MQ MR MS MU MV MW MX
  MY MZ NA NC NE NF NG NI NO NP NR NU NZ OM PA
  PE PF PG PH PK PM PN PR PS PW PY QA RE RS RU
  RW SA SB SC SD SG SH SJ SL SM SN SO SR SS ST
  SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO
  TR TT TV TW TZ UA UG UM UY UZ VA VC VE VG VI
  VN VU WF WS YE YT ZA ZM ZW
`
  .trim()
  .split(/\s+/);

const names =
  typeof Intl.DisplayNames === "function"
    ? // `fallback: "code"` so a code nobody recognises is shown as itself
      // rather than as an empty option somebody cannot tell apart.
      new Intl.DisplayNames(undefined, { type: "region", fallback: "code" })
    : null;

/** "DE" → "Germany", in the reader's language; the code itself if `Intl` cannot. */
export function countryName(code: string): string {
  try {
    return names?.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Alphabetical by the name somebody reads, not by the code nobody does. */
export const countriesByName = (codes: string[]): string[] =>
  [...codes].sort((a, b) => countryName(a).localeCompare(countryName(b)));

/**
 * What a country calls the last line of its addresses.
 *
 * "Postcode" everywhere is the British word on an American screen, and the US
 * is the first market this product sells into. Nobody in Ohio has ever filled
 * in a postcode. It is one word, and the country beside it now says which.
 */
export function postcodeLabel(country: string): string {
  const code = (country ?? "").trim().toUpperCase();
  if (code === "US") return "ZIP code";
  if (code === "CA") return "Postal code";
  return "Postcode";
}

/**
 * And what it calls the line above that, where it has one worth asking for.
 *
 * The US has states, Canada provinces, the UK counties nobody writes any
 * more. Most of the EU has nothing between the city and the country, so the
 * field is offered as a region and left alone.
 */
export function regionLabel(country: string): string {
  const code = (country ?? "").trim().toUpperCase();
  if (code === "US") return "State";
  if (code === "CA") return "Province";
  if (code === "GB") return "County";
  return "State or region";
}
