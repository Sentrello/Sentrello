import { moneyLocale } from "@sentrello/module-sdk/money-locale";

/**
 * Plain template functions rather than React Email — three transactional mails
 * do not need a renderer dependency. Swap the bodies for React Email components
 * if the template set grows.
 */

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[ch] ?? ch,
  );

/** Cents -> "$1,234.56". Money is never formatted with floats upstream. */
/**
 * A date a person reads, not one a machine writes.
 *
 * The invoice email said `Due 2026-10-25` while the invoice document it links
 * to said `due 25 Oct 2026` — the same date, in the same envelope, twice, and
 * the machine-written one is the copy that lands in the inbox.
 *
 * The month as a word on purpose. This product sells into the US, Canada, the
 * UK and the EU, and `10/25` and `25/10` are the same four characters meaning
 * two different days to those readers; `25 Oct 2026` is one day to all of
 * them. The locale only picks the order, and either order is unambiguous once
 * the month is spelled.
 */
function day(value: Date): string {
  return value.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * A figure written the way the business that sent it writes figures.
 *
 * The seller's convention, not the reader's — the same as the invoice this
 * message links to. `en-US` for everybody wrote a European number the
 * American way and showed a Canadian business's own customers `CA$`.
 */
export function formatMoney(
  cents: number,
  currency = "USD",
  locale = "en-US",
): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(
    cents / 100,
  );
}

/**
 * Who the business is, as it must appear on a document a customer keeps.
 *
 * An invoice email is often the only copy a customer files, so it carries the
 * same identity as the portal page: the seller's address, because an invoice
 * without one is not a valid document in the UK or the EU, and how to pay,
 * because a business paid by transfer otherwise fields "where do I send this?"
 * on every invoice it raises.
 */
/*
 * How the seller writes numbers, from the country on their settings screen.
 *
 * This was a deliberate copy of `db/portal.ts` — ten lines, documented, on
 * the grounds that this package depends on `nodemailer` and nothing else and
 * that a database dependency would be the larger mistake. The note said a
 * third copy was the signal to find a home both could reach. A third turned
 * up in the web app the same week, and then all three were wrong in the same
 * way, which is what a copy is for.
 *
 * The SDK's `money-locale` is a leaf file importing nothing, reached by its
 * own subpath export, so this costs the package nothing at runtime.
 */
const sellerLocale = (business?: BusinessIdentity) =>
  moneyLocale(business?.countryCode);

export interface BusinessIdentity {
  name: string;
  /** ISO 3166-1 alpha-2, and the whole of how this business writes a number. */
  countryCode?: string | null;
  address?: string | null;
  taxId?: string | null;
  taxIdLabel?: string | null;
  paymentInstructions?: string | null;
}

const lines = (value: string) =>
  value
    .split("\n")
    .map((l) => escapeHtml(l.trim()))
    .filter(Boolean)
    .join("<br>");

function sellerFooter(b?: BusinessIdentity): string {
  if (!b) return "";
  const parts: string[] = [];
  if (b.address) parts.push(lines(b.address));
  if (b.taxId) {
    parts.push(
      `${escapeHtml(b.taxIdLabel?.trim() || "Tax number")}: ${escapeHtml(b.taxId)}`,
    );
  }
  const pay = b.paymentInstructions
    ? `<p style="color:#666;font-size:12px;margin:12px 0 0"><strong>How to pay</strong><br>${lines(b.paymentInstructions)}</p>`
    : "";
  if (parts.length === 0 && !pay) return "";

  return `<hr style="border:0;border-top:1px solid #e4e4e7;margin:24px 0 12px">
<p style="color:#666;font-size:12px;margin:0"><strong>${escapeHtml(b.name)}</strong>${
    parts.length ? `<br>${parts.join("<br>")}` : ""
  }</p>${pay}`;
}

/**
 * "Sent by Sentrello" on a business's own invoice is the product's name where
 * the customer expects the seller's. Free instances carry it; Pro is paid for,
 * and a paying business sends documents that look like theirs.
 *
 * Defaults to showing it, so a sender that forgets to ask credits the product
 * rather than silently white-labelling a Free instance.
 */
function layout(
  title: string,
  body: string,
  business?: BusinessIdentity,
  sentrelloCredit = true,
): string {
  /*
   * A head, a width and a background — the three things an email needs that
   * a web page gets for free.
   *
   * **The background is the important one.** The body set `color:#111` and no
   * background at all, and a mail client in dark mode darkens what it is
   * given: dark text on a background the client just made dark is an invoice
   * reminder somebody cannot read. Declaring both keeps the pair together,
   * and `color-scheme: light` tells the clients that honour it not to try.
   *
   * The viewport is the reason an email opened on a phone arrives zoomed out
   * with everything half size; the charset is belt and braces, since both
   * adapters already set it on the transport, and it costs nine bytes to be
   * right when a third one is added.
   *
   * A width, because a line of text the full span of a desktop mail window
   * is not a line anybody reads to the end.
   */
  return `<!doctype html><html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
</head><body style="margin:0;padding:24px;font-family:system-ui,sans-serif;line-height:1.5;color:#111;background:#ffffff">
<div style="max-width:37.5rem">
<h1 style="font-size:18px">${escapeHtml(title)}</h1>
${body}
${sellerFooter(business)}
${sentrelloCredit ? '<p style="color:#666;font-size:12px">Sent by Sentrello</p>' : ""}
</div>
</body></html>`;
}

export function welcomeEmail(name: string) {
  return {
    subject: "Welcome to Sentrello",
    html: layout(
      `Welcome, ${name}`,
      "<p>Your Sentrello instance is ready to use.</p>",
    ),
  };
}

export function invoiceEmail(args: {
  number: string;
  totalCents: number;
  currency: string;
  dueDate?: Date | null;
  businessName?: string;
  /** the customer's own page, where they can see and settle this */
  portalUrl?: string;
  /** The seller, for the foot of the document. */
  business?: BusinessIdentity;
  /** False on Pro, where the business sends under its own name. */
  sentrelloCredit?: boolean;
}) {
  const due = args.dueDate
    ? `<p>Due ${escapeHtml(day(args.dueDate))}.</p>`
    : "";
  // The link is the point of the email: an invoice a customer has to reply to
  // in order to pay is an invoice that waits.
  const link = args.portalUrl
    ? `<p><a href="${escapeHtml(args.portalUrl)}">View and pay this invoice</a></p>
<p style="color:#666;font-size:12px">This link is private to you — treat it
like a bill in the post.</p>`
    : "";
  return {
    subject: args.businessName
      ? `Invoice ${args.number} from ${args.businessName}`
      : `Invoice ${args.number}`,
    html: layout(
      `Invoice ${args.number}`,
      `<p>Amount due: <strong>${formatMoney(args.totalCents, args.currency, sellerLocale(args.business))}</strong></p>${due}${link}`,
      args.business,
      args.sentrelloCredit,
    ),
  };
}

export function quoteEmail(args: {
  number: string;
  totalCents: number;
  currency: string;
  businessName?: string;
  portalUrl?: string;
  /** The seller, for the foot of the document. */
  business?: BusinessIdentity;
  /** False on Pro, where the business sends under its own name. */
  sentrelloCredit?: boolean;
}) {
  const link = args.portalUrl
    ? `<p><a href="${escapeHtml(args.portalUrl)}">Read and accept this quote</a></p>
<p style="color:#666;font-size:12px">Accepting turns it into an invoice.
Nothing is charged until you pay it.</p>`
    : "";
  return {
    subject: args.businessName
      ? `Quote ${args.number} from ${args.businessName}`
      : `Quote ${args.number}`,
    html: layout(
      `Quote ${args.number}`,
      `<p>Total: <strong>${formatMoney(args.totalCents, args.currency, sellerLocale(args.business))}</strong></p>${link}`,
      args.business,
      args.sentrelloCredit,
    ),
  };
}

export function receiptEmail(args: {
  number: string;
  amountCents: number;
  currency: string;
  balanceCents: number;
  businessName?: string;
  portalUrl?: string;
  /**
   * The customer's hub across every module, not only invoicing. Offered here
   * rather than on the invoice or quote email: those already carry the one
   * link that matters — pay this, accept this — and a second link beside it
   * competes with it. A receipt asks nothing further, so there is room.
   */
  accountUrl?: string;
  /** The seller, for the foot of the document. */
  business?: BusinessIdentity;
  /** False on Pro, where the business sends under its own name. */
  sentrelloCredit?: boolean;
}) {
  // A part payment leaves a balance, and saying so here saves the customer
  // wondering whether the rest was forgotten.
  const remaining =
    args.balanceCents > 0
      ? `<p>Still outstanding on this invoice:
<strong>${formatMoney(args.balanceCents, args.currency, sellerLocale(args.business))}</strong></p>`
      : "<p>This invoice is now settled in full. Thank you.</p>";
  const link = args.portalUrl
    ? `<p><a href="${escapeHtml(args.portalUrl)}">See your invoices</a></p>`
    : "";
  const accountLink = args.accountUrl
    ? `<p><a href="${escapeHtml(args.accountUrl)}">See everything you have with us</a></p>`
    : "";
  return {
    subject: `Receipt for invoice ${args.number}`,
    html: layout(
      "Payment received",
      `<p>We received <strong>${formatMoney(args.amountCents, args.currency, sellerLocale(args.business))}</strong>
towards invoice ${escapeHtml(args.number)}${
        args.businessName ? ` from ${escapeHtml(args.businessName)}` : ""
      }.</p>${remaining}${link}${accountLink}`,
      args.business,
      args.sentrelloCredit,
    ),
  };
}

/**
 * What a buyer gets when their payment goes through.
 *
 * Sent to somebody who may have no account here at all — a visitor who bought
 * one thing from a shop — so it carries the order number and a link that is
 * itself the credential, the same way a booking's link is. No sign-in, because
 * there is nothing to sign in to.
 */
export function orderPaidEmail(args: {
  number: string;
  totalCents: number;
  currency: string;
  businessName?: string;
  orderUrl?: string;
  business?: BusinessIdentity;
  sentrelloCredit?: boolean;
}) {
  const link = args.orderUrl
    ? `<p><a href="${escapeHtml(args.orderUrl)}">See your order</a></p>`
    : "";
  return {
    subject: `Order ${args.number} — payment received`,
    html: layout(
      "Thank you for your order",
      `<p>We received <strong>${formatMoney(args.totalCents, args.currency, sellerLocale(args.business))}</strong>
for order ${escapeHtml(args.number)}${
        args.businessName ? ` from ${escapeHtml(args.businessName)}` : ""
      }.</p>
<p>We will email you again when it is on its way.</p>${link}`,
      args.business,
      args.sentrelloCredit,
    ),
  };
}

/**
 * And what they get when it is sent.
 *
 * The tracking reference is optional because plenty of small businesses post
 * things without one, and an email that insists on a number it does not have
 * is an email that never goes.
 */
export function orderDespatchedEmail(args: {
  number: string;
  businessName?: string;
  carrier?: string | null;
  tracking?: string | null;
  orderUrl?: string;
  business?: BusinessIdentity;
  sentrelloCredit?: boolean;
}) {
  const carried = args.carrier ? ` with ${escapeHtml(args.carrier)}` : "";
  const reference = args.tracking
    ? `<p>Tracking reference: <strong>${escapeHtml(args.tracking)}</strong></p>`
    : "";
  const link = args.orderUrl
    ? `<p><a href="${escapeHtml(args.orderUrl)}">See your order</a></p>`
    : "";
  return {
    subject: `Order ${args.number} is on its way`,
    html: layout(
      "Your order has been sent",
      `<p>Order ${escapeHtml(args.number)}${
        args.businessName ? ` from ${escapeHtml(args.businessName)}` : ""
      } has been sent${carried}.</p>${reference}${link}`,
      args.business,
      args.sentrelloCredit,
    ),
  };
}

/**
 * The link to everything a customer has with a business.
 *
 * It took a name and nothing else, so it was the one email here that could
 * not carry the seller's details or drop the credit — and a business paying
 * for Pro got an email about money it is owed, signed by us, with no address
 * for the customer to reply to and no word on how to pay. Its own invoice
 * emails do the opposite. These are the parameters every other template
 * takes; crediting still defaults to on, so a caller that forgets is safe.
 */
export function portalLinkEmail(args: {
  businessName: string;
  url: string;
  outstandingCents?: number;
  currency?: string;
  /** The seller, for the foot of the message. */
  business?: BusinessIdentity;
  /** False on Pro, where the business sends under its own name. */
  sentrelloCredit?: boolean;
}) {
  const owed =
    args.outstandingCents && args.outstandingCents > 0
      ? `<p>Outstanding: <strong>${formatMoney(args.outstandingCents, args.currency, sellerLocale(args.business))}</strong></p>`
      : "";
  return {
    subject: `Your invoices from ${args.businessName}`,
    html: layout(
      `Your invoices from ${args.businessName}`,
      `${owed}<p><a href="${escapeHtml(args.url)}">View your invoices</a></p>
<p style="color:#666;font-size:12px">This link is private to you — treat it
like a bill in the post. Anyone who has it can see the page.</p>`,
      args.business,
      args.sentrelloCredit,
    ),
  };
}

export function overdueReminderEmail(args: {
  number: string;
  balanceDueCents: number;
  currency: string;
  /** The seller, for the foot of the document. */
  business?: BusinessIdentity;
  /** False on Pro, where the business sends under its own name. */
  sentrelloCredit?: boolean;
}) {
  return {
    subject: `Invoice ${args.number} is overdue`,
    html: layout(
      `Invoice ${args.number} is overdue`,
      `<p>Outstanding balance: <strong>${formatMoney(args.balanceDueCents, args.currency, sellerLocale(args.business))}</strong></p>`,
      args.business,
      args.sentrelloCredit,
    ),
  };
}

/**
 * The one email a locked-out owner needs.
 *
 * Deliberately plain about the deadline and about not having asked: someone
 * who did not request this needs to know whether to worry, and someone who did
 * needs to know how long they have before trying again.
 */
/**
 * Proving an address belongs to the person using it.
 *
 * Only sent where a business has asked for verification — most self-hosted
 * instances never will, because the administrator invited these people
 * personally and already knows who they are.
 */
export function verifyEmailEmail(args: {
  url: string;
  businessName?: string;
  business?: BusinessIdentity;
  sentrelloCredit?: boolean;
}) {
  return {
    subject: "Confirm your email address",
    html: layout(
      "Confirm your email address",
      `<p>${
        args.businessName
          ? `${escapeHtml(args.businessName)} asks that everybody confirms`
          : "Please confirm"
      } the address they sign in with.</p>
<p><a href="${escapeHtml(args.url)}">Confirm this address</a></p>
<p>If you were not expecting this, nothing happens until you follow the link.</p>`,
      args.business,
      args.sentrelloCredit,
    ),
  };
}

/**
 * Sent to the address on the account *before* a change to it, never to the
 * one being asked for. Whoever holds this inbox is the only one who can say
 * yes — following the link is what makes Better Auth mail a second,
 * ordinary verification link to the new address, and nothing about the
 * account moves until that second link is followed too.
 */
export function confirmEmailChangeEmail(args: {
  url: string;
  newEmail: string;
}) {
  return {
    subject: "Confirm your new sign-in email",
    html: layout(
      "Confirm your new sign-in email",
      `<p>A request was made to change the email address you sign in with to
<strong>${escapeHtml(args.newEmail)}</strong>.</p>
<p><a href="${escapeHtml(args.url)}">Confirm this change</a></p>
<p style="color:#666;font-size:12px">If you did not ask for this, ignore this
message — nothing changes unless you follow the link, and this address keeps
working either way.</p>`,
    ),
  };
}

export function invitationEmail(args: {
  url: string;
  organizationName: string;
  inviterName?: string | null;
  expiresAt?: Date | null;
}) {
  const from = args.inviterName?.trim()
    ? `${escapeHtml(args.inviterName.trim())} has invited you`
    : "You have been invited";
  const until = args.expiresAt
    ? `<p style="color:#666;font-size:12px">The link works once and expires on
${escapeHtml(
  args.expiresAt.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }),
)}. If it has, ask to be invited again.</p>`
    : "";
  return {
    subject: `Join ${args.organizationName} on Sentrello`,
    html: layout(
      `Join ${args.organizationName}`,
      `<p>${from} to work in <strong>${escapeHtml(args.organizationName)}</strong>.</p>
<p><a href="${escapeHtml(args.url)}">Accept the invitation</a></p>
${until}
<p style="color:#666;font-size:12px">If you were not expecting this, nothing
happens until you follow the link.</p>`,
    ),
  };
}

export function passwordResetEmail(args: {
  url: string;
  expiresInMinutes: number;
}) {
  return {
    subject: "Reset your Sentrello password",
    html: layout(
      "Reset your password",
      `<p><a href="${escapeHtml(args.url)}">Choose a new password</a></p>
<p style="color:#666;font-size:12px">The link works once and expires in
${args.expiresInMinutes} minutes. If you did not ask for this, nothing has
changed and you can ignore this email — your current password still works.</p>`,
    ),
  };
}
