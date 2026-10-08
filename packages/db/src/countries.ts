/**
 * Which country a business trades in, where that decides behaviour.
 *
 * No imports, deliberately: the e-invoice generator reaches neither the
 * database nor a module context, and this list has to be askable from there as
 * well as from a function that reads `organizations`.
 *
 * Here rather than in the invoicing module, where the member states lived until
 * 2026-10-08, because the ledger needs the same question answered — which tax
 * regime a business operates in, before it has said. A second copy of the
 * membership would be a list that drifts the day one of them changes.
 */

/** The member states, by the atlas codes company records carry. */
const EU_MEMBERS = new Set([
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
  "EL", // Greece as the VAT register spells it, for the record typed that way
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
]);

export const euCountry = (raw: string | null | undefined): string | null => {
  const code = raw?.trim().toUpperCase() ?? "";
  if (!EU_MEMBERS.has(code)) return null;
  return code === "EL" ? "GR" : code;
};

/**
 * The one market a country belongs to, as this product divides the world.
 *
 * The US, Canada, the UK and the EU, and nothing else — the same scoping
 * instrument that decides which tax regimes exist at all. Null for a country
 * outside all four, which is a business we do not have rules for and must not
 * guess at.
 *
 * "UK" is not a country code and people type it anyway; Settings asks for two
 * letters and checks only that there are two of them, so it is storable. Read
 * the same way `issuesEn16931` reads it, for the same reason — refusing a
 * British business its own tax screen over a typo is worse than accepting one.
 */
export type Market = "US" | "CA" | "GB" | "EU";

export const marketFor = (raw: string | null | undefined): Market | null => {
  const code = raw?.trim().toUpperCase() ?? "";
  if (code === "US") return "US";
  if (code === "CA") return "CA";
  if (code === "GB" || code === "UK") return "GB";
  return euCountry(code) ? "EU" : null;
};
