import { expect, test } from "bun:test";
import {
  confirmEmailChangeEmail,
  invitationEmail,
  invoiceEmail,
  orderDespatchedEmail,
  orderPaidEmail,
  overdueReminderEmail,
  passwordResetEmail,
  portalLinkEmail,
  quoteEmail,
  receiptEmail,
  verifyEmailEmail,
  welcomeEmail,
} from "./templates";

/**
 * Every message this product sends, rendered and read.
 *
 * These are the only part of Sentrello that arrives in somebody else's
 * inbox, and nothing had ever looked at them together. Reading the set as
 * prose is what found the overdue chase carrying no way to pay — the one
 * message whose entire purpose is to be acted on, and the only money email
 * with nothing to press.
 *
 * The assertions are the things that are true of all of them rather than a
 * transcript of the words, because the words are somebody's to change:
 *
 *  - a subject that says what it is about;
 *  - no arithmetic leaking through as `NaN`, which is what a money field
 *    passed under the wrong name renders as, and which a customer would be
 *    the first to see;
 *  - no `undefined` or `[object Object]` where a value was meant;
 *  - and a link wherever the message exists to get somebody to act.
 */
const business = {
  name: "Riverside Joinery",
  address: "Rue Neuve 1",
  city: "Brussels",
  postcode: "1000",
  countryCode: "BE",
  email: "hello@riverside.test",
  phone: "+32 2 555 0100",
} as Parameters<typeof invoiceEmail>[0]["business"];

const PORTAL = "https://books.example.test/portal/tok";

const everything = {
  welcome: welcomeEmail("Ines"),
  invoice: invoiceEmail({
    number: "INV-0042",
    totalCents: 145000,
    currency: "EUR",
    dueDate: new Date("2026-10-10T00:00:00Z"),
    businessName: "Riverside Joinery",
    portalUrl: PORTAL,
    business,
  }),
  quote: quoteEmail({
    number: "QUO-0007",
    totalCents: 98000,
    currency: "EUR",
    businessName: "Riverside Joinery",
    portalUrl: PORTAL,
    business,
  }),
  receipt: receiptEmail({
    number: "INV-0042",
    amountCents: 145000,
    balanceCents: 0,
    currency: "EUR",
    businessName: "Riverside Joinery",
    portalUrl: PORTAL,
    accountUrl: "https://books.example.test/account/tok",
    business,
  }),
  orderPaid: orderPaidEmail({
    number: "SO-0011",
    totalCents: 4500,
    currency: "EUR",
    businessName: "Riverside Joinery",
    orderUrl: "https://books.example.test/shop/orders/tok",
    business,
  }),
  orderDespatched: orderDespatchedEmail({
    number: "SO-0011",
    businessName: "Riverside Joinery",
    carrier: "bpost",
    tracking: "BE123456789",
    orderUrl: "https://books.example.test/shop/orders/tok",
    business,
  }),
  portalLink: portalLinkEmail({
    businessName: "Riverside Joinery",
    url: PORTAL,
    outstandingCents: 145000,
    currency: "EUR",
    business,
  }),
  overdue: overdueReminderEmail({
    number: "INV-0042",
    balanceDueCents: 145000,
    currency: "EUR",
    portalUrl: PORTAL,
    business,
  }),
  verify: verifyEmailEmail({
    url: "https://books.example.test/verify/tok",
    businessName: "Riverside Joinery",
    business,
  }),
  changeEmail: confirmEmailChangeEmail({
    url: "https://books.example.test/confirm/tok",
    newEmail: "ines@kolding.test",
  }),
  invitation: invitationEmail({
    url: "https://books.example.test/invite/tok",
    organizationName: "Riverside Joinery",
    inviterName: "Ines",
    expiresAt: new Date("2026-10-03T00:00:00Z"),
  }),
  passwordReset: passwordResetEmail({
    url: "https://books.example.test/reset/tok",
    expiresInMinutes: 60,
  }),
};

test("every message says what it is about", () => {
  for (const [name, mail] of Object.entries(everything)) {
    expect(mail.subject.trim(), `${name} has no subject`).not.toBe("");
    expect(mail.subject, `${name}'s subject leaks a value`).not.toMatch(
      /NaN|undefined|\[object/,
    );
  }
});

/**
 * `NaN` is the one that would actually happen.
 *
 * A money field passed under the wrong name — `amountCents` where the
 * template wants `totalCents` — renders as "€NaN" and typechecks, because
 * the caller is often building the object from a row. The customer is the
 * first person to see it.
 */
test("no message leaks a value where a figure or a name belongs", () => {
  for (const [name, mail] of Object.entries(everything)) {
    expect(mail.html, `${name} rendered a broken value`).not.toMatch(
      /NaN|undefined|\[object Object\]/,
    );
  }
});

/**
 * A message that exists to be acted on carries the thing to press.
 *
 * The chase did not, for as long as it has existed. These are the ones
 * where a link is the point rather than a nicety.
 */
test("the messages that want an answer carry a link", () => {
  const acted = [
    "invoice",
    "quote",
    "receipt",
    "orderPaid",
    "orderDespatched",
    "portalLink",
    "overdue",
    "verify",
    "changeEmail",
    "invitation",
    "passwordReset",
  ] as const;
  for (const name of acted) {
    expect(
      everything[name].html,
      `${name} asks for something and gives nobody a way to do it`,
    ).toMatch(/<a href="https:\/\//);
  }
});

/**
 * And a link that anybody holding it can open says so.
 *
 * The portal and the account page are reached by an unguessable address
 * rather than a password. That is a deliberate trade — a customer with no
 * account can still pay — and it is only honest if the message says the
 * link is private.
 */
test("a link that is its own password warns the reader", () => {
  for (const name of ["invoice", "overdue", "portalLink"] as const) {
    expect(
      everything[name].html,
      `${name} sends a private link without saying it is one`,
    ).toMatch(/private to you/);
  }
});
