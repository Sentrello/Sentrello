/**
 * US economic-nexus thresholds, state by state — data, deliberately.
 *
 * Since South Dakota v. Wayfair (2018), a business with no premises in a
 * state still owes its sales tax once sales into that state pass the state's
 * economic-nexus threshold. Almost every state settled on $100,000 of gross
 * sales; a handful set $250,000 or $500,000; some keep an alternative
 * 200-transaction test, and that test is being repealed state by state
 * (Illinois January 2026, Kentucky August 2026, Utah July 2025, Wyoming July
 * 2024 before them). Connecticut and New York are conjunctive: both the
 * dollar figure *and* the transaction count must be met.
 *
 * This file is the reference table and nothing else — no logic, so updating
 * a figure when a legislature moves is editing one entry here and shipping a
 * release. Figures checked 15 September 2026 against the Streamlined Sales
 * Tax state guide and the published state charts the scope note names; the
 * date travels with the data because these change a few times a year.
 *
 * Measurement periods vary by state — most use the previous or current
 * calendar year, Texas uses a rolling twelve months. The nexus report
 * computes current and previous calendar year and says so; it is a warning
 * light, not a determination, and the registration decision belongs to the
 * business and its accountant.
 */

export interface UsNexusThreshold {
  /** Gross sales into the state, in cents: $100,000 is 10,000,000. */
  salesCents: number;
  /** The alternative transaction-count test, where one still exists. */
  transactions: number | null;
  /**
   * How the two tests combine where both exist: "or" — either crosses it
   * (most states); "and" — both must be met (Connecticut, New York).
   */
  rule?: "or" | "and";
  /** The odd cases, stated rather than encoded. */
  note?: string;
}

const K100 = 10_000_000;
const K250 = 25_000_000;
const K500 = 50_000_000;

/**
 * Null: the state levies no general sales tax, so there is no threshold to
 * watch. (Alaska has no state tax but its municipalities levy local sales
 * taxes with a shared $100,000 remote-seller threshold, so it carries one.)
 */
export const US_NEXUS_THRESHOLDS: Record<string, UsNexusThreshold | null> = {
  AL: { salesCents: K250, transactions: null },
  AK: {
    salesCents: K100,
    transactions: null,
    note: "No state sales tax; municipal taxes under the ARSSTC share this remote-seller threshold.",
  },
  AZ: { salesCents: K100, transactions: null },
  AR: { salesCents: K100, transactions: 200, rule: "or" },
  CA: { salesCents: K500, transactions: null },
  CO: { salesCents: K100, transactions: null },
  CT: { salesCents: K100, transactions: 200, rule: "and" },
  DC: { salesCents: K100, transactions: 200, rule: "or" },
  DE: null,
  FL: { salesCents: K100, transactions: null },
  GA: { salesCents: K100, transactions: 200, rule: "or" },
  HI: { salesCents: K100, transactions: 200, rule: "or" },
  ID: { salesCents: K100, transactions: null },
  IL: {
    salesCents: K100,
    transactions: null,
    note: "The 200-transaction test was repealed effective 1 January 2026.",
  },
  IN: { salesCents: K100, transactions: null },
  IA: { salesCents: K100, transactions: null },
  KS: { salesCents: K100, transactions: null },
  KY: {
    salesCents: K100,
    transactions: null,
    note: "The 200-transaction test was repealed effective August 2026.",
  },
  LA: { salesCents: K100, transactions: null },
  ME: { salesCents: K100, transactions: null },
  MD: { salesCents: K100, transactions: 200, rule: "or" },
  MA: { salesCents: K100, transactions: null },
  MI: { salesCents: K100, transactions: 200, rule: "or" },
  MN: { salesCents: K100, transactions: 200, rule: "or" },
  MS: { salesCents: K250, transactions: null },
  MO: { salesCents: K100, transactions: null },
  MT: null,
  NE: { salesCents: K100, transactions: 200, rule: "or" },
  NV: { salesCents: K100, transactions: 200, rule: "or" },
  NH: null,
  NJ: { salesCents: K100, transactions: 200, rule: "or" },
  NM: { salesCents: K100, transactions: null },
  NY: { salesCents: K500, transactions: 100, rule: "and" },
  NC: { salesCents: K100, transactions: null },
  ND: { salesCents: K100, transactions: null },
  OH: { salesCents: K100, transactions: 200, rule: "or" },
  OK: { salesCents: K100, transactions: null },
  OR: null,
  PA: { salesCents: K100, transactions: null },
  PR: { salesCents: K100, transactions: 200, rule: "or" },
  RI: { salesCents: K100, transactions: 200, rule: "or" },
  SC: { salesCents: K100, transactions: null },
  SD: { salesCents: K100, transactions: null },
  TN: { salesCents: K100, transactions: null },
  TX: {
    salesCents: K500,
    transactions: null,
    note: "Texas measures the preceding twelve calendar months, not the calendar year.",
  },
  UT: { salesCents: K100, transactions: null },
  VT: { salesCents: K100, transactions: 200, rule: "or" },
  VA: { salesCents: K100, transactions: 200, rule: "or" },
  WA: { salesCents: K100, transactions: null },
  WV: { salesCents: K100, transactions: 200, rule: "or" },
  WI: { salesCents: K100, transactions: null },
  WY: { salesCents: K100, transactions: null },
};

/** When the figures above were last checked against the states. */
export const US_NEXUS_CHECKED = "2026-09-15";

/**
 * Full state names to postal codes, because "Texas" in a company record is
 * the same state as "TX" and a sum that treats them as strangers under-warns.
 */
export const US_STATE_CODES: Record<string, string> = {
  ALABAMA: "AL",
  ALASKA: "AK",
  ARIZONA: "AZ",
  ARKANSAS: "AR",
  CALIFORNIA: "CA",
  COLORADO: "CO",
  CONNECTICUT: "CT",
  DELAWARE: "DE",
  "DISTRICT OF COLUMBIA": "DC",
  FLORIDA: "FL",
  GEORGIA: "GA",
  HAWAII: "HI",
  IDAHO: "ID",
  ILLINOIS: "IL",
  INDIANA: "IN",
  IOWA: "IA",
  KANSAS: "KS",
  KENTUCKY: "KY",
  LOUISIANA: "LA",
  MAINE: "ME",
  MARYLAND: "MD",
  MASSACHUSETTS: "MA",
  MICHIGAN: "MI",
  MINNESOTA: "MN",
  MISSISSIPPI: "MS",
  MISSOURI: "MO",
  MONTANA: "MT",
  NEBRASKA: "NE",
  NEVADA: "NV",
  "NEW HAMPSHIRE": "NH",
  "NEW JERSEY": "NJ",
  "NEW MEXICO": "NM",
  "NEW YORK": "NY",
  "NORTH CAROLINA": "NC",
  "NORTH DAKOTA": "ND",
  OHIO: "OH",
  OKLAHOMA: "OK",
  OREGON: "OR",
  PENNSYLVANIA: "PA",
  "PUERTO RICO": "PR",
  "RHODE ISLAND": "RI",
  "SOUTH CAROLINA": "SC",
  "SOUTH DAKOTA": "SD",
  TENNESSEE: "TN",
  TEXAS: "TX",
  UTAH: "UT",
  VERMONT: "VT",
  VIRGINIA: "VA",
  WASHINGTON: "WA",
  "WEST VIRGINIA": "WV",
  WISCONSIN: "WI",
  WYOMING: "WY",
};

/** "tx", "Texas", " TX " → "TX"; anything unrecognisable → null. */
export function usStateCode(raw: string | null | undefined): string | null {
  const text = raw?.trim().toUpperCase() ?? "";
  if (!text) return null;
  if (text in US_NEXUS_THRESHOLDS) return text;
  return US_STATE_CODES[text] ?? null;
}
