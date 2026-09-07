import { expect, test } from "bun:test";
import { type PortalInvoice, type PortalQuote, portalPage } from "./portal";

const now = new Date("2026-08-12T00:00:00Z");

const invoice = (over: Partial<PortalInvoice> = {}): PortalInvoice => ({
  id: "inv-1",
  number: "INV-1041",
  status: "open",
  currency: "USD",
  totalCents: 20000,
  paidCents: 0,
  dueDate: new Date("2026-08-20T00:00:00Z"),
  ...over,
});

test("the customer sees what they owe, not what has been billed", () => {
  // A part-paid invoice shows the balance. Showing the original amount is how
  // a customer pays twice.
  const html = portalPage({
    businessName: "Northfield Joinery",
    customerName: "Marguerite Oyelaran",
    invoices: [invoice({ totalCents: 20000, paidCents: 15000 })],
    now,
  });
  expect(html).toContain("$50.00");
  expect(html).toContain("$50.00 outstanding");
  expect(html).not.toContain("$200.00 outstanding");
});

test("overdue is shown as overdue", () => {
  const html = portalPage({
    businessName: "Northfield Joinery",
    customerName: "Marguerite",
    invoices: [invoice({ dueDate: new Date("2026-08-01T00:00:00Z") })],
    now,
  });
  expect(html).toContain("overdue");
});

test("a paid invoice is not counted as outstanding", () => {
  const html = portalPage({
    businessName: "Northfield Joinery",
    customerName: "Marguerite",
    invoices: [invoice({ status: "paid", paidCents: 20000 })],
    now,
  });
  expect(html).toContain("paid");
  expect(html).toContain("Nothing outstanding");
});

test("several invoices add up to one number", () => {
  const html = portalPage({
    businessName: "Northfield Joinery",
    customerName: "Marguerite",
    invoices: [
      invoice({ id: "a", number: "INV-1", totalCents: 12550 }),
      invoice({ id: "b", number: "INV-2", totalCents: 7500, paidCents: 2500 }),
      invoice({
        id: "c",
        number: "INV-3",
        status: "paid",
        paidCents: 30000,
        totalCents: 30000,
      }),
    ],
    now,
  });
  // 125.50 + 50.00, with the settled one excluded
  expect(html).toContain("$175.50 outstanding");
});

test("a customer with nothing owed is told so plainly", () => {
  const html = portalPage({
    businessName: "Northfield Joinery",
    customerName: "Marguerite",
    invoices: [],
    now,
  });
  expect(html).toContain("Nothing outstanding");
});

test("a business name cannot inject markup into its customer's page", () => {
  const html = portalPage({
    businessName: '<script>alert("xss")</script>',
    customerName: "<img src=x onerror=1>",
    invoices: [invoice({ number: "<b>INV</b>" })],
    now,
  });
  expect(html).not.toContain("<script>alert");
  expect(html).not.toContain("<img src=x");
  expect(html).not.toContain("<b>INV</b>");
  expect(html).toContain("&lt;script&gt;");
});

const quote = (over: Partial<PortalQuote> = {}): PortalQuote => ({
  id: "q-1",
  number: "QUO-2001",
  status: "sent",
  currency: "USD",
  totalCents: 45000,
  ...over,
});

test("a sent quote is offered for approval", () => {
  const html = portalPage({
    businessName: "Northfield Joinery",
    customerName: "Marguerite",
    invoices: [],
    quotes: [quote()],
    quotePath: "/portal/tok/quotes",
    now,
  });
  expect(html).toContain("QUO-2001");
  expect(html).toContain("$450.00");
  expect(html).toContain("/portal/tok/quotes/q-1/accept");
  expect(html).toContain("Accept");
});

test("a draft quote is the business thinking out loud, not the customer's business", () => {
  const html = portalPage({
    businessName: "Northfield Joinery",
    customerName: "Marguerite",
    invoices: [],
    quotes: [quote({ status: "draft", number: "QUO-DRAFT" })],
    quotePath: "/portal/tok/quotes",
    now,
  });
  expect(html).not.toContain("QUO-DRAFT");
});

test("an answered quote is not offered again", () => {
  const html = portalPage({
    businessName: "Northfield Joinery",
    customerName: "Marguerite",
    invoices: [],
    quotes: [
      quote({ status: "accepted", number: "QUO-DONE" }),
      quote({ status: "declined", number: "QUO-NO" }),
    ],
    quotePath: "/portal/tok/quotes",
    now,
  });
  expect(html).not.toContain("QUO-DONE");
  expect(html).not.toContain("QUO-NO");
  expect(html).not.toContain("Quotes for you to approve");
});

test("the page asks not to be indexed", () => {
  // The link is the credential; a search engine holding it is a leak.
  const html = portalPage({
    businessName: "Northfield Joinery",
    customerName: "Marguerite",
    invoices: [invoice()],
    now,
  });
  expect(html).toContain('name="robots" content="noindex"');
});

test("a customer with only a quote is not shown an empty invoice table", () => {
  // Headers over nothing, under a quote awaiting approval, reads as a page
  // that failed to load.
  const html = portalPage({
    businessName: "Northfield Joinery",
    customerName: "Marguerite",
    invoices: [],
    quotes: [quote()],
    quotePath: "/portal/tok/quotes",
    now,
  });
  expect(html).toContain("QUO-2001");
  expect(html).not.toContain("<th>Invoice</th>");
  expect(html).not.toContain("Nothing outstanding");
});

test("a customer with nothing at all is told so", () => {
  const html = portalPage({
    businessName: "Northfield Joinery",
    customerName: "Marguerite",
    invoices: [],
    quotes: [],
    now,
  });
  expect(html).toContain("Nothing outstanding");
});

/**
 * The seller's own details, on the document the customer keeps.
 *
 * A name alone is not an invoice. In the UK and across the EU the seller's
 * address is required and a VAT invoice must carry the registration number —
 * without them the customer files something that is not a valid document. And
 * a business paid by bank transfer whose invoices omit its account details
 * answers "where do I send this?" on every single one.
 */
const seller = {
  name: "Wierzbicki Tiling",
  address: "Unit 4, Tanners Yard\nLeeds LS9 8AB",
  taxId: "GB 412 7749 02",
  taxIdLabel: "VAT number",
  paymentInstructions:
    "Bank transfer to 20-45-11, account 8842 3901.\nPlease quote the invoice number.",
};

test("the customer's page carries the address, tax number and how to pay", () => {
  const html = portalPage({
    businessName: seller.name,
    business: seller,
    customerName: "Whitfield Restaurant",
    invoices: [],
  });

  expect(html).toContain("Unit 4, Tanners Yard");
  expect(html).toContain("Leeds LS9 8AB");
  // The business names its own tax number: it is not "VAT" everywhere.
  expect(html).toContain("VAT number: GB 412 7749 02");
  expect(html).toContain("How to pay");
  expect(html).toContain("20-45-11");
  // Newlines in a textarea must survive as line breaks, not run together.
  expect(html).toContain("Tanners Yard<br>Leeds LS9 8AB");
});

test("a business that has filled nothing in gets no empty footer", () => {
  const html = portalPage({
    businessName: "Nothing Filled In Ltd",
    business: { name: "Nothing Filled In Ltd" },
    customerName: "A Customer",
    invoices: [],
  });
  // The stylesheet always mentions the class; what must be absent is the
  // element itself, and an empty bordered block under the page.
  expect(html).not.toContain("<footer");
  expect(html).not.toContain("How to pay");
});

test("payment instructions alone are enough to show the footer", () => {
  // The common case for a sole trader who is not registered for tax.
  const html = portalPage({
    businessName: "Sole Trader",
    business: { name: "Sole Trader", paymentInstructions: "Cash or transfer" },
    customerName: "A Customer",
    invoices: [],
  });
  expect(html).toContain("How to pay");
  expect(html).toContain("Cash or transfer");
  expect(html).not.toContain("Tax number:");
});

test("the seller's details cannot inject markup", () => {
  const html = portalPage({
    businessName: "X",
    business: {
      name: "X",
      address: "<script>alert(1)</script>",
      paymentInstructions: "<img src=x onerror=alert(1)>",
    },
    customerName: "A Customer",
    invoices: [],
  });
  // Escaped, not stripped: the text still reads back, but no tag survives to
  // be parsed. "onerror=" appears inside the escaped text and is inert there,
  // so the assertion is about the angle brackets.
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
});
