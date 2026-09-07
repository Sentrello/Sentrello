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

function money(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
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
:root { color-scheme: light dark; --ink:#1a1a1a; --muted:#666; --line:#e4e4e7; --bg:#fff; }
@media (prefers-color-scheme: dark) {
  :root { --ink:#f4f4f5; --muted:#a1a1aa; --line:#333; --bg:#131313; }
}
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
.paid { color:#1f7a4d; } .due { color:#a16207; } .over { color:#b91c1c; }
.muted { color:var(--muted); font-size:.875rem; }
h2.section { font-size:1.05rem; margin:0 0 .75rem; }
footer.seller { margin-top:2.5rem; padding-top:1.25rem; border-top:1px solid var(--line);
  display:flex; flex-wrap:wrap; gap:2rem; color:var(--muted); font-size:.8125rem; line-height:1.5; }
footer.seller .howto { max-width:22rem; }
button.pay { font:inherit; font-weight:600; padding:.4rem .9rem; border:0;
  border-radius:.375rem; background:#2f8f8a; color:#fff; cursor:pointer; }
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
  status: string;
  currency: string;
  totalCents: number;
  paidCents: number;
  dueDate: Date | string | null;
}

/**
 * Quotes awaiting an answer.
 *
 * Only ones the business has actually sent: a draft is the business thinking
 * out loud, and a customer seeing it would be reading over their shoulder.
 * Accepting is a real form post, so it works with scripts blocked.
 */
function quoteSection(quotes: PortalQuote[], quotePath?: string): string {
  const open = quotes.filter((q) => q.status === "sent");
  if (open.length === 0) return "";

  const rows = open
    .map(
      (q) => `<tr>
  <td>${html(q.number)}</td>
  <td class="num">${html(money(q.totalCents, q.currency))}</td>
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

/** Overdue is a state the customer should see, not a state the seller knows. */
function label(invoice: PortalInvoice, now = new Date()): string {
  if (invoice.status === "paid") return "paid";
  const due = invoice.dueDate ? new Date(invoice.dueDate) : null;
  if (due && due.getTime() < now.getTime()) return "overdue";
  return invoice.status === "partial" ? "part paid" : "due";
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
  invoices: PortalInvoice[];
  /** quotes waiting on this customer's answer */
  quotes?: PortalQuote[];
  /** where an Accept button posts */
  quotePath?: string;
  /** where a Pay button posts, when this instance can take card payments */
  payPath?: string;
  now?: Date;
}): string {
  const {
    businessName,
    business,
    customerName,
    invoices,
    quotes = [],
    quotePath,
    payPath,
    now = new Date(),
  } = args;

  const owed = invoices.reduce(
    (sum, i) => sum + Math.max(0, i.totalCents - i.paidCents),
    0,
  );
  const currency = invoices[0]?.currency ?? "USD";

  const rows =
    invoices.length === 0
      ? `<tr><td colspan="5" class="muted">Nothing outstanding.</td></tr>`
      : invoices
          .map((i) => {
            const state = label(i, now);
            const cls =
              state === "paid" ? "paid" : state === "overdue" ? "over" : "due";
            const balance = Math.max(0, i.totalCents - i.paidCents);
            const pay =
              payPath && balance > 0
                ? `<form method="post" action="${html(payPath)}/${html(i.id)}">
       <button class="pay" type="submit">Pay</button></form>`
                : "";
            return `<tr>
  <td>${html(i.number)}</td>
  <td>${html(day(i.dueDate))}</td>
  <td class="${cls}">${html(state)}</td>
  <td class="num">${html(money(balance || i.totalCents, i.currency))}</td>
  <td class="num">${pay}</td>
</tr>`;
          })
          .join("\n");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${html(businessName)} — your account</title>
<style>${STYLE}</style>
</head><body><main>
<h1>${html(businessName)}</h1>
<p class="sub">For ${html(customerName)}</p>
${quoteSection(quotes, quotePath)}
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
${owed > 0 ? `<p class="owed">${html(money(owed, currency))} outstanding</p>` : `<p class="owed paid">Nothing outstanding</p>`}`
}
<p class="muted" style="margin-top:2rem">This page is private to you. Anyone
with the link can see it, so treat it like a bill in the post.</p>
${businessFooter(business ?? { name: businessName })}
</main></body></html>`;
}
