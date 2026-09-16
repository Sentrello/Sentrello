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

/**
 * BR-S-02 and kin: an invoice that deals in VAT — charging it, zeroing it,
 * exempting it or reversing it — must identify the seller to the tax
 * authority. Domestic used to be excused; the official validator rejects
 * that document, so the excuse is gone.
 */
test("an invoice that deals in VAT asks for the seller's VAT number", () => {
  const domestic = complete();
  domestic.buyer.countryCode = "US";
  domestic.seller.taxId = null;
  expect(missingForEInvoice(domestic).join(" ")).toContain("VAT number");

  const abroad = complete();
  abroad.seller.taxId = null;
  expect(missingForEInvoice(abroad).join(" ")).toContain("VAT number");
});

/**
 * The category on the document is the category on the definition.
 *
 * Exempt (E) and reverse-charge (AE) supplies are zero tax, but they are not
 * zero-rated (Z) — the categories carry different legal meanings and EN 16931
 * validators reject a mislabelled one. And both must state why: BR-E-10 and
 * BR-AE-10 demand an exemption reason in the VAT breakdown.
 */
test("an exempt line is category E with its reason stated, not Z", () => {
  const input = complete();
  const first = input.lines[0];
  if (!first) throw new Error("the fixture has no lines");
  input.lines = [
    { ...first, taxRateBp: 0, taxes: [{ rateBp: 0, categoryCode: "E" }] },
  ];
  input.taxCents = 0;
  input.totalCents = input.subtotalCents;
  input.dueCents = input.subtotalCents;
  const xml = toUbl(input);
  expect(xml).toContain("<cbc:ID>E</cbc:ID>");
  expect(xml).not.toContain("<cbc:ID>Z</cbc:ID>");
  expect(xml).toContain("<cbc:TaxExemptionReason>");
});

test("a reverse-charge line is category AE with its reason stated", () => {
  const input = complete();
  const first = input.lines[0];
  if (!first) throw new Error("the fixture has no lines");
  input.lines = [
    { ...first, taxRateBp: 0, taxes: [{ rateBp: 0, categoryCode: "AE" }] },
  ];
  input.taxCents = 0;
  input.totalCents = input.subtotalCents;
  input.dueCents = input.subtotalCents;
  const xml = toUbl(input);
  expect(xml).toContain("<cbc:ID>AE</cbc:ID>");
  expect(xml).toContain(
    "<cbc:TaxExemptionReason>Reverse charge</cbc:TaxExemptionReason>",
  );
});

/**
 * UBL-SR-48: the norm allows one and only one tax category on a line. Two
 * taxes on one line is a Canadian document — GST beside PST — and no
 * arrangement of the XML expresses it; the official validator rejects the
 * second category outright. So it is refused, with the reason in words.
 */
test("a line carrying two taxes is refused, not emitted invalid", () => {
  const input = complete();
  input.lines = [
    {
      description: "Install",
      quantityMilli: 1000,
      unit: "EA",
      unitPriceCents: 100_000,
      netCents: 100_000,
      taxRateBp: 500,
      taxes: [
        { rateBp: 500, categoryCode: "S" },
        { rateBp: 700, categoryCode: "S" },
      ],
    },
  ];
  input.subtotalCents = 100_000;
  input.taxCents = 12_000;
  input.totalCents = 112_000;
  input.dueCents = 112_000;

  expect(missingForEInvoice(input).join(" ")).toContain("one tax per line");
  expect(() => toUbl(input)).toThrow(/one tax per line/);
});

/**
 * The breakdown states what the document froze, not a recomputation.
 *
 * The bands were written when the document was issued, after the discount was
 * apportioned. Recomputing from undiscounted line nets makes the subtotals
 * disagree with the totals block — which is BR-CO-14 failing, and a rejected
 * invoice.
 */
test("stored tax bands govern the breakdown when they are supplied", () => {
  const input = complete();
  input.bands = [
    { rateBp: 2200, categoryCode: "S", taxableCents: 95_000, taxCents: 20_900 },
    { rateBp: 1000, categoryCode: "S", taxableCents: 19_000, taxCents: 1_900 },
  ];
  input.taxCents = 22_800;
  const xml = toUbl(input);
  expect(xml).toContain(
    '<cbc:TaxableAmount currencyID="EUR">950.00</cbc:TaxableAmount>',
  );
  expect(xml).toContain(
    '<cbc:TaxAmount currencyID="EUR">209.00</cbc:TaxAmount>',
  );
  expect(xml).toContain(
    '<cbc:TaxAmount currencyID="EUR">228.00</cbc:TaxAmount>',
  );
});

/**
 * Rates finer than a basis point reach the XML exactly.
 *
 * Quebec's QST is 9.975% — the reason tax rates are stored in millionths at
 * all. EN 16931 states a percentage as a decimal, so the Percent element must
 * say 9.975, not the 9.98 the old unit forced.
 */
test("a rate finer than a basis point is serialised exactly", () => {
  const input = complete();
  input.lines = [
    {
      description: "Consulting",
      quantityMilli: 1000,
      unit: "EA",
      unitPriceCents: 8_765,
      netCents: 8_765,
      taxRatePpm: 99_750,
    },
  ];
  // 87.65 × 9.975% = 8.7430875 → 8.74, rounded on the line.
  input.subtotalCents = 8_765;
  input.taxCents = 874;
  input.totalCents = 9_639;
  input.dueCents = 9_639;
  const xml = toUbl(input);
  expect(xml).toContain("<cbc:Percent>9.975</cbc:Percent>");
  expect(xml).toContain('<cbc:TaxAmount currencyID="EUR">8.74</cbc:TaxAmount>');
  // And a coarse rate still reads the way it always has.
  expect(toUbl(complete())).toContain("<cbc:Percent>22.00</cbc:Percent>");
});

/**
 * A German invoice with everything the stricter profiles need: electronic
 * addresses derivable from the VAT numbers, a buyer reference, bank details
 * and a contact point. The base for every transport-profile test.
 */
const german = (): EInvoiceInput => ({
  number: "INV-2001",
  issueDate: new Date("2026-09-14T10:00:00Z"),
  dueDate: new Date("2026-10-14T10:00:00Z"),
  currency: "EUR",
  seller: {
    name: "Foothills Digital GmbH",
    street: "Musterstrasse 1",
    city: "Berlin",
    postcode: "10115",
    countryCode: "DE",
    taxId: "DE123456789",
    contactName: "Foothills Digital GmbH",
    contactPhone: "+49 30 123456",
    contactEmail: "rechnung@foothills.example",
  },
  buyer: {
    name: "Fairview GmbH",
    street: "Beispielweg 2",
    city: "Muenchen",
    postcode: "80331",
    countryCode: "DE",
    taxId: "DE987654321",
  },
  buyerReference: "04011000-1234512345-06",
  payment: {
    iban: "DE89 3704 0044 0532 0130 00",
    accountName: "Foothills Digital GmbH",
  },
  lines: [
    {
      description: "Kitchen fitting",
      quantityMilli: 2000,
      unit: "DAY",
      unitPriceCents: 50_000,
      netCents: 100_000,
      taxRatePpm: 190_000,
      taxes: [{ ratePpm: 190_000, categoryCode: "S" }],
    },
    {
      description: "Materials",
      quantityMilli: 1000,
      unit: "EA",
      unitPriceCents: 20_000,
      netCents: 20_000,
      taxRatePpm: 70_000,
      taxes: [{ ratePpm: 70_000, categoryCode: "S" }],
    },
  ],
  subtotalCents: 120_000,
  taxCents: 20_400,
  totalCents: 140_400,
  dueCents: 140_400,
});

/**
 * Peppol BIS Billing 3.0 — what the network's own validation adds over the
 * bare norm. Every assertion here mirrors a published rule that the Peppol
 * schematron enforces and a bare EN 16931 document fails.
 */
test("the peppol profile carries the BIS 3.0 identifiers", () => {
  const input = { ...german(), profile: "peppol" as const };
  const xml = toUbl(input);
  // PEPPOL-EN16931-R004: the specification identifier must be the BIS one.
  expect(xml).toContain(
    "<cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>",
  );
  // PEPPOL-EN16931-R001/R007: the business process must be stated.
  expect(xml).toContain(
    "<cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>",
  );
  // PEPPOL-EN16931-R003: a buyer reference must be provided.
  expect(xml).toContain(
    "<cbc:BuyerReference>04011000-1234512345-06</cbc:BuyerReference>",
  );
});

test("the peppol profile derives both electronic addresses from the VAT numbers", () => {
  const xml = toUbl({ ...german(), profile: "peppol" as const });
  // PEPPOL-EN16931-R020/R010, scheme 9930 = German VAT number in the EAS list.
  expect(xml).toContain(
    '<cbc:EndpointID schemeID="9930">DE123456789</cbc:EndpointID>',
  );
  expect(xml).toContain(
    '<cbc:EndpointID schemeID="9930">DE987654321</cbc:EndpointID>',
  );
});

test("an explicit electronic address wins over the derived one", () => {
  const input = german();
  input.buyer.endpointId = "5798000000000";
  input.buyer.endpointScheme = "0088"; // a GLN
  const xml = toUbl({ ...input, profile: "peppol" as const });
  expect(xml).toContain(
    '<cbc:EndpointID schemeID="0088">5798000000000</cbc:EndpointID>',
  );
});

test("peppol refuses without a buyer reference, in words", () => {
  const input = {
    ...german(),
    profile: "peppol" as const,
    buyerReference: null,
  };
  const missing = missingForEInvoice(input);
  expect(missing.join(" ")).toContain("reference");
  expect(() => toUbl(input)).toThrow(/reference/);
});

test("peppol refuses when the customer has no electronic address to derive", () => {
  const input = { ...german(), profile: "peppol" as const };
  input.buyer.taxId = null;
  const missing = missingForEInvoice(input);
  expect(missing.join(" ")).toContain("customer");
  expect(missing.join(" ")).toContain("electronic address");
});

/**
 * XRechnung — the German CIUS. Its BR-DE rules make payment instructions, a
 * seller contact point, both postal addresses and the buyer reference
 * mandatory, none of which bare EN 16931 requires.
 */
test("the xrechnung profile carries the German identifiers and payment means", () => {
  const xml = toUbl({ ...german(), profile: "xrechnung" as const });
  // BR-DE-21: the specification identifier must be the XRechnung one.
  expect(xml).toContain(
    "<cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</cbc:CustomizationID>",
  );
  // BR-DE-1: payment instructions; 58 is a SEPA credit transfer, to an IBAN.
  expect(xml).toContain("<cbc:PaymentMeansCode>58</cbc:PaymentMeansCode>");
  expect(xml).toContain("<cbc:ID>DE89370400440532013000</cbc:ID>");
  // BR-DE-5/6/7: the seller's contact point, phone and email.
  expect(xml).toContain("<cbc:Name>Foothills Digital GmbH</cbc:Name>");
  expect(xml).toContain("<cbc:Telephone>+49 30 123456</cbc:Telephone>");
  expect(xml).toContain(
    "<cbc:ElectronicMail>rechnung@foothills.example</cbc:ElectronicMail>",
  );
});

test("xrechnung refuses without bank details, naming them", () => {
  const input = { ...german(), profile: "xrechnung" as const, payment: null };
  expect(missingForEInvoice(input).join(" ")).toContain("IBAN");
});

test("xrechnung refuses without a contact point, naming the pieces", () => {
  const input = { ...german(), profile: "xrechnung" as const };
  input.seller.contactPhone = null;
  input.seller.contactEmail = null;
  const words = missingForEInvoice(input).join(" ");
  expect(words).toContain("phone");
  expect(words).toContain("email");
});

test("xrechnung names the Leitweg-ID when the buyer reference is absent", () => {
  const input = {
    ...german(),
    profile: "xrechnung" as const,
    buyerReference: null,
  };
  expect(missingForEInvoice(input).join(" ")).toContain("Leitweg-ID");
});

/**
 * BR-CO-16: what is payable = total − what was already paid. A part-paid
 * invoice must say the prepayment out loud, or the arithmetic the validator
 * re-runs does not close and the document is rejected.
 */
test("a part-paid invoice states the prepaid amount", () => {
  const input = german();
  input.dueCents = 40_400; // 1000.00 paid on account
  const xml = toUbl(input);
  expect(xml).toContain(
    '<cbc:PrepaidAmount currencyID="EUR">1000.00</cbc:PrepaidAmount>',
  );
  expect(xml).toContain(
    '<cbc:PayableAmount currencyID="EUR">404.00</cbc:PayableAmount>',
  );
});

/**
 * BR-CO-13 and BR-S-08: a document-level discount must appear as an
 * allowance, per VAT band, and the tax-exclusive total is after it. The
 * frozen bands carry the discounted taxable amounts; the allowance is the
 * difference between what the lines say and what the bands say.
 */
test("a discounted invoice states the allowance per tax band and totals after it", () => {
  const input = german();
  input.discountCents = 6_000; // 5% off the whole document
  input.bands = [
    {
      ratePpm: 190_000,
      categoryCode: "S",
      taxableCents: 95_000,
      taxCents: 18_050,
    },
    {
      ratePpm: 70_000,
      categoryCode: "S",
      taxableCents: 19_000,
      taxCents: 1_330,
    },
  ];
  input.taxCents = 19_380;
  input.totalCents = 133_380;
  input.dueCents = 133_380;
  const xml = toUbl(input);
  // One allowance per band, category and rate stated, amounts summing to 60.00.
  expect(xml).toContain("<cbc:ChargeIndicator>false</cbc:ChargeIndicator>");
  expect(xml).toContain('<cbc:Amount currencyID="EUR">50.00</cbc:Amount>');
  expect(xml).toContain('<cbc:Amount currencyID="EUR">10.00</cbc:Amount>');
  expect(xml).toContain(
    '<cbc:AllowanceTotalAmount currencyID="EUR">60.00</cbc:AllowanceTotalAmount>',
  );
  // BT-109 is after the discount; BT-106 is still the sum of the lines.
  expect(xml).toContain(
    '<cbc:TaxExclusiveAmount currencyID="EUR">1140.00</cbc:TaxExclusiveAmount>',
  );
  expect(xml).toContain(
    '<cbc:LineExtensionAmount currencyID="EUR">1200.00</cbc:LineExtensionAmount>',
  );
});

/** A credit note is a different document type on the network, not a flag. */
test("a credit note is refused rather than mislabelled as an invoice", () => {
  const input = { ...german(), kind: "credit_note" };
  const missing = missingForEInvoice(input);
  expect(missing.join(" ")).toContain("credit note");
  expect(() => toUbl(input)).toThrow(/credit note/);
});

/** BR-CO-25: money owed needs a due date or payment terms next to it. */
test("an unpaid invoice with no due date and no terms is refused", () => {
  const input = german();
  input.dueDate = null;
  input.paymentTerms = null;
  expect(missingForEInvoice(input).join(" ")).toContain("due date");
  // Payment terms alone satisfy it.
  input.paymentTerms = "Zahlbar innerhalb von 30 Tagen";
  expect(missingForEInvoice(input)).toEqual([]);
});

/**
 * BR-S-02 and kin: an invoice that charges VAT must identify the seller to
 * the tax authority, domestic or not. The old behaviour asked only when the
 * countries differed, and the official validator rejects that document.
 */
test("a taxed invoice without the seller's VAT number is refused even domestically", () => {
  const input = german();
  input.seller.taxId = null;
  expect(missingForEInvoice(input).join(" ")).toContain("VAT");
});

/** Category O is out of scope entirely: no rate, and no sharing a document. */
test("an out-of-scope invoice carries no rate, and refuses mixed company", () => {
  const input = german();
  input.seller.taxId = null; // out of scope of VAT — no VAT number to demand
  input.lines = [
    {
      description: "Out of scope",
      quantityMilli: 1000,
      unit: "EA",
      unitPriceCents: 10_000,
      netCents: 10_000,
      taxes: [{ ratePpm: 0, categoryCode: "O" }],
    },
  ];
  input.subtotalCents = 10_000;
  input.taxCents = 0;
  input.totalCents = 10_000;
  input.dueCents = 10_000;
  const xml = toUbl(input);
  // BR-O-05..07: a rate must not be stated for O.
  expect(xml).not.toContain("<cbc:Percent>");
  expect(xml).toContain("<cbc:TaxExemptionReason>");

  // BR-O-11..14: O does not share an invoice with taxed lines.
  const mixed = german();
  const first = mixed.lines[0];
  if (!first) throw new Error("the fixture has no lines");
  first.taxes = [{ ratePpm: 0, categoryCode: "O" }];
  expect(missingForEInvoice(mixed).join(" ")).toContain("out of scope");
});

/** Units reach the wire as UN/ECE codes, not as whatever was typed. */
test("units are normalised to codes the network accepts", () => {
  const input = german();
  const [labour, parts] = input.lines;
  if (!labour || !parts) throw new Error("the fixture has too few lines");
  labour.unit = "hours";
  parts.unit = "sprockets";
  const xml = toUbl(input);
  expect(xml).toContain('unitCode="HUR"');
  // An unknown unit degrades to the generic "unit" code rather than a
  // rejected document; the description still says what the thing is.
  expect(xml).toContain('unitCode="C62"');
});

/**
 * The four realistic shapes the EU work has to cover, end to end: they must
 * all generate under the peppol profile, with the breakdown carrying the
 * right categories. These are the fixtures the live-validator run uses.
 */
test("a cross-border reverse-charge invoice generates under peppol, category AE", () => {
  const input = { ...german(), profile: "peppol" as const };
  input.buyer = {
    name: "Fairview SARL",
    street: "2 Rue Exemple",
    city: "Paris",
    postcode: "75001",
    countryCode: "FR",
    taxId: "FR32123456789",
  };
  for (const line of input.lines) {
    line.taxes = [{ ratePpm: 0, categoryCode: "AE" }];
    line.taxRatePpm = 0;
  }
  input.taxCents = 0;
  input.totalCents = 120_000;
  input.dueCents = 120_000;
  const xml = toUbl(input);
  expect(xml).toContain("<cbc:ID>AE</cbc:ID>");
  expect(xml).toContain(
    '<cbc:EndpointID schemeID="9957">FR32123456789</cbc:EndpointID>',
  );
  expect(xml).toContain(
    "<cbc:TaxExemptionReason>Reverse charge</cbc:TaxExemptionReason>",
  );
});

test("reverse charge without the customer's VAT number is refused", () => {
  const input = german();
  for (const line of input.lines)
    line.taxes = [{ ratePpm: 0, categoryCode: "AE" }];
  input.buyer.taxId = null;
  input.taxCents = 0;
  input.totalCents = 120_000;
  input.dueCents = 120_000;
  expect(missingForEInvoice(input).join(" ")).toContain("customer's VAT");
});

test("an exempt invoice generates under peppol with its reason", () => {
  const input = { ...german(), profile: "peppol" as const };
  for (const line of input.lines) {
    line.taxes = [{ ratePpm: 0, categoryCode: "E" }];
  }
  input.bands = [
    {
      ratePpm: 0,
      categoryCode: "E",
      taxableCents: 120_000,
      taxCents: 0,
      exemptionReason: "Exempt under §4 UStG",
    },
  ];
  input.taxCents = 0;
  input.totalCents = 120_000;
  input.dueCents = 120_000;
  const xml = toUbl(input);
  expect(xml).toContain("<cbc:ID>E</cbc:ID>");
  expect(xml).toContain(
    "<cbc:TaxExemptionReason>Exempt under §4 UStG</cbc:TaxExemptionReason>",
  );
});

test("a zero-rated line and a standard line share a document under peppol", () => {
  const input = { ...german(), profile: "peppol" as const };
  const second = input.lines[1];
  if (!second) throw new Error("the fixture has too few lines");
  second.taxes = [{ ratePpm: 0, categoryCode: "Z" }];
  second.taxRatePpm = 0;
  input.taxCents = 19_000;
  input.totalCents = 139_000;
  input.dueCents = 139_000;
  const xml = toUbl(input);
  expect(xml).toContain("<cbc:ID>Z</cbc:ID>");
  expect(xml).toContain("<cbc:ID>S</cbc:ID>");
});
