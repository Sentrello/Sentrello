/**
 * A structured e-invoice: EN 16931, expressed as UBL 2.1.
 *
 * A PDF is not an invoice in much of the EU any more. Italy, France, Germany
 * and Poland mandate structured formats, and ViDA extends it across the union —
 * so a business in Milan cannot legally issue an invoice from a system that
 * only produces a document to look at.
 *
 * **EN 16931 is the semantic model** the rest are built from: Peppol BIS
 * Billing 3.0 is EN 16931 in UBL, German XRechnung is EN 16931 in UBL or CII,
 * and the country-specific formats map from the same fields. Producing the
 * European norm correctly is therefore the piece of work that serves all of
 * them; FatturaPA and KSeF are transformations of it, not separate models.
 *
 * **The most important behaviour here is refusing.** An e-invoice missing a
 * mandatory field is rejected by the receiving authority *after* the business
 * believes it has invoiced — the money does not arrive and nobody knows why for
 * a fortnight. So the generator will not produce one until the data is there,
 * and says exactly what is missing, in the words of the business rather than
 * the standard.
 */

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
}

export interface EInvoiceLine {
  description: string;
  /** Thousandths, as the invoice stores them. */
  quantityMilli: number;
  unit: string;
  unitPriceCents: number;
  netCents: number;
  taxRateBp: number;
}

export interface EInvoiceInput {
  number: string;
  issueDate: Date;
  dueDate?: Date | null;
  currency: string;
  seller: Party;
  buyer: Party;
  lines: EInvoiceLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  /** What the buyer still owes, which is not always the total. BT-115. */
  dueCents: number;
  note?: string | null;
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
   * Cross-border within the EU needs both VAT numbers: it is what makes a
   * reverse-charge supply provable. Not required for a domestic invoice, so it
   * is only asked for when the countries differ.
   */
  const crossBorder =
    input.seller.countryCode &&
    input.buyer.countryCode &&
    input.seller.countryCode !== input.buyer.countryCode;
  if (crossBorder && !input.seller.taxId) {
    missing.push("your VAT number, which a cross-border invoice needs");
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

function partyXml(tag: string, party: Party): string {
  return `  <cac:${tag}>
    <cac:Party>
      <cac:PostalAddress>
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
    </cac:Party>
  </cac:${tag}>`;
}

/**
 * The invoice as UBL 2.1, conforming to EN 16931.
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

  /**
   * Tax grouped by rate, which is what the standard asks for.
   *
   * `TaxSubtotal` is per rate, not per line — an invoice with items at 20% and
   * at 5% has two subtotals, and repeating a rate is a validation failure
   * rather than a stylistic choice.
   */
  const byRate = new Map<number, { net: number; tax: number }>();
  for (const line of input.lines) {
    const at = byRate.get(line.taxRateBp) ?? { net: 0, tax: 0 };
    at.net += line.netCents;
    at.tax += Math.round((line.netCents * line.taxRateBp) / 10_000);
    byRate.set(line.taxRateBp, at);
  }

  const subtotals = [...byRate.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(
      ([rateBp, sums]) => `    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${input.currency}">${amount(sums.net)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${input.currency}">${amount(sums.tax)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>${rateBp === 0 ? "Z" : "S"}</cbc:ID>
        <cbc:Percent>${(rateBp / 100).toFixed(2)}</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>`,
    )
    .join("\n");

  const lines = input.lines
    .map(
      (line, at) => `  <cac:InvoiceLine>
    <cbc:ID>${at + 1}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="${esc(line.unit || "EA")}">${(line.quantityMilli / 1000).toFixed(3)}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${input.currency}">${amount(line.netCents)}</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Name>${esc(line.description)}</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>${line.taxRateBp === 0 ? "Z" : "S"}</cbc:ID>
        <cbc:Percent>${(line.taxRateBp / 100).toFixed(2)}</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="${input.currency}">${amount(line.unitPriceCents)}</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017</cbc:CustomizationID>
  <cbc:ID>${esc(input.number)}</cbc:ID>
  <cbc:IssueDate>${day(input.issueDate)}</cbc:IssueDate>
${input.dueDate ? `  <cbc:DueDate>${day(input.dueDate)}</cbc:DueDate>\n` : ""}  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
${input.note ? `  <cbc:Note>${esc(input.note)}</cbc:Note>\n` : ""}  <cbc:DocumentCurrencyCode>${esc(input.currency)}</cbc:DocumentCurrencyCode>
${partyXml("AccountingSupplierParty", input.seller)}
${partyXml("AccountingCustomerParty", input.buyer)}
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${input.currency}">${amount(input.taxCents)}</cbc:TaxAmount>
${subtotals}
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${input.currency}">${amount(input.subtotalCents)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${input.currency}">${amount(input.subtotalCents)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${input.currency}">${amount(input.totalCents)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${input.currency}">${amount(input.dueCents)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${lines}
</Invoice>
`;
}
