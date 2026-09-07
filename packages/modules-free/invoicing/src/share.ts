import { and, asc, db, eq, schema, sql } from "@sentrello/db";
import { earlyPaymentTerms } from "@sentrello/db/money";
import { businessIdentity } from "@sentrello/db/portal";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";
import { rateLimit } from "@sentrello/module-sdk";
import { type Template, templateFor } from "./templates";

/**
 * One document, on a link, with no account anywhere.
 *
 * The reference gets two things right here that most invoicing products get
 * wrong, and both are kept.
 *
 * **A link per document, not per customer.** The customer portal already lets
 * somebody see everything they owe; this is for the single invoice attached to
 * an email, which is what people actually click. They are different needs and
 * a business uses both.
 *
 * **A read receipt.** A business chasing an unpaid invoice is in a completely
 * different conversation depending on whether the customer has opened it, and
 * "I never received it" is the most common thing said on that call. Recording
 * the first open answers it without anybody having to be believed.
 */

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function money(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(cents / 100);
}

function day(value: Date | string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Quantity is stored in thousandths; "1.5" reads better than "1.500". */
function quantity(milli: number): string {
  const value = milli / 1000;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

const STYLE = `
:root{color-scheme:light dark}
body{font-family:system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1.25rem;line-height:1.5}
h1{font-size:1.35rem;margin-bottom:.15rem}
table{width:100%;border-collapse:collapse;margin-top:1.5rem;font-size:.95rem}
th,td{text-align:left;padding:.5rem .35rem;border-bottom:1px solid rgba(128,128,128,.3)}
th:last-child,td:last-child,.num{text-align:right;font-variant-numeric:tabular-nums}
.muted{opacity:.7;font-size:.9rem}
.totals{margin-left:auto;margin-top:1rem;width:min(22rem,100%)}
.totals td{border:0;padding:.2rem .35rem}
.totals tr:last-child td{border-top:1px solid rgba(128,128,128,.4);font-weight:600;padding-top:.5rem}
.head{display:flex;justify-content:space-between;gap:1.5rem;flex-wrap:wrap;align-items:flex-start}
.pill{display:inline-block;padding:.15rem .55rem;border-radius:999px;font-size:.8rem;border:1px solid currentColor}
footer{margin-top:3rem;font-size:.85rem;opacity:.7}
h1,.accent{color:var(--accent,inherit)}
.logo{max-height:4rem;max-width:14rem;margin-bottom:.75rem}
.note{margin-top:1rem;white-space:pre-line}
.print{margin-top:2rem}
.print button{font:inherit;padding:.4rem .9rem;border-radius:.4rem;border:1px solid currentColor;background:none;color:inherit;cursor:pointer}
@media print{
  body{margin:0;max-width:none}
  .print{display:none}
}
`;

/**
 * Three documents that look like three documents.
 *
 * The reference lets a business write its own HTML template. We will not — the
 * page a customer opens is same-origin with the application, so stored markup
 * is stored script (see templates.ts). What a business actually wants is a
 * letterhead that does not look like everybody else's, and three layouts we
 * wrote ourselves give that without handing anybody a text box that runs.
 *
 * Each is a stylesheet over the same markup, so every document says the same
 * things in the same order however it is dressed.
 */
export const LAYOUTS: Record<string, string> = {
  /** What it always was: rules, a plain head, totals to the right. */
  classic: "",

  /**
   * A band of colour across the top and air around everything.
   *
   * The look somebody means by "make it look modern": the number large, the
   * rules gone, the totals in a tinted block rather than a bordered table.
   */
  modern: `
body{max-width:48rem}
.head{padding:1.5rem 1.5rem 1.25rem;border-radius:.75rem;
  background:color-mix(in srgb,var(--accent,#334155) 12%,transparent);
  border-top:4px solid var(--accent,#334155)}
h1{font-size:2rem;letter-spacing:-.02em;margin-top:.25rem}
th{text-transform:uppercase;letter-spacing:.06em;font-size:.72rem;opacity:.65;
  border-bottom:2px solid var(--accent,#334155)}
td{border-bottom:1px solid rgba(128,128,128,.18)}
.totals{padding:.75rem 1rem;border-radius:.5rem;
  background:color-mix(in srgb,var(--accent,#334155) 8%,transparent)}
.totals tr:last-child td{border-top-color:var(--accent,#334155);font-size:1.05rem}
.pill{border:0;background:var(--accent,#334155);color:#fff}
`,

  /**
   * For an invoice with forty lines on it.
   *
   * A trade billing a month of visits prints three pages in the other two and
   * one in this. Nothing is removed — it is set smaller and tighter, because
   * the alternative businesses reach for is leaving detail off.
   */
  compact: `
body{max-width:44rem;margin:2rem auto;line-height:1.35;font-size:.9rem}
h1{font-size:1.1rem}
table{margin-top:1rem;font-size:.85rem}
th,td{padding:.28rem .3rem}
th{border-bottom:1px solid var(--accent,currentColor)}
td{border-bottom:1px solid rgba(128,128,128,.18)}
.totals{width:min(18rem,100%);margin-top:.6rem}
.logo{max-height:2.5rem;margin-bottom:.35rem}
footer{margin-top:1.5rem;font-size:.78rem}
`,
};

/**
 * The business's own document, or the plain one.
 *
 * Every field is escaped, and the colour is checked to be a hex colour before
 * it is written into a stylesheet — see the note in templates.ts for why a
 * template here is a set of fields and not a body of HTML.
 */
function branding(template: Template | null): {
  style: string;
  logo: string;
  header: string;
  footer: string;
} {
  if (!template) return { style: "", logo: "", header: "", footer: "" };
  const colour = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(
    template.accentColor ?? "",
  )
    ? template.accentColor
    : null;
  const paper = template.paperSize === "a4" ? "A4" : "letter";
  // A name we look up, never a stylesheet somebody sent us.
  const layout = LAYOUTS[template.layout ?? "classic"] ?? "";
  return {
    style: `${colour ? `:root{--accent:${colour}}` : ""}@page{size:${paper};margin:16mm}${layout}`,
    logo: template.logoPath
      ? `<img class="logo" src="/share/template/${esc(template.id)}/logo" alt="${esc(template.name)}">`
      : "",
    header: template.headerNote
      ? `<p class="note">${esc(template.headerNote)}</p>`
      : "",
    footer: template.footerNote
      ? `<p class="note">${esc(template.footerNote)}</p>`
      : "",
  };
}

interface DocumentLine {
  description: string;
  quantityMilli: number;
  unit: string;
  unitPriceCents: number;
  taxRateBp: number;
  /** Set when several invoices were merged into this one. */
  sourceNumber?: string | null;
}

/**
 * The document itself.
 *
 * Deliberately plain HTML with no script: this is opened by somebody outside
 * the business, often on a phone, sometimes through a mail client's own
 * browser. Anything that needs JavaScript to show a total is a total that
 * sometimes does not appear.
 */
function documentPage(args: {
  kind: "invoice" | "quote";
  number: string;
  status: string;
  issueDate: Date | string;
  dueDate: Date | string | null;
  currency: string;
  lines: DocumentLine[];
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  paidCents: number;
  notes: string | null;
  paymentTerms: string | null;
  /** Pay by this date and pay this much less. Null when nothing is offered. */
  earlyPayment: {
    deadline: Date;
    savingCents: number;
    totalCents: number;
  } | null;
  bands: { name: string; rateBp: number; taxCents: number; named: boolean }[];
  business: {
    name: string;
    address: string | null;
    taxId: string | null;
    taxIdLabel: string | null;
  };
  customer: string | null;
  template: Template | null;
}): string {
  const brand = branding(args.template);
  const noun = args.kind === "invoice" ? "Invoice" : "Quote";
  const due = args.totalCents - args.paidCents;

  const lineRow = (l: DocumentLine) => `<tr>
      <td>${esc(l.description)}</td>
      <td class="num">${quantity(l.quantityMilli)}${l.unit && l.unit !== "piece" ? ` ${esc(l.unit)}` : ""}</td>
      <td class="num">${money(l.unitPriceCents, args.currency)}</td>
      <td class="num">${money(Math.round((l.quantityMilli / 1000) * l.unitPriceCents), args.currency)}</td>
    </tr>`;

  const net = (l: DocumentLine) =>
    Math.round((l.quantityMilli / 1000) * l.unitPriceCents);

  /**
   * Merged invoices read as the several jobs they were.
   *
   * A customer who received five drafts' worth of work as one document should
   * still be able to see which visit each line belongs to and what each came
   * to — otherwise the merge has saved us an envelope and cost them the only
   * way they had to check it.
   *
   * Only when there is something to group by: an ordinary invoice has no
   * source numbers and gets the plain list it always had.
   */
  const grouped = args.lines.some((l) => l.sourceNumber);
  let rows: string;
  if (grouped) {
    const order: string[] = [];
    const bySource = new Map<string, DocumentLine[]>();
    for (const line of args.lines) {
      const key = line.sourceNumber ?? "";
      if (!bySource.has(key)) {
        bySource.set(key, []);
        order.push(key);
      }
      bySource.get(key)?.push(line);
    }
    rows = order
      .map((key) => {
        const own = bySource.get(key) ?? [];
        const subtotal = own.reduce((sum, l) => sum + net(l), 0);
        const heading = key
          ? `<tr><td colspan="4"><strong>${esc(key)}</strong></td></tr>`
          : "";
        const tail = key
          ? `<tr><td colspan="3" class="num">${esc(key)} subtotal</td><td class="num">${money(subtotal, args.currency)}</td></tr>`
          : "";
        return heading + own.map(lineRow).join("") + tail;
      })
      .join("");
  } else {
    rows = args.lines.map(lineRow).join("");
  }

  /**
   * Bands that charged nothing and were never named are not shown.
   *
   * A genuinely zero-rated band has a name a business chose — "Zero-rated",
   * "Reverse charge" — and belongs on the document, because it tells the
   * customer why no tax was added. An untyped 0% line has the placeholder
   * name this code invented, and printing "No tax $0.00" on an invoice is
   * noise nobody asked for.
   */
  const shown = args.bands.filter((b) => b.taxCents !== 0 || b.named);
  const bandRows = shown
    .map(
      (b) =>
        `<tr><td>${esc(b.name)}</td><td class="num">${money(b.taxCents, args.currency)}</td></tr>`,
    )
    .join("");

  /**
   * Tax that was charged but has no band behind it.
   *
   * Documents raised before the breakdown existed have a tax figure and no
   * bands, and without this the totals jumped from subtotal to total with the
   * difference unexplained — which is the one thing a customer checking an
   * invoice will always query.
   */
  const unbanded =
    args.taxCents !== 0 && shown.reduce((sum, b) => sum + b.taxCents, 0) === 0
      ? `<tr><td>Tax</td><td class="num">${money(args.taxCents, args.currency)}</td></tr>`
      : "";

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${noun} ${esc(args.number)}</title><style>${STYLE}${brand.style}</style></head><body>
<div class="head">
  <div>
    ${brand.logo}
    <h1>${noun} ${esc(args.number)}</h1>
    <p class="muted">Issued ${day(args.issueDate)}${
      args.kind === "invoice" && args.dueDate
        ? ` · due ${day(args.dueDate)}`
        : ""
    }</p>
    ${args.customer ? `<p class="muted">For ${esc(args.customer)}</p>` : ""}
  </div>
  <div><span class="pill">${esc(args.status)}</span></div>
</div>

${brand.header}

<table>
  <thead><tr><th>Description</th><th>Qty</th><th>Unit price</th><th>Amount</th></tr></thead>
  <tbody>${rows}</tbody>
</table>

<table class="totals">
  <tr><td>Subtotal</td><td class="num">${money(args.subtotalCents, args.currency)}</td></tr>
  ${
    args.discountCents > 0
      ? `<tr><td>Discount</td><td class="num">−${money(args.discountCents, args.currency)}</td></tr>`
      : ""
  }
  ${bandRows}${unbanded}
  <tr><td>Total</td><td class="num">${money(args.totalCents, args.currency)}</td></tr>
  ${
    args.kind === "invoice" && args.paidCents > 0
      ? `<tr><td>Paid</td><td class="num">−${money(args.paidCents, args.currency)}</td></tr>
         <tr><td>${due > 0 ? "Still due" : "Settled"}</td><td class="num">${money(Math.max(0, due), args.currency)}</td></tr>`
      : ""
  }
</table>

${
  /**
   * The offer, in the two numbers somebody deciding whether to pay today
   * actually needs: the saving, and the date it stops.
   *
   * Under the totals rather than beside them, because it is not part of what
   * is owed — it is a thing that could still happen to what is owed.
   */
  args.kind === "invoice" && args.earlyPayment && args.paidCents === 0
    ? `<p class="muted">Pay by ${day(args.earlyPayment.deadline)} and take ${money(args.earlyPayment.savingCents, args.currency)} off — ${money(args.earlyPayment.totalCents, args.currency)} settles it in full.</p>`
    : ""
}

${args.paymentTerms ? `<p class="muted">${esc(args.paymentTerms)}</p>` : ""}
${args.notes ? `<p>${esc(args.notes)}</p>` : ""}
${brand.footer}

<!--
  Saving it as a PDF.

  The browser's own print dialogue, rather than a PDF generator on the server:
  every browser has one, it produces a better-looking document than a headless
  renderer we would have to ship and keep patched, and the page still reads
  perfectly with the button gone — which is what happens with no JavaScript,
  and in the printed copy itself.
-->
<div class="print">
  <button type="button" onclick="window.print()">Save as PDF</button>
</div>

<footer>
  <strong>${esc(args.business.name)}</strong>
  ${args.business.address ? `<br>${esc(args.business.address)}` : ""}
  ${
    args.business.taxId
      ? `<br>${esc(args.business.taxIdLabel ?? "Tax ID")}: ${esc(args.business.taxId)}`
      : ""
  }
</footer>
</body></html>`;
}

export function registerShare(ctx: ModuleContext) {
  for (const kind of ["invoice", "quote"] as const) {
    const table = kind === "invoice" ? schema.invoices : schema.quotes;
    const lineTable =
      kind === "invoice" ? schema.invoiceLines : schema.quoteLines;
    const lineKey =
      kind === "invoice"
        ? schema.invoiceLines.invoiceId
        : schema.quoteLines.quoteId;

    ctx.app.get(`/share/${kind}/:token`, async (c: RouteContext) => {
      const token = c.req.param("token") ?? "";

      /**
       * The token is the whole credential, so guessing is rate limited by
       * address. A wrong token answers 404 rather than 403: telling somebody a
       * token is real but not for them is telling them something.
       */
      const limited = rateLimit(
        `share:${c.req.header("x-real-ip") ?? "anon"}`,
        60,
        60_000,
      );
      if (!limited.allowed) return c.text("Too many requests", 429);
      if (token.length < 32) return c.notFound();

      const [row] = await db
        .select()
        .from(table)
        .where(and(eq(table.shareToken, token), eq(table.published, true)))
        .limit(1);
      if (!row) return c.notFound();

      /**
       * The read receipt.
       *
       * Counted on every open, but `first_viewed_at` is written once — the
       * question a business asks is "did they ever see it", and overwriting it
       * with the most recent open loses the only answer that matters.
       *
       * Written before the page is rendered rather than after, so a slow
       * render or a closed tab still records that they opened it.
       */
      await db
        .update(table)
        .set({
          firstViewedAt: row.firstViewedAt ?? new Date(),
          lastViewedAt: new Date(),
          viewCount: sql`${table.viewCount} + 1`,
        })
        .where(eq(table.id, row.id));

      const [lines, bands, business] = await Promise.all([
        db
          .select()
          .from(lineTable)
          .where(eq(lineKey, row.id))
          .orderBy(asc(lineTable.sortOrder)),
        db
          .select()
          .from(schema.documentTaxes)
          .where(
            and(
              eq(schema.documentTaxes.documentType, kind),
              eq(schema.documentTaxes.documentId, row.id),
            ),
          ),
        businessIdentity(row.organizationId),
      ]);

      let paidCents = 0;
      let customer: string | null = null;
      if (kind === "invoice") {
        const payments = await db
          .select({ amountCents: schema.payments.amountCents })
          .from(schema.payments)
          .where(eq(schema.payments.invoiceId, row.id));
        paidCents = payments.reduce((sum, p) => sum + p.amountCents, 0);
      }
      if (row.contactId) {
        const [contact] = await db
          .select({ name: schema.contacts.name })
          .from(schema.contacts)
          .where(eq(schema.contacts.id, row.contactId))
          .limit(1);
        customer = contact?.name ?? null;
      }

      const invoiceRow = row as typeof schema.invoices.$inferSelect;
      /**
       * Only while it can still be taken, and only on an invoice.
       *
       * A closed window shown on the page is an offer the customer will try to
       * take and be refused, which is worse than never having said so.
       */
      const terms =
        kind === "invoice"
          ? earlyPaymentTerms({
              type: invoiceRow.earlyDiscountType,
              value: invoiceRow.earlyDiscountValue,
              days: invoiceRow.earlyDiscountDays,
              issueDate: new Date(invoiceRow.issueDate),
              totalCents: invoiceRow.totalCents,
            })
          : null;

      return c.html(
        documentPage({
          kind,
          earlyPayment:
            terms?.open && terms.deadline && terms.savingCents > 0
              ? {
                  deadline: terms.deadline,
                  savingCents: terms.savingCents,
                  totalCents: terms.discountedTotalCents,
                }
              : null,
          number: row.number,
          status: row.status,
          issueDate: row.issueDate,
          dueDate: kind === "invoice" ? invoiceRow.dueDate : null,
          currency: row.currency,
          lines: lines.map((l) => ({
            description: l.description,
            quantityMilli: l.quantityMilli,
            unit: l.unit,
            unitPriceCents: l.unitPriceCents,
            taxRateBp: l.taxRateBp,
            sourceNumber:
              "sourceNumber" in l
                ? (l as { sourceNumber: string | null }).sourceNumber
                : null,
          })),
          subtotalCents: row.subtotalCents,
          discountCents: row.discountCents,
          taxCents: row.taxCents,
          totalCents: row.totalCents,
          paidCents,
          notes: row.notes,
          paymentTerms: kind === "invoice" ? invoiceRow.paymentTerms : null,
          bands: bands.map((b) => ({
            name: b.name,
            rateBp: b.rateBp,
            taxCents: b.taxCents,
            // Named by the business, rather than the placeholder this code
            // makes up for a bare rate typed onto a line.
            named: b.taxDefinitionId !== null,
          })),
          business: {
            name: business.name,
            // The identity helper leaves these undefined when unset; the page
            // draws a footer either way, so they are normalised here rather
            // than checked in three places in the markup.
            address: business.address ?? null,
            taxId: business.taxId ?? null,
            taxIdLabel: business.taxIdLabel ?? null,
          },
          customer,
          template: await templateFor(
            row.organizationId,
            (row as { templateId?: string | null }).templateId ?? null,
          ),
        }),
      );
    });
  }
}
