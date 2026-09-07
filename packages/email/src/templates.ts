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
export function formatMoney(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
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
export interface BusinessIdentity {
  name: string;
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
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">
<h1 style="font-size:18px">${escapeHtml(title)}</h1>
${body}
${sellerFooter(business)}
${sentrelloCredit ? '<p style="color:#666;font-size:12px">Sent by Sentrello</p>' : ""}
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
    ? `<p>Due ${escapeHtml(args.dueDate.toISOString().slice(0, 10))}.</p>`
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
      `<p>Amount due: <strong>${formatMoney(args.totalCents, args.currency)}</strong></p>${due}${link}`,
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
      `<p>Total: <strong>${formatMoney(args.totalCents, args.currency)}</strong></p>${link}`,
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
<strong>${formatMoney(args.balanceCents, args.currency)}</strong></p>`
      : "<p>This invoice is now settled in full. Thank you.</p>";
  const link = args.portalUrl
    ? `<p><a href="${escapeHtml(args.portalUrl)}">See your invoices</a></p>`
    : "";
  return {
    subject: `Receipt for invoice ${args.number}`,
    html: layout(
      "Payment received",
      `<p>We received <strong>${formatMoney(args.amountCents, args.currency)}</strong>
towards invoice ${escapeHtml(args.number)}${
        args.businessName ? ` from ${escapeHtml(args.businessName)}` : ""
      }.</p>${remaining}${link}`,
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
      `<p>We received <strong>${formatMoney(args.totalCents, args.currency)}</strong>
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

export function portalLinkEmail(args: {
  businessName: string;
  url: string;
  outstandingCents?: number;
  currency?: string;
}) {
  const owed =
    args.outstandingCents && args.outstandingCents > 0
      ? `<p>Outstanding: <strong>${formatMoney(args.outstandingCents, args.currency)}</strong></p>`
      : "";
  return {
    subject: `Your invoices from ${args.businessName}`,
    html: layout(
      `Your invoices from ${args.businessName}`,
      `${owed}<p><a href="${escapeHtml(args.url)}">View your invoices</a></p>
<p style="color:#666;font-size:12px">This link is private to you — treat it
like a bill in the post. Anyone who has it can see the page.</p>`,
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
      `<p>Outstanding balance: <strong>${formatMoney(args.balanceDueCents, args.currency)}</strong></p>`,
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
