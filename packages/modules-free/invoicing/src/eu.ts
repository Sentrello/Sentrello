/**
 * Who the European VAT rules apply to, in one list.
 *
 * Pulled out of `distance-selling.ts` on 2026-09-28 so the e-invoice generator
 * could ask the same question, and moved into `@sentrello/db/countries` on
 * 2026-10-08 so the ledger could ask it too: which tax regime a business
 * operates in, before it has chosen, is the same question about the same
 * country. Re-exported from here because every caller in this module already
 * asks it of this file, and the import it reaches for is pure — no database
 * client, which is what `einvoice.ts` needs it to stay.
 */

import { euCountry } from "@sentrello/db/countries";

export { euCountry };

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
  /*
   * "UK" is not a country code and people type it anyway.
   *
   * Settings asks for two letters and checks only that there are two of them,
   * so `UK` is storable — and every other reader of this field already fails
   * on it quietly (`EAS_VAT_BY_COUNTRY` has `GB`, so an electronic address
   * cannot be derived). Refusing a British business the standard it does use,
   * by name, on a typo, is a worse failure than any of those. Accepted here
   * rather than rewritten in the database, which is a migration and somebody
   * else's decision.
   */
  if (code === "UK") return true;
  return code === "GB" || euCountry(code) !== null;
};
