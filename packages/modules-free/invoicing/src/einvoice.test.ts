import { expect, test } from "bun:test";
import { type EInvoiceInput, missingForEInvoice, toUbl } from "./einvoice";

/**
 * A structured e-invoice is either accepted by a tax authority or it is
 * nothing.
 *
 * The failure this file guards against is not a crash. It is an invoice the
 * business believes it has issued, rejected somewhere downstream, with the
 * money not arriving and nobody knowing why for a fortnight.
 */
const complete = (): EInvoiceInput => ({
  number: "INV-1042",
  issueDate: new Date("2026-09-09T10:00:00Z"),
  dueDate: new Date("2026-10-09T10:00:00Z"),
  currency: "EUR",
  seller: {
    name: "Foothills Digital",
    street: "1 High Street",
    city: "Denver",
    postcode: "80202",
    countryCode: "US",
    taxId: "US123456789",
  },
  buyer: {
    name: "Fairview SRL",
    city: "Milano",
    postcode: "20121",
    countryCode: "IT",
    taxId: "IT01234567890",
  },
  lines: [
    {
      description: "Kitchen fitting",
      quantityMilli: 2000,
      unit: "DAY",
      unitPriceCents: 50_000,
      netCents: 100_000,
      taxRateBp: 2200,
    },
    {
      description: "Materials",
      quantityMilli: 1000,
      unit: "EA",
      unitPriceCents: 20_000,
      netCents: 20_000,
      taxRateBp: 1000,
    },
  ],
  subtotalCents: 120_000,
  taxCents: 24_000,
  totalCents: 144_000,
  dueCents: 144_000,
});

test("a complete invoice produces EN 16931 UBL", () => {
  const xml = toUbl(complete());
  expect(xml).toContain("urn:cen.eu:en16931:2017");
  expect(xml).toContain("<cbc:ID>INV-1042</cbc:ID>");
  expect(xml).toContain("<cbc:IssueDate>2026-09-09</cbc:IssueDate>");
  // 380 is a commercial invoice. A credit note is 381 and is not this.
  expect(xml).toContain("<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>");
});

/**
 * The country codes are the mandatory fields nobody has, and the message has to
 * send somebody to the right screen.
 */
test("a missing country is named in words, not as a field code", () => {
  const input = complete();
  input.buyer.countryCode = null;
  const missing = missingForEInvoice(input);
  expect(missing.join(" ")).toContain("customer's country");
  // And it explains *why* it is absent, which is the part that saves a support
  // conversation: addresses live on companies here.
  expect(missing.join(" ")).toContain("company record");
});

/**
 * Refusing rather than emitting something invalid.
 *
 * A caller that ignored the missing list and generated anyway would produce the
 * exact failure this exists to prevent, so the door is shut rather than
 * signposted.
 */
test("it refuses to generate an invoice a tax authority would reject", () => {
  const input = complete();
  input.seller.countryCode = null;
  expect(() => toUbl(input)).toThrow(/cannot be sent/);
});

/**
 * Tax is grouped by rate, not listed per line.
 *
 * `TaxSubtotal` repeated for the same rate is a validation failure rather than
 * a stylistic choice, and an invoice with two rates on it is the normal case
 * this gets wrong.
 */
test("two tax rates produce two subtotals, once each", () => {
  const xml = toUbl(complete());
  const subtotals = xml.match(/<cac:TaxSubtotal>/g) ?? [];
  expect(subtotals).toHaveLength(2);
  expect(xml).toContain("<cbc:Percent>22.00</cbc:Percent>");
  expect(xml).toContain("<cbc:Percent>10.00</cbc:Percent>");
});

/** Zero-rated lines are category Z, not S at nought percent. */
test("a zero-rated line is categorised as zero-rated", () => {
  const input = complete();
  const first = input.lines[0];
  if (!first) throw new Error("the fixture has no lines");
  input.lines = [{ ...first, taxRateBp: 0 }];
  const xml = toUbl(input);
  expect(xml).toContain("<cbc:ID>Z</cbc:ID>");
});

/**
 * What is payable is not always the total.
 *
 * A part-paid invoice sent as an e-invoice with the full total in
 * `PayableAmount` asks the customer for money they have already handed over.
 */
test("the payable amount is what is owed, not what was billed", () => {
  const input = complete();
  input.dueCents = 44_000; // a deposit was taken
  const xml = toUbl(input);
  expect(xml).toContain(
    '<cbc:PayableAmount currencyID="EUR">440.00</cbc:PayableAmount>',
  );
  expect(xml).toContain(
    '<cbc:TaxInclusiveAmount currencyID="EUR">1440.00</cbc:TaxInclusiveAmount>',
  );
});

/** A customer's name with an ampersand in it must not break the document. */
test("names that contain XML are escaped", () => {
  const input = complete();
  input.buyer.name = 'Smith & Sons <"Builders">';
  const xml = toUbl(input);
  expect(xml).toContain("Smith &amp; Sons &lt;&quot;Builders&quot;&gt;");
  expect(xml).not.toContain('<"Builders">');
});

/** Cross-border in the EU needs the seller's VAT number to prove the supply. */
test("a cross-border invoice asks for the VAT number a domestic one does not", () => {
  const domestic = complete();
  domestic.buyer.countryCode = "US";
  domestic.seller.taxId = null;
  expect(missingForEInvoice(domestic)).toEqual([]);

  const abroad = complete();
  abroad.seller.taxId = null;
  expect(missingForEInvoice(abroad).join(" ")).toContain("VAT number");
});
