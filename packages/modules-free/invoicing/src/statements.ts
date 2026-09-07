import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import {
  and,
  asc,
  db,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  schema,
} from "@sentrello/db";
import { businessIdentity } from "@sentrello/db/portal";
import {
  type ModuleContext,
  type RouteContext,
  defineMiddleware,
} from "@sentrello/module-sdk";

/**
 * A customer's account over a period.
 *
 * The document a business sends when somebody asks "what do we owe you" —
 * every invoice raised and every payment received, in date order, ending in
 * one figure. It is not a report: a report is for the business, and this is
 * for the customer, which is why it carries the business's identity and reads
 * as a document rather than a table of numbers.
 *
 * Built from the invoices and payments rather than from the ledger, and that
 * is deliberate: the ledger is the truth about the business's books, but a
 * customer's account is the truth about the documents they were sent. If those
 * two ever disagreed, the customer should be shown what they were actually
 * asked for.
 */

export interface StatementRow {
  date: Date;
  kind: "invoice" | "credit_note" | "payment";
  reference: string;
  description: string;
  /** What it added to the balance. Payments and credits are negative. */
  amountCents: number;
  /** The running balance after this line. */
  balanceCents: number;
}

export interface Statement {
  contact: { id: string; name: string; email: string | null };
  from: Date;
  to: Date;
  currency: string;
  openingCents: number;
  rows: StatementRow[];
  closingCents: number;
  /** How much of the closing balance is past its due date. */
  overdueCents: number;
}

/**
 * A running account, in the order things actually happened.
 *
 * Sorted by date rather than by document number, because a payment received in
 * March against an invoice raised in January belongs in March — a statement
 * sorted by invoice number reads as though the money arrived before the bill.
 */
export function buildStatement(input: {
  contact: Statement["contact"];
  from: Date;
  to: Date;
  currency: string;
  invoices: {
    number: string;
    kind: string;
    issueDate: Date;
    dueDate: Date | null;
    totalCents: number;
  }[];
  payments: { receivedAt: Date; amountCents: number; invoiceNumber: string }[];
  openingCents: number;
  now?: Date;
}): Statement {
  const now = input.now ?? new Date();

  const entries: StatementRow[] = [
    ...input.invoices.map((invoice) => ({
      date: invoice.issueDate,
      kind: (invoice.kind === "credit_note" ? "credit_note" : "invoice") as
        | "invoice"
        | "credit_note",
      reference: invoice.number,
      description:
        invoice.kind === "credit_note"
          ? `Credit note ${invoice.number}`
          : `Invoice ${invoice.number}`,
      // A credit note reduces what is owed, so it carries a negative sign on a
      // statement even though it is stored as a positive amount.
      amountCents:
        invoice.kind === "credit_note"
          ? -invoice.totalCents
          : invoice.totalCents,
      balanceCents: 0,
    })),
    ...input.payments.map((payment) => ({
      date: payment.receivedAt,
      kind: "payment" as const,
      reference: payment.invoiceNumber,
      description: `Payment received, ${payment.invoiceNumber}`,
      amountCents: -payment.amountCents,
      balanceCents: 0,
    })),
  ].sort((a, b) => a.date.getTime() - b.date.getTime());

  let running = input.openingCents;
  for (const entry of entries) {
    running += entry.amountCents;
    entry.balanceCents = running;
  }

  /**
   * What of the closing balance is actually late.
   *
   * Worked out from the invoices rather than the running total: a balance is
   * only overdue to the extent the documents behind it have passed their
   * dates, and a customer who paid last month's bill late but this month's on
   * time owes nothing overdue.
   */
  const overdueCents = input.invoices
    .filter(
      (invoice) =>
        invoice.kind !== "credit_note" &&
        invoice.dueDate !== null &&
        invoice.dueDate < now,
    )
    .reduce((sum, invoice) => sum + invoice.totalCents, 0);

  return {
    contact: input.contact,
    from: input.from,
    to: input.to,
    currency: input.currency,
    openingCents: input.openingCents,
    rows: entries,
    closingCents: running,
    overdueCents: Math.min(Math.max(0, overdueCents), Math.max(0, running)),
  };
}

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    cents / 100,
  );

const day = (value: Date) =>
  value.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

/**
 * The statement as a page.
 *
 * Same plain, script-free HTML as the shared invoice, for the same reason:
 * this is opened by somebody outside the business, often from an email client's
 * own browser, and a total that needs JavaScript is a total that sometimes
 * does not appear.
 */
export function statementPage(
  statement: Statement,
  business: { name: string; address?: string | null },
): string {
  const rows = statement.rows
    .map(
      (row) => `<tr>
      <td>${day(row.date)}</td>
      <td>${esc(row.description)}</td>
      <td class="num">${row.amountCents >= 0 ? money(row.amountCents, statement.currency) : ""}</td>
      <td class="num">${row.amountCents < 0 ? money(-row.amountCents, statement.currency) : ""}</td>
      <td class="num">${money(row.balanceCents, statement.currency)}</td>
    </tr>`,
    )
    .join("");

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Statement for ${esc(statement.contact.name)}</title><style>
:root{color-scheme:light dark}
body{font-family:system-ui,sans-serif;max-width:48rem;margin:3rem auto;padding:0 1.25rem;line-height:1.5}
h1{font-size:1.35rem;margin-bottom:.15rem}
table{width:100%;border-collapse:collapse;margin-top:1.5rem;font-size:.95rem}
th,td{text-align:left;padding:.45rem .35rem;border-bottom:1px solid rgba(128,128,128,.3)}
.num{text-align:right;font-variant-numeric:tabular-nums}
.muted{opacity:.7;font-size:.9rem}
tfoot td{font-weight:600;border-top:1px solid rgba(128,128,128,.5)}
footer{margin-top:3rem;font-size:.85rem;opacity:.7}
</style></head><body>
<h1>Statement of account</h1>
<p class="muted">${esc(statement.contact.name)} &middot; ${day(statement.from)} to ${day(statement.to)}</p>

<table>
  <thead><tr><th>Date</th><th>Detail</th><th class="num">Charged</th><th class="num">Paid</th><th class="num">Balance</th></tr></thead>
  <tbody>
    <tr><td>${day(statement.from)}</td><td class="muted">Balance brought forward</td><td></td><td></td><td class="num">${money(statement.openingCents, statement.currency)}</td></tr>
    ${rows}
  </tbody>
  <tfoot>
    <tr><td colspan="4">Balance owing</td><td class="num">${money(statement.closingCents, statement.currency)}</td></tr>
  </tfoot>
</table>

${
  statement.overdueCents > 0
    ? `<p class="muted">${money(statement.overdueCents, statement.currency)} of this is past its due date.</p>`
    : ""
}

<footer>
  <strong>${esc(business.name)}</strong>
  ${business.address ? `<br>${esc(business.address)}` : ""}
</footer>
</body></html>`;
}

/** Everything before the window, as one figure to open the statement with. */
async function openingBalance(
  orgId: string,
  contactId: string,
  from: Date,
): Promise<number> {
  const earlier = await db
    .select({
      kind: schema.invoices.kind,
      totalCents: schema.invoices.totalCents,
      id: schema.invoices.id,
    })
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.organizationId, orgId),
        eq(schema.invoices.contactId, contactId),
        isNull(schema.invoices.deletedAt),
        inArray(schema.invoices.status, ["open", "partial", "paid"]),
        lte(schema.invoices.issueDate, from),
      ),
    );

  let opening = earlier.reduce(
    (sum, row) =>
      sum + (row.kind === "credit_note" ? -row.totalCents : row.totalCents),
    0,
  );

  if (earlier.length > 0) {
    const paid = await db
      .select({ amountCents: schema.payments.amountCents })
      .from(schema.payments)
      .where(
        and(
          inArray(
            schema.payments.invoiceId,
            earlier.map((row) => row.id),
          ),
          lte(schema.payments.receivedAt, from),
        ),
      );
    opening -= paid.reduce((sum, row) => sum + row.amountCents, 0);
  }
  return opening;
}

export function registerStatements(ctx: ModuleContext) {
  /**
   * 404 rather than 403, matching Subscriptions and the Pro dashboard: on a
   * Free instance this endpoint does not exist. Checked per request rather
   * than at boot, because a licence can arrive or lapse while the process is
   * running.
   *
   * After `requirePermission`, deliberately. Somebody who may not read
   * invoicing at all is refused for that reason first, on Free and Pro alike —
   * a caller must never learn what tier an instance is on by being told a
   * different thing than their permissions warrant.
   */
  const proOnly = defineMiddleware(async (c, next) => {
    if (!ctx.entitled({ tier: "pro" })) return c.notFound();
    await next();
  });

  ctx.app.get(
    "/api/invoicing/statements/:contactId",
    requireSession(),
    requirePermission({ invoicing: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const contactId = c.req.param("contactId") ?? "";

      const [contact] = await db
        .select({
          id: schema.contacts.id,
          name: schema.contacts.name,
          email: schema.contacts.email,
        })
        .from(schema.contacts)
        .where(
          and(
            eq(schema.contacts.id, contactId),
            eq(schema.contacts.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!contact) return c.json({ error: "not found" }, 404);

      /** Ninety days, which is the window somebody asking usually means. */
      const to = c.req.query("to")
        ? new Date(c.req.query("to") as string)
        : new Date();
      const from = c.req.query("from")
        ? new Date(c.req.query("from") as string)
        : new Date(to.getTime() - 90 * 24 * 60 * 60 * 1000);

      const invoices = await db
        .select()
        .from(schema.invoices)
        .where(
          and(
            eq(schema.invoices.organizationId, orgId),
            eq(schema.invoices.contactId, contactId),
            isNull(schema.invoices.deletedAt),
            // Drafts are not on a statement: nobody has been asked for them.
            // Void ones are not either: they were withdrawn.
            inArray(schema.invoices.status, ["open", "partial", "paid"]),
            gte(schema.invoices.issueDate, from),
            lte(schema.invoices.issueDate, to),
          ),
        )
        .orderBy(asc(schema.invoices.issueDate));

      const payments = invoices.length
        ? await db
            .select({
              invoiceId: schema.payments.invoiceId,
              amountCents: schema.payments.amountCents,
              receivedAt: schema.payments.receivedAt,
            })
            .from(schema.payments)
            .where(
              and(
                inArray(
                  schema.payments.invoiceId,
                  invoices.map((row) => row.id),
                ),
                gte(schema.payments.receivedAt, from),
                lte(schema.payments.receivedAt, to),
              ),
            )
        : [];

      const numbers = new Map(invoices.map((row) => [row.id, row.number]));

      const statement = buildStatement({
        contact,
        from,
        to,
        currency: invoices[0]?.currency ?? "USD",
        invoices: invoices.map((row) => ({
          number: row.number,
          kind: row.kind,
          issueDate: row.issueDate,
          dueDate: row.dueDate,
          totalCents: row.totalCents,
        })),
        payments: payments.map((row) => ({
          receivedAt: row.receivedAt,
          amountCents: row.amountCents,
          invoiceNumber: numbers.get(row.invoiceId) ?? "",
        })),
        openingCents: await openingBalance(orgId, contactId, from),
      });

      if (c.req.query("format") === "html") {
        return c.html(statementPage(statement, await businessIdentity(orgId)));
      }
      return c.json({ statement });
    },
  );
}
