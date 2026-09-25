/**
 * The page a customer sees when they follow the link on their invoice.
 *
 * No account, no password. The people being invoiced are customers of a small
 * business — a joiner's customer will not create a login to look at a bill,
 * and a bill nobody opens is a bill nobody pays. The token in the link is the
 * whole credential, exactly as the calendar feed and download links work.
 *
 * Server-rendered, because this has to survive a phone on a bad signal.
 */

import {
  type Credit,
  SENTRELLO_CREDIT,
  creditFooter,
} from "@sentrello/db/credit";
import { invoiceState } from "@sentrello/db/money";
import {
  CUSTOMER_THEME_CSS,
  type CustomerTheme,
  customerThemeSwitch,
  themeAttribute,
} from "@sentrello/module-sdk";

const html = (s: string) =>
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

/**
 * A figure written the way the business that sent it writes figures.
 *
 * The seller's convention, not the reader's, the same as the document this
 * page links to: `en-US` for everybody wrote a European number the American
 * way, and showed a Canadian business's own customers `CA$`.
 */
function money(cents: number, currency = "USD", locale = "en-US"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(
    cents / 100,
  );
}

function day(value: Date | string | null): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(d.getTime())
    ? "—"
    : new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(d);
}

const STYLE = `
/* Ink, paper and the switch are the platform's, so this page looks like the
   account page it hangs off. */
${CUSTOMER_THEME_CSS}
:root { --paid:#1f7a4d; --due:#a16207; --over:#b91c1c; }
/* The status colours change with the ground they sit on. The light values
   measured 2.9–3.8:1 on the dark background against WCAG's 4.5:1 — "overdue"
   was hardest to read exactly where it mattered. Dark values measure 6:1+. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --paid:#3faf74; --due:#cf9436; --over:#ef6a6a; }
}
:root[data-theme="dark"] { --paid:#3faf74; --due:#cf9436; --over:#ef6a6a; }
.page-tools { display:flex; justify-content:flex-end; margin-bottom:1rem; }
* { box-sizing: border-box; }
body { font:16px/1.6 system-ui,-apple-system,sans-serif; color:var(--ink);
  background:var(--bg); margin:0; padding:3rem 1.5rem; }
main { max-width:44rem; margin:0 auto; }
h1 { font-size:1.5rem; margin:0 0 .25rem; }
.sub { color:var(--muted); margin:0 0 2rem; }
table { width:100%; border-collapse:collapse; font-size:.95rem; }
th { text-align:left; font-weight:600; border-bottom:1px solid var(--line); padding:.6rem 0; }
td { border-bottom:1px solid var(--line); padding:.7rem 0; }
.num { text-align:right; font-variant-numeric:tabular-nums; }
.owed { font-size:1.25rem; font-weight:600; margin:1.5rem 0 0; }
.paid { color:var(--paid); } .due { color:var(--due); } .over { color:var(--over); }
.muted { color:var(--muted); font-size:.875rem; }
h2.section { font-size:1.05rem; margin:0 0 .75rem; }
footer.seller { margin-top:2.5rem; padding-top:1.25rem; border-top:1px solid var(--line);
  display:flex; flex-wrap:wrap; gap:2rem; color:var(--muted); font-size:.8125rem; line-height:1.5; }
footer.seller .howto { max-width:22rem; }
.credit { margin-top:2rem; font-size:.8125rem; color:var(--muted); }
.credit a { color:var(--muted); }
button.pay { font:inherit; font-weight:600; padding:.4rem .9rem; border:0;
  /* #2f8f8a put white text at 3.88:1; this is the same teal held down to 5.4:1. */
  border-radius:.375rem; background:#257672; color:#fff; cursor:pointer; }
form { margin:0; }
`;

export interface PortalQuote {
  id: string;
  number: string;
  status: string;
  currency: string;
  totalCents: number;
}

export interface PortalInvoice {
  id: string;
  number: string;
  /** The stored column. Read only for draft and void — never for the badge. */
  status: string;
  currency: string;
  totalCents: number;
  paidCents: number;
  /** Settled by credit note rather than by money. Absent means none. */
  creditedCents?: number;
  /** Debt given up for paying early. It settles the invoice; no money moved. */
  earlyDiscountTakenCents?: number | null;
  dueDate: Date | string | null;
}

/**
 * Quotes awaiting an answer.
 *
 * Only ones the business has actually sent: a draft is the business thinking
 * out loud, and a customer seeing it would be reading over their shoulder.
 * Accepting is a real form post, so it works with scripts blocked.
 */
function quoteSection(
  quotes: PortalQuote[],
  quotePath?: string,
  locale?: string,
): string {
  const open = quotes.filter((q) => q.status === "sent");
  if (open.length === 0) return "";

  const rows = open
    .map(
      (q) => `<tr>
  <td>${html(q.number)}</td>
  <td class="num">${html(money(q.totalCents, q.currency, locale))}</td>
  <td class="num">${
    quotePath
      ? `<form method="post" action="${html(quotePath)}/${html(q.id)}/accept">
       <button class="pay" type="submit">Accept</button></form>`
      : ""
  }</td>
</tr>`,
    )
    .join("\n");

  return `<h2 class="section">Quotes for you to approve</h2>
<table>
  <thead><tr><th>Quote</th><th class="num">Amount</th><th></th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<p class="muted" style="margin:.75rem 0 2.5rem">Accepting turns a quote into an
invoice. Nothing is charged until you pay it.</p>`;
}

/**
 * The badge and the balance, from one computation.
 *
 * `invoiceState` is the whole of it — the same function the customer's
 * account summary and the invoice list read. The badge used to come off the
 * stored `status` column while the figure under the table was worked out live
 * from payments and credits, which is two answers to one question on one
 * page: an invoice settled by a path that forgot to update the column read
 * "due" above "Nothing outstanding", and one settled for less because the
 * customer paid early read "paid" above a figure they no longer owed.
 */
function state(invoice: PortalInvoice, now: Date) {
  return invoiceState(
    invoice,
    invoice.paidCents,
    invoice.creditedCents ?? 0,
    now,
  );
}

/** Who the business is, as it must appear on a document a customer files. */
export interface BusinessIdentity {
  name: string;
  address?: string | null;
  taxId?: string | null;
  taxIdLabel?: string | null;
  paymentInstructions?: string | null;
}

/**
 * The seller's details, at the foot of the page.
 *
 * A name alone is not an invoice: in the UK and across the EU the seller's
 * address is required, and a VAT invoice must carry the registration number.
 * Payment instructions are the practical half — a business paid by transfer
 * whose invoices omit its account details answers "where do I send this?" on
 * every one of them.
 */
function businessFooter(b: BusinessIdentity): string {
  const lines: string[] = [];
  if (b.address) {
    lines.push(
      `<div>${b.address
        .split("\n")
        .map((l) => html(l.trim()))
        .filter(Boolean)
        .join("<br>")}</div>`,
    );
  }
  if (b.taxId) {
    lines.push(
      `<div>${html(b.taxIdLabel?.trim() || "Tax number")}: ${html(b.taxId)}</div>`,
    );
  }
  if (lines.length === 0 && !b.paymentInstructions) return "";

  const pay = b.paymentInstructions
    ? `<div class="howto"><strong>How to pay</strong><br>${b.paymentInstructions
        .split("\n")
        .map((l) => html(l.trim()))
        .filter(Boolean)
        .join("<br>")}</div>`
    : "";

  return `<footer class="seller"><div><strong>${html(b.name)}</strong>${
    lines.length ? `<br>${lines.join("")}` : ""
  }</div>${pay}</footer>`;
}

export function portalPage(args: {
  businessName: string;
  /** the seller's own details, for the foot of the page */
  business?: BusinessIdentity;
  customerName: string;
  /**
   * How this business writes a number — `de-DE`, `en-CA`, `en-US`.
   *
   * Absent means the American way, which is what every page did before the
   * business's own country was asked for.
   */
  locale?: string;
  invoices: PortalInvoice[];
  /** quotes waiting on this customer's answer */
  quotes?: PortalQuote[];
  /** where an Accept button posts */
  quotePath?: string;
  /** where a Pay button posts, when this instance can take card payments */
  payPath?: string;
  /**
   * Whose name is at the foot. Defaults to ours so a caller that never asked
   * still shows the branding — absence of an answer is not removal.
   */
  credit?: Credit | null;
  /**
   * The customer's own hub across every module, not only invoicing — Shop
   * orders, a subscription, a booking. The same token that opens this page
   * opens that one, so offering it here tells nobody anything they could not
   * already reach; leave it unset and nothing is shown, rather than a link
   * built from a token that never existed.
   */
  accountPath?: string;
  /** This page's own address and the reader's colours, for the switch. */
  path?: string;
  theme?: CustomerTheme;
  now?: Date;
}): string {
  const {
    businessName,
    business,
    customerName,
    locale,
    invoices,
    quotes = [],
    quotePath,
    payPath,
    credit = SENTRELLO_CREDIT,
    accountPath,
    path,
    theme,
    now = new Date(),
  } = args;

  // Worked out once per invoice and then read from, so the badge in a row and
  // the figure under the table can never be answers to two different sums.
  const states = new Map(invoices.map((i) => [i.id, state(i, now)]));
  const owed = invoices.reduce(
    (sum, i) => sum + (states.get(i.id)?.balanceDue ?? 0),
    0,
  );
  const currency = invoices[0]?.currency ?? "USD";

  const rows =
    invoices.length === 0
      ? `<tr><td colspan="5" class="muted">Nothing outstanding.</td></tr>`
      : invoices
          .map((i) => {
            const { badge, balanceDue: balance } =
              states.get(i.id) ?? state(i, now);
            const cls =
              badge === "paid" || badge === "credited"
                ? "paid"
                : badge === "overdue"
                  ? "over"
                  : "due";
            const pay =
              payPath && balance > 0
                ? `<form method="post" action="${html(payPath)}/${html(i.id)}">
       <button class="pay" type="submit">Pay</button></form>`
                : "";
            return `<tr>
  <td>${html(i.number)}</td>
  <td>${html(day(i.dueDate))}</td>
  <td class="${cls}">${html(badge)}</td>
  <td class="num">${html(money(balance || i.totalCents, i.currency, locale))}</td>
  <td class="num">${pay}</td>
</tr>`;
          })
          .join("\n");

  return `<!doctype html>
<html lang="en"${themeAttribute(theme)}><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${html(businessName)} — your account</title>
<style>${STYLE}</style>
</head><body><main>
${path ? `<div class="page-tools">${customerThemeSwitch(path, theme)}</div>` : ""}
<h1>${html(businessName)}</h1>
<p class="sub">For ${html(customerName)}</p>
${accountPath ? `<p class="muted"><a href="${html(accountPath)}">See everything you have with us</a></p>` : ""}
${quoteSection(quotes, quotePath, locale)}
${
  invoices.length === 0
    ? // An empty table with headers, under a quote awaiting approval, reads as
      // though something failed to load. Say nothing instead.
      quotes.some((q) => q.status === "sent")
      ? ""
      : `<p class="muted">Nothing outstanding.</p>`
    : `<h2 class="section">Your invoices</h2>
<table>
  <thead><tr><th>Invoice</th><th>Due</th><th>Status</th><th class="num">Amount</th><th></th></tr></thead>
  <tbody>${rows}</tbody>
</table>
${owed > 0 ? `<p class="owed">${html(money(owed, currency, locale))} outstanding</p>` : `<p class="owed paid">Nothing outstanding</p>`}`
}
<p class="muted" style="margin-top:2rem">This page is private to you. Anyone
with the link can see it, so treat it like a bill in the post.</p>
${businessFooter(business ?? { name: businessName })}
${creditFooter(credit)}
</main></body></html>`;
}
