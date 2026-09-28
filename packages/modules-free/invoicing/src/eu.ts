/**
 * Who the European VAT rules apply to, in one list.
 *
 * Pulled out of `distance-selling.ts` on 2026-09-28 so the e-invoice
 * generator could ask the same question. That file reaches the database and
 * the module context; `einvoice.ts` deliberately reaches neither, and a
 * second copy of the member states in it would be a list that drifts the day
 * one of them changes.
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
 * Whether a business in this country issues invoices under EN 16931 at all.
 *
 * The EU by the directive, and the United Kingdom by having kept the standard
 * after leaving: HMRC's own e-invoicing consultation and every UK Peppol
 * access point address the same document. Sentrello sells into two further
 * markets, and neither of them has anything to do with it — the United States
 * has no national e-invoice mandate and Canada's federal procurement runs on
 * Peppol BIS rather than on a domestic norm.
 *
 * Asked of the *seller*, because the standard is a rule about who is issuing.
 */
export const issuesEn16931 = (raw: string | null | undefined): boolean => {
  const code = raw?.trim().toUpperCase() ?? "";
  return code === "GB" || euCountry(code) !== null;
};
