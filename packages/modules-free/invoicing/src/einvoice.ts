/**
 * A structured e-invoice: EN 16931, expressed as UBL 2.1, up to the transport
 * profiles the networks actually validate against.
 *
 * A PDF is not an invoice in much of the EU any more. Italy, France, Germany
 * and Poland mandate structured formats, and ViDA extends it across the union —
 * so a business in Milan cannot legally issue an invoice from a system that
 * only produces a document to look at.
 *
 * **EN 16931 is the semantic model** the rest are built from, and three
 * profiles of it come out of this file:
 *
 * - `en16931` — the bare European norm, for anything that accepts it.
 * - `peppol` — Peppol BIS Billing 3.0, the profile the Peppol network's own
 *   validation enforces: the BIS specification identifier, the business
 *   process, an electronic address for each party, a buyer reference. This is
 *   what Belgium's B2B mandate and most EU reception mandates mean in
 *   practice.
 * - `xrechnung` — the German CIUS. Everything BIS asks plus the BR-DE rules:
 *   payment instructions with an IBAN, a seller contact point with phone and
 *   email, full postal addresses, and the buyer reference German public
 *   bodies route by (the Leitweg-ID).
 *
 * **The most important behaviour here is refusing.** An e-invoice missing a
 * mandatory field is rejected by the receiving authority *after* the business
 * believes it has invoiced — the money does not arrive and nobody knows why for
 * a fortnight. So the generator will not produce one until the data is there,
 * and says exactly what is missing, in the words of the business rather than
 * the standard.
 */

import { bpToPpm, percentFromPpm } from "@sentrello/db/money";

/** The profiles this generator can conform to. */
export type EInvoiceProfile = "en16931" | "peppol" | "xrechnung";

export const EINVOICE_PROFILES: readonly EInvoiceProfile[] = [
  "en16931",
  "peppol",
  "xrechnung",
];

export interface Party {
  name: string;
  /** Free-text street. BT-35. */
  street?: string | null;
  city?: string | null;
  postcode?: string | null;
  /** ISO 3166-1 alpha-2. Mandatory: BT-40 for the seller, BT-55 for the buyer. */
  countryCode?: string | null;
  /** A VAT registration, where there is one. BT-31 / BT-48. */
  taxId?: string | null;
  /**
   * The party's electronic address on the network (BT-34 / BT-49), with the
   * EAS scheme that says what kind of identifier it is. When absent, the VAT
   * number stands in — which is how most EU businesses are addressed on
   * Peppol anyway.
   */
  endpointId?: string | null;
  endpointScheme?: string | null;
  /**
   * A contact point (BG-6 / BG-9). Germany makes the seller's mandatory —
   * name, phone and email, each its own BR-DE rule — so an XRechnung without
   * them is refused with the missing piece named.
   */
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
}

/** One tax on a line, as the XML needs to state it. */
export interface EInvoiceLineTax {
  /** Millionths — 99,750 is 9.975%. Wins when both fields are present. */
  ratePpm?: number | null;
  /** @deprecated Basis points, read as `bp × 100`. */
  rateBp?: number | null;
  /** EN 16931 category: S, Z, E, AE, AA, G, O… */
  categoryCode: string;
  /** Charged on the net plus the taxes before it. */
  compound?: boolean;
}

export interface EInvoiceLine {
  description: string;
  /** Thousandths, as the invoice stores them. */
  quantityMilli: number;
  unit: string;
  unitPriceCents: number;
  netCents: number;
  /** Millionths — 99,750 is 9.975%. Wins when both fields are present. */
  taxRatePpm?: number | null;
  /** @deprecated Basis points, read as `bp × 100`. */
  taxRateBp?: number | null;
  /**
   * Every tax on the line, with its category. Absent for older documents,
   * where the bare rate above is all that was recorded — those fall back to
   * standard-or-zero, which is the most an uncategorised rate can honestly
   * claim.
   */
  taxes?: EInvoiceLineTax[] | null;
}

/**
 * One entry of the document's frozen tax breakdown.
 *
 * Passed in from `document_taxes` where the caller has a stored document:
 * the bands were written when it was issued, after the discount was
 * apportioned, and they are what the totals block already reflects.
 * Recomputing from undiscounted line nets makes the breakdown disagree with
 * the totals — BR-CO-14 failing, which is a rejected invoice.
 */
export interface EInvoiceTaxBand {
  /** Millionths — 99,750 is 9.975%. Wins when both fields are present. */
  ratePpm?: number | null;
  /** @deprecated Basis points, read as `bp × 100`. */
  rateBp?: number | null;
  categoryCode: string;
  taxableCents: number;
  taxCents: number;
  /** Why no tax is charged, for categories E, AE and O. */
  exemptionReason?: string | null;
}

export interface EInvoiceInput {
  number: string;
  issueDate: Date;
  dueDate?: Date | null;
  currency: string;
  /**
   * Which rulebook the document must satisfy. Defaults to the bare norm, so
   * every existing caller keeps the document it always got.
   */
  profile?: EInvoiceProfile;
  /**
   * `invoice` or `credit_note`, as the document stores it. A credit note is a
   * different document type on the network — UBL CreditNote, type 381 — and
   * emitting one as an invoice states money owed in the wrong direction, so
   * it is refused rather than mislabelled.
   */
  kind?: string | null;
  seller: Party;
  buyer: Party;
  /**
   * BT-10 — the reference the customer files invoices by. The Peppol network
   * refuses a document without one (or an order reference), and a German
   * public body's Leitweg-ID travels in this field.
   */
  buyerReference?: string | null;
  /** BT-20 — "30 days net", or whatever the business writes. */
  paymentTerms?: string | null;
  /** Where a bank transfer goes. Germany will not validate without it. */
  payment?: { iban?: string | null; accountName?: string | null } | null;
  lines: EInvoiceLine[];
  /** The document's frozen tax breakdown, when the caller has one stored. */
  bands?: EInvoiceTaxBand[] | null;
  subtotalCents: number;
  /**
   * A whole-document discount (BT-92). The bands already reflect it; the XML
   * must state it as a document-level allowance per tax band, or the
   * validator's own arithmetic — lines minus allowances equals each band's
   * taxable amount — does not close.
   */
  discountCents?: number | null;
  taxCents: number;
  totalCents: number;
  /** What the buyer still owes, which is not always the total. BT-115. */
  dueCents: number;
  note?: string | null;
}

/**
 * The EAS scheme for "this country's VAT number", from the published
 * Electronic Address Scheme code list. A business's VAT registration is how
 * most EU parties are addressed on the network, so where a country has a VAT
 * scheme, the VAT number already on the record serves as the electronic
 * address and nobody is asked for a second identifier.
 *
 * Sweden and a few others have no VAT-number scheme in the list; a business
 * there supplies an explicit endpoint instead, and the preflight says so.
 */
const EAS_VAT_BY_COUNTRY: Record<string, string> = {
  AT: "9914",
  BE: "9925",
  BG: "9926",
  CH: "9927",
  CY: "9928",
  CZ: "9929",
  DE: "9930",
  DK: "0198",
  EE: "9931",
  ES: "9920",
  FI: "0213",
  FR: "9957",
  GB: "9932",
  GR: "9933",
  HR: "9934",
  HU: "9910",
  IE: "9935",
  IT: "0211",
  LT: "9937",
  LU: "9938",
  LV: "9939",
  MT: "9943",
  NL: "9944",
  PL: "9945",
  PT: "9946",
  RO: "9947",
  SI: "9949",
  SK: "9950",
};

/**
 * The party's electronic address: the explicit one, else the VAT number.
 *
 * Exported because sending needs the same answer the document does. A
 * transport that worked the address out for itself would be a second rule
 * about who an invoice is addressed to, and the two would disagree the day
 * somebody filled in an endpoint by hand.
 */
export function endpointFor(
  party: Party,
): { scheme: string; id: string } | null {
  if (party.endpointId && party.endpointScheme) {
    return { scheme: party.endpointScheme, id: party.endpointId };
  }
  const scheme = EAS_VAT_BY_COUNTRY[party.countryCode ?? ""];
  if (scheme && party.taxId) return { scheme, id: party.taxId.trim() };
  return null;
}

/**
 * Common invoice units as UN/ECE Recommendation 20/21 codes.
 *
 * The wire format accepts only the codes; a unit typed as a word must become
 * one or the whole document is rejected over "hours". An already-valid code
 * passes through untouched, and an unknown word degrades to C62 — the
 * generic "one" — because the line's description still says what the thing
 * is, and a generic unit is a readable invoice where a rejected one is not.
 */
const UNIT_CODES: Record<string, string> = {
  each: "EA",
  piece: "H87",
  pieces: "H87",
  pc: "H87",
  pcs: "H87",
  hour: "HUR",
  hours: "HUR",
  hr: "HUR",
  hrs: "HUR",
  day: "DAY",
  days: "DAY",
  week: "WEE",
  weeks: "WEE",
  month: "MON",
  months: "MON",
  year: "ANN",
  years: "ANN",
  kg: "KGM",
  g: "GRM",
  l: "LTR",
  litre: "LTR",
  liter: "LTR",
  m: "MTR",
  metre: "MTR",
  meter: "MTR",
  km: "KMT",
  m2: "MTK",
  m3: "MTQ",
  set: "SET",
  box: "XBX",
  unit: "C62",
  units: "C62",
};

function unitCode(unit: string): string {
  const raw = unit.trim();
  if (!raw) return "EA";
  if (/^[A-Z0-9]{2,3}$/.test(raw)) return raw;
  return UNIT_CODES[raw.toLowerCase()] ?? "C62";
}

/** An IBAN as the wire wants it: no spaces, upper case. Null when absent. */
function cleanIban(iban: string | null | undefined): string | null {
  const cleaned = (iban ?? "").replace(/\s+/g, "").toUpperCase();
  return cleaned || null;
}

/**
 * The taxes a line states, however old the line is.
 *
 * A line written before categories reached the document carries only a bare
 * rate; standard-or-zero is the most it can honestly claim. E and AE lines
 * written since carry their category in `taxes`, which is the whole point —
 * an exempt line emitted as Z is a mislabelled document, and validators
 * reject it.
 */
function taxesOn(line: EInvoiceLine): EInvoiceLineTax[] {
  if (line.taxes?.length) return line.taxes;
  const ratePpm = resolvePpm(line.taxRatePpm, line.taxRateBp);
  return [{ ratePpm, categoryCode: ratePpm === 0 ? "Z" : "S" }];
}

/** Millionths when stated; a rate frozen in basis points read as ×100. */
function resolvePpm(
  ppm: number | null | undefined,
  bp: number | null | undefined,
): number {
  return ppm ?? bpToPpm(bp ?? 0);
}

/** Every VAT category the document states, from the bands or the lines. */
function categoriesIn(input: EInvoiceInput): Set<string> {
  const categories = new Set<string>();
  if (input.bands?.length) {
    for (const band of input.bands) categories.add(band.categoryCode);
  } else {
    for (const line of input.lines) {
      for (const tax of taxesOn(line)) categories.add(tax.categoryCode);
    }
  }
  return categories;
}

/**
 * Why no tax is charged, for the categories that must say so.
 *
 * EN 16931 rejects an E, AE, G or O breakdown without a reason (BR-E-10,
 * BR-AE-10, BR-G-10, BR-O-10). The definition's own wording wins; these are
 * the fallbacks so an absent description is a generic reason rather than a
 * rejected invoice.
 */
export function exemptionReasonFor(
  categoryCode: string,
  given: string | null,
): string | null {
  if (given) return given;
  switch (categoryCode) {
    case "E":
      return "Exempt from VAT";
    case "AE":
      return "Reverse charge";
    case "G":
      return "Export outside the EU";
    case "O":
      return "Not subject to VAT";
    default:
      return null;
  }
}

/**
 * What is missing, in the customer's words.
 *
 * Named by what a person would go and fix rather than by field code. "BT-55 is
 * absent" sends somebody to a specification; "your customer's country is
 * missing" sends them to the customer record, which is where the answer is.
 */
export function missingForEInvoice(input: EInvoiceInput): string[] {
  const missing: string[] = [];
  const profile = input.profile ?? "en16931";

  /*
   * A credit note is not a field to fill in, but it rides the same refusal:
   * the network treats it as a different document type entirely, and an
   * invoice claiming to be one states the money in the wrong direction.
   */
  if (input.kind === "credit_note") {
    missing.push(
      "this is a credit note, and a structured credit note is a different document on the network — it cannot be issued as an e-invoice yet",
    );
  }

  if (!input.seller.name) missing.push("your business name");
  if (!input.seller.countryCode) {
    missing.push("your country — set it in Settings, under your business");
  }
  if (!input.buyer.name) missing.push("your customer's name");
  if (!input.buyer.countryCode) {
    /*
     * The commonest gap by far, and worth being specific about: an address
     * lives on a *company* in this platform, so a customer recorded only as a
     * person has nowhere to hold one.
     */
    missing.push(
      "your customer's country — an address lives on the company record, so a customer saved only as a person will not have one",
    );
  }
  if (!input.lines.length) missing.push("at least one line on the invoice");

  /*
   * UBL-SR-48: the European norm allows one and only one tax category on a
   * line. Two taxes on one line is a Canadian document — GST beside PST —
   * and no arrangement of the XML expresses it; the official validator
   * rejects a second category outright. Refused with the reason, because a
   * business that stacks taxes deserves to hear "this standard cannot say
   * that" rather than a rejection code from a foreign machine.
   */
  if (input.lines.some((line) => (line.taxes?.length ?? 0) > 1)) {
    missing.push(
      "one tax per line — the European e-invoice standard allows a single VAT category on each line, so a document with two taxes on a line (GST and PST, say) cannot be sent as one",
    );
  }

  const categories = categoriesIn(input);
  const charged = [...categories].filter((c) => c !== "O");

  /*
   * BR-S-02 and its siblings: an invoice that charges or classifies VAT —
   * standard, zero, exempt or reverse charge alike — must identify the seller
   * to the tax authority, domestic or not. Only a document entirely outside
   * the scope of VAT escapes.
   */
  if (charged.length && !input.seller.taxId) {
    missing.push(
      "your VAT number — an invoice that deals in VAT must identify you to the tax authority; set it in Settings, under your business",
    );
  }

  /*
   * BR-AE-02: reverse charge hands the VAT to the customer, so the document
   * must identify them. Without their number the supply is not provable and
   * the validator rejects it.
   */
  if (categories.has("AE") && !input.buyer.taxId) {
    missing.push(
      "your customer's VAT number — reverse charge moves the VAT to them, and the invoice must say who they are",
    );
  }

  /*
   * BR-O-11 to BR-O-14: a line out of scope of VAT cannot share a document
   * with taxed lines. Two invoices, not one.
   */
  if (categories.has("O") && charged.length) {
    missing.push(
      "a single tax treatment — a line out of scope of VAT cannot share an invoice with taxed lines; issue it separately",
    );
  }

  /* BR-CO-25: an amount owed has to say when it is owed. */
  if (input.dueCents > 0 && !input.dueDate && !input.paymentTerms?.trim()) {
    missing.push(
      "a due date or payment terms — an invoice asking for money must say when",
    );
  }

  if (profile === "peppol" || profile === "xrechnung") {
    /*
     * PEPPOL-EN16931-R020/R010: each party needs an electronic address. The
     * VAT number usually serves — the preflight says so rather than asking
     * for a second identifier nobody has.
     */
    if (!endpointFor(input.seller)) {
      missing.push(
        "your electronic address on the network — your VAT number serves as one; set it in Settings, or provide a Peppol participant ID",
      );
    }
    if (!endpointFor(input.buyer)) {
      missing.push(
        "your customer's electronic address — their VAT number on the company record serves as one, or their Peppol participant ID",
      );
    }
    /* PEPPOL-EN16931-R003, and BR-DE-15 for Germany. */
    if (!input.buyerReference?.trim()) {
      missing.push(
        profile === "xrechnung"
          ? "the buyer reference — a German public body routes by its Leitweg-ID, which goes here; otherwise the reference your customer asked for"
          : "a buyer reference — the PO number or reference your customer files invoices under",
      );
    }
  }

  if (profile === "xrechnung") {
    /* BR-DE-3/4 and BR-DE-8/9: both postal addresses, in full. */
    if (!input.seller.city || !input.seller.postcode) {
      missing.push("your city and postcode — a German invoice carries them");
    }
    if (!input.buyer.city || !input.buyer.postcode) {
      missing.push("your customer's city and postcode");
    }
    /* BR-DE-5/6/7: a seller contact point, with phone and email. */
    if (!input.seller.contactPhone) {
      missing.push(
        "a phone number for your business, for the invoice's contact point",
      );
    }
    if (!input.seller.contactEmail) {
      missing.push(
        "an email address for your business, for the invoice's contact point",
      );
    }
    /* BR-DE-1: payment instructions, which for a transfer means the IBAN. */
    if (!cleanIban(input.payment?.iban)) {
      missing.push(
        "your IBAN — a German invoice must say where to pay; set your bank details in Settings",
      );
    }
  }

  return missing;
}

const esc = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Cents to the decimal string the standard wants. */
const amount = (cents: number) => (cents / 100).toFixed(2);
const day = (date: Date) => date.toISOString().slice(0, 10);

/**
 * The percent element for a tax category — absent for O, because BR-O-05 to
 * BR-O-07 reject a rate on something outside the scope of VAT.
 */
function percentXml(
  categoryCode: string,
  ratePpm: number,
  indent: string,
): string {
  if (categoryCode === "O") return "";
  return `${indent}<cbc:Percent>${percentFromPpm(ratePpm)}</cbc:Percent>\n`;
}

function partyXml(tag: string, party: Party): string {
  const endpoint = endpointFor(party);
  const contact =
    party.contactName || party.contactPhone || party.contactEmail
      ? `      <cac:Contact>
${party.contactName ? `        <cbc:Name>${esc(party.contactName)}</cbc:Name>\n` : ""}${
  party.contactPhone
    ? `        <cbc:Telephone>${esc(party.contactPhone)}</cbc:Telephone>\n`
    : ""
}${
  party.contactEmail
    ? `        <cbc:ElectronicMail>${esc(party.contactEmail)}</cbc:ElectronicMail>\n`
    : ""
}      </cac:Contact>\n`
      : "";
  return `  <cac:${tag}>
    <cac:Party>
${
  endpoint
    ? `      <cbc:EndpointID schemeID="${esc(endpoint.scheme)}">${esc(endpoint.id)}</cbc:EndpointID>\n`
    : ""
}      <cac:PostalAddress>
${party.street ? `        <cbc:StreetName>${esc(party.street)}</cbc:StreetName>\n` : ""}${
  party.city ? `        <cbc:CityName>${esc(party.city)}</cbc:CityName>\n` : ""
}${party.postcode ? `        <cbc:PostalZone>${esc(party.postcode)}</cbc:PostalZone>\n` : ""}        <cac:Country>
          <cbc:IdentificationCode>${esc(party.countryCode ?? "")}</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
${
  party.taxId
    ? `      <cac:PartyTaxScheme>
        <cbc:CompanyID>${esc(party.taxId)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>\n`
    : ""
}      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${esc(party.name)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
${contact}    </cac:Party>
  </cac:${tag}>`;
}

/** The specification identifier and business process, per profile. */
const PROFILE_IDS: Record<
  EInvoiceProfile,
  { customization: string; process: string | null }
> = {
  en16931: { customization: "urn:cen.eu:en16931:2017", process: null },
  peppol: {
    customization:
      "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0",
    process: "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0",
  },
  xrechnung: {
    customization:
      "urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0",
    process: "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0",
  },
};

/**
 * The invoice as UBL 2.1, conforming to the requested profile.
 *
 * Throws rather than returning something invalid. A caller that ignored a
 * "missing fields" list and sent the XML anyway would produce exactly the
 * failure this file exists to prevent, so the door is closed rather than
 * signposted.
 */
export function toUbl(input: EInvoiceInput): string {
  const missing = missingForEInvoice(input);
  if (missing.length) {
    throw new Error(
      `this invoice cannot be sent as a structured e-invoice yet: ${missing.join("; ")}`,
    );
  }

  const profile = PROFILE_IDS[input.profile ?? "en16931"];
  const discountCents = input.discountCents ?? 0;

  /**
   * Tax grouped by category and rate, which is what the standard asks for.
   *
   * `TaxSubtotal` is per category-and-rate, not per line — an invoice with
   * items at 20% and at 5% has two subtotals, and repeating one is a
   * validation failure rather than a stylistic choice.
   *
   * The document's stored bands govern when the caller supplied them: they
   * were frozen at issue, after the discount was apportioned, and they are
   * what the totals block already states — so the breakdown and the totals
   * agree to the cent (BR-CO-14). Without bands, the figures are computed the
   * way the document's totals were: the discount spread across the lines by
   * share, each line's tax rounded on its relieved base.
   */
  const byCategory = new Map<
    string,
    {
      ratePpm: number;
      categoryCode: string;
      net: number;
      tax: number;
      exemptionReason: string | null;
    }
  >();
  const add = (band: EInvoiceTaxBand & { taxableCents: number }) => {
    const ratePpm = resolvePpm(band.ratePpm, band.rateBp);
    const key = `${band.categoryCode}|${ratePpm}`;
    const at = byCategory.get(key) ?? {
      ratePpm,
      categoryCode: band.categoryCode,
      net: 0,
      tax: 0,
      exemptionReason: null,
    };
    at.net += band.taxableCents;
    at.tax += band.taxCents;
    at.exemptionReason ??= band.exemptionReason ?? null;
    byCategory.set(key, at);
  };

  /*
   * What the lines themselves say per category-and-rate, before any
   * discount. The validator re-runs this arithmetic — each band's taxable
   * amount must equal its lines minus its share of the allowances (BR-S-08)
   * — so the difference between the two is exactly the allowance the XML
   * must state.
   */
  const lineNetByGroup = new Map<string, number>();
  for (const line of input.lines) {
    for (const tax of taxesOn(line)) {
      const key = `${tax.categoryCode}|${resolvePpm(tax.ratePpm, tax.rateBp)}`;
      lineNetByGroup.set(key, (lineNetByGroup.get(key) ?? 0) + line.netCents);
    }
  }

  if (input.bands?.length) {
    for (const band of input.bands) add(band);
  } else {
    /*
     * The discount spread across the lines by share of the subtotal, with
     * the remainder given to the largest line — the same apportionment the
     * document's totals were built with, so the two agree to the cent.
     */
    const nets = input.lines.map((line) => line.netCents);
    const subtotal = nets.reduce((sum, net) => sum + net, 0);
    const relief = nets.map((net) =>
      subtotal > 0 ? Math.round((discountCents * net) / subtotal) : 0,
    );
    const spread = relief.reduce((sum, r) => sum + r, 0);
    if (spread !== discountCents && relief.length > 0) {
      let biggest = 0;
      for (let i = 1; i < nets.length; i += 1) {
        if ((nets[i] as number) > (nets[biggest] as number)) biggest = i;
      }
      relief[biggest] = (relief[biggest] as number) + (discountCents - spread);
    }

    for (const [i, line] of input.lines.entries()) {
      const taxable = line.netCents - (relief[i] as number);
      let stacked = 0;
      for (const tax of taxesOn(line)) {
        const ratePpm = resolvePpm(tax.ratePpm, tax.rateBp);
        const base = tax.compound ? taxable + stacked : taxable;
        const taxCents = Math.round((base * ratePpm) / 1_000_000);
        stacked += taxCents;
        add({
          ratePpm,
          categoryCode: tax.categoryCode,
          taxableCents: base,
          taxCents,
        });
      }
    }
  }

  const sorted = [...byCategory.entries()].sort(
    ([, a], [, b]) =>
      a.categoryCode.localeCompare(b.categoryCode) || a.ratePpm - b.ratePpm,
  );

  const subtotals = sorted
    .map(
      ([, band]) => `    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${input.currency}">${amount(band.net)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${input.currency}">${amount(band.tax)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>${esc(band.categoryCode)}</cbc:ID>
${percentXml(band.categoryCode, band.ratePpm, "        ")}${
  /*
   * Exempt, reverse-charge and out-of-scope categories must say why no tax
   * is charged — BR-E-10, BR-AE-10 and BR-O-10 all reject a breakdown that
   * does not. The definition's own wording where there is one; the standard
   * phrase where there is not, because an absent reason is a rejection and a
   * generic one is not.
   */
  exemptionReasonFor(band.categoryCode, band.exemptionReason)
    ? `        <cbc:TaxExemptionReason>${esc(exemptionReasonFor(band.categoryCode, band.exemptionReason) ?? "")}</cbc:TaxExemptionReason>\n`
    : ""
}        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>`,
    )
    .join("\n");

  /*
   * The document-level discount, stated per tax band (BR-32 wants a category
   * on every allowance, and BR-S-08 reconciles each band separately). The
   * amount per band is what its lines say minus what the frozen band says —
   * which is exactly the share of the discount that band absorbed at issue.
   */
  const allowances =
    discountCents > 0
      ? sorted
          .map(([key, band]) => {
            const lineNet = lineNetByGroup.get(key);
            if (lineNet === undefined || lineNet <= band.net) return "";
            return `  <cac:AllowanceCharge>
    <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
    <cbc:AllowanceChargeReason>Discount</cbc:AllowanceChargeReason>
    <cbc:Amount currencyID="${input.currency}">${amount(lineNet - band.net)}</cbc:Amount>
    <cac:TaxCategory>
      <cbc:ID>${esc(band.categoryCode)}</cbc:ID>
${percentXml(band.categoryCode, band.ratePpm, "      ")}      <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
    </cac:TaxCategory>
  </cac:AllowanceCharge>`;
          })
          .filter(Boolean)
          .join("\n")
      : "";

  const iban = cleanIban(input.payment?.iban);
  const paymentMeans = iban
    ? `  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>58</cbc:PaymentMeansCode>
    <cac:PayeeFinancialAccount>
      <cbc:ID>${esc(iban)}</cbc:ID>
${
  input.payment?.accountName
    ? `      <cbc:Name>${esc(input.payment.accountName)}</cbc:Name>\n`
    : ""
}    </cac:PayeeFinancialAccount>
  </cac:PaymentMeans>\n`
    : "";

  const paymentTerms = input.paymentTerms?.trim()
    ? `  <cac:PaymentTerms>
    <cbc:Note>${esc(input.paymentTerms.trim())}</cbc:Note>
  </cac:PaymentTerms>\n`
    : "";

  const lines = input.lines
    .map(
      (line, at) => `  <cac:InvoiceLine>
    <cbc:ID>${at + 1}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="${esc(unitCode(line.unit))}">${(line.quantityMilli / 1000).toFixed(3)}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${input.currency}">${amount(line.netCents)}</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Name>${esc(line.description)}</cbc:Name>
${taxesOn(line)
  .map(
    (tax) => `      <cac:ClassifiedTaxCategory>
        <cbc:ID>${esc(tax.categoryCode)}</cbc:ID>
${percentXml(tax.categoryCode, resolvePpm(tax.ratePpm, tax.rateBp), "        ")}        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:ClassifiedTaxCategory>`,
  )
  .join("\n")}
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="${input.currency}">${amount(line.unitPriceCents)}</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>`,
    )
    .join("\n");

  /*
   * The totals, as the validator re-adds them: the line sum stands as it is
   * (BR-CO-10), the tax-exclusive total is after the allowance (BR-CO-13),
   * and money already received is stated so payable = total − prepaid closes
   * (BR-CO-16). An e-invoice quoting the full total on a part-paid invoice
   * asks the customer for money they have already sent.
   */
  const prepaidCents = input.totalCents - input.dueCents;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>${profile.customization}</cbc:CustomizationID>
${profile.process ? `  <cbc:ProfileID>${profile.process}</cbc:ProfileID>\n` : ""}  <cbc:ID>${esc(input.number)}</cbc:ID>
  <cbc:IssueDate>${day(input.issueDate)}</cbc:IssueDate>
${input.dueDate ? `  <cbc:DueDate>${day(input.dueDate)}</cbc:DueDate>\n` : ""}  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
${input.note ? `  <cbc:Note>${esc(input.note)}</cbc:Note>\n` : ""}  <cbc:DocumentCurrencyCode>${esc(input.currency)}</cbc:DocumentCurrencyCode>
${input.buyerReference?.trim() ? `  <cbc:BuyerReference>${esc(input.buyerReference.trim())}</cbc:BuyerReference>\n` : ""}${partyXml("AccountingSupplierParty", input.seller)}
${partyXml("AccountingCustomerParty", input.buyer)}
${paymentMeans}${paymentTerms}${allowances ? `${allowances}\n` : ""}  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${input.currency}">${amount(input.taxCents)}</cbc:TaxAmount>
${subtotals}
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${input.currency}">${amount(input.subtotalCents)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${input.currency}">${amount(input.subtotalCents - discountCents)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${input.currency}">${amount(input.totalCents)}</cbc:TaxInclusiveAmount>
${discountCents > 0 ? `    <cbc:AllowanceTotalAmount currencyID="${input.currency}">${amount(discountCents)}</cbc:AllowanceTotalAmount>\n` : ""}${prepaidCents > 0 ? `    <cbc:PrepaidAmount currencyID="${input.currency}">${amount(prepaidCents)}</cbc:PrepaidAmount>\n` : ""}    <cbc:PayableAmount currencyID="${input.currency}">${amount(input.dueCents)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${lines}
</Invoice>
`;
}
