import { expect, test } from "bun:test";
import {
  invoiceEmail,
  orderDespatchedEmail,
  orderPaidEmail,
  overdueReminderEmail,
} from "./templates";

/**
 * An invoice email is often the only copy a customer files, so it carries the
 * same identity as the portal page: the seller's address, because an invoice
 * without one is not a valid document in the UK or the EU, and how to pay,
 * because a business paid by transfer otherwise fields "where do I send this?"
 * on every invoice it raises.
 */
const seller = {
  name: "Wierzbicki Tiling",
  address: "Unit 4, Tanners Yard\nLeeds LS9 8AB",
  taxId: "GB 412 7749 02",
  taxIdLabel: "VAT number",
  paymentInstructions: "Bank transfer to 20-45-11, account 8842 3901.",
};

test("an invoice email carries the seller's details and how to pay", () => {
  const mail = invoiceEmail({
    number: "INV-0001",
    totalCents: 222000,
    currency: "GBP",
    businessName: seller.name,
    business: seller,
  });
  expect(mail.html).toContain("Unit 4, Tanners Yard<br>Leeds LS9 8AB");
  expect(mail.html).toContain("VAT number: GB 412 7749 02");
  expect(mail.html).toContain("How to pay");
  expect(mail.html).toContain("20-45-11");
});

test("the overdue chase carries them too, since it gets forwarded", () => {
  const mail = overdueReminderEmail({
    number: "INV-0001",
    balanceDueCents: 222000,
    currency: "GBP",
    business: seller,
  });
  expect(mail.html).toContain("Leeds LS9 8AB");
  expect(mail.html).toContain("20-45-11");
});

test("a business with nothing filled in gets no empty block", () => {
  const mail = invoiceEmail({
    number: "INV-0002",
    totalCents: 1000,
    currency: "GBP",
    business: { name: "Nothing Filled In" },
  });
  expect(mail.html).not.toContain("How to pay");
  expect(mail.html).not.toContain("<hr");
});

test("the seller's details cannot inject markup into an email", () => {
  const mail = invoiceEmail({
    number: "INV-0003",
    totalCents: 1000,
    currency: "GBP",
    business: { name: "X", address: "<script>alert(1)</script>" },
  });
  expect(mail.html).not.toContain("<script>");
  expect(mail.html).toContain("&lt;script&gt;");
});

/**
 * "Sent by Sentrello" on a business's own invoice is the product's name where
 * the customer expects the seller's. Free carries it; Pro is paid for.
 */
test("a Free instance credits the product", () => {
  const mail = invoiceEmail({
    number: "INV-0001",
    totalCents: 1000,
    currency: "GBP",
    business: seller,
    sentrelloCredit: true,
  });
  expect(mail.html).toContain("Sent by Sentrello");
});

test("Pro sends under the business's own name", () => {
  const mail = invoiceEmail({
    number: "INV-0001",
    totalCents: 1000,
    currency: "GBP",
    business: seller,
    sentrelloCredit: false,
  });
  expect(mail.html).not.toContain("Sentrello");
  // The seller is still named — white-labelled, not anonymous.
  expect(mail.html).toContain("Wierzbicki Tiling");
});

test("a sender that forgets to ask credits the product", () => {
  // Defaulting the other way would silently white-label every Free instance.
  const mail = invoiceEmail({
    number: "INV-1",
    totalCents: 1,
    currency: "GBP",
  });
  expect(mail.html).toContain("Sent by Sentrello");
});

/**
 * The two a shop buyer gets. They go to somebody who may have no account here
 * at all, so the link in them is the credential — which is exactly why the
 * escaping matters as much as it does on the invoice above.
 */
test("a paid order tells the buyer what was taken and what happens next", () => {
  const mail = orderPaidEmail({
    number: "SO-1042",
    totalCents: 4550,
    currency: "GBP",
    businessName: "Wierzbicki Tiling",
    orderUrl: "https://shop.example/orders/abc123",
  });
  expect(mail.subject).toContain("SO-1042");
  expect(mail.html).toContain("£45.50");
  expect(mail.html).toContain("https://shop.example/orders/abc123");
  // The promise that a second email follows, so nobody waits wondering.
  expect(mail.html).toContain("on its way");
});

test("a despatch without a tracking number still goes", () => {
  // Plenty of small businesses post things without one, and an email that
  // insists on a reference it does not have is an email that never goes.
  const mail = orderDespatchedEmail({ number: "SO-1042" });
  expect(mail.subject).toContain("on its way");
  expect(mail.html).not.toContain("Tracking reference");
});

test("a despatch with one names the carrier and the reference", () => {
  const mail = orderDespatchedEmail({
    number: "SO-1042",
    carrier: "Royal Mail",
    tracking: "AB123456789GB",
  });
  expect(mail.html).toContain("Royal Mail");
  expect(mail.html).toContain("AB123456789GB");
});

test("a buyer's order link cannot inject markup", () => {
  const mail = orderPaidEmail({
    number: "SO-1",
    totalCents: 100,
    currency: "GBP",
    orderUrl: 'https://x/"><script>alert(1)</script>',
  });
  expect(mail.html).not.toContain("<script>");
});
