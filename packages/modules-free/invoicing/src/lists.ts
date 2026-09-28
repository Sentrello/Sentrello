import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import {
  and,
  db,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  schema,
  sql,
} from "@sentrello/db";
import { contactNames } from "@sentrello/db/crm";
import { periodFrom } from "@sentrello/db/ledger";
import {
  type ListSpec,
  UNPAGED_MAX,
  allConditions,
  capUnpaged,
  countExpression,
  listParams,
  orderByWith,
  pageWindow,
  searchCondition,
} from "@sentrello/db/list-query";
import { invoiceState, sumCents } from "@sentrello/db/money";
import { type ModuleContext, csvDownload, toCsv } from "@sentrello/module-sdk";
import type { SQL } from "drizzle-orm";
import { creditedAgainst } from "./documents";
import { tagsFor } from "./tags";

/**
 * "From this date to that one", with the last day actually in it.
 *
 * Both list routes read `to` as an instant, which for a bare date is
 * midnight — so filtering to the end of a quarter hid every document raised on
 * the quarter's last day, and the list simply looked short. The shared parser
 * in the ledger stretches a bare date to the whole of it, and is the reason
 * every report already gets this right.
 */
function issuedBetween(
  table: typeof schema.invoices | typeof schema.quotes,
  query: Record<string, string | undefined>,
): (SQL | undefined)[] {
  const { from, to } = periodFrom((name) => query[name]);
  return [
    from ? gte(table.issueDate, from) : undefined,
    to ? lte(table.issueDate, to) : undefined,
  ];
}

/**
 * The invoice and quote lists, with everything a real one needs.
 *
 * Both routes used to return every row in the table, unordered — which is
 * fine for the first ten and useless for the first thousand. The reference
 * organises its list by status above everything else, and it is right to: the
 * question somebody opens this screen with is almost always "what is unpaid"
 * or "what is still a draft", not "show me all of them".
 *
 * Statuses that are not columns — overdue, unpaid — are computed here rather
 * than stored, because they depend on today's date. A stored "overdue" flag is
 * a flag that is wrong every morning until something reruns.
 */

const invoiceList: ListSpec = {
  search: [schema.invoices.number, schema.invoices.notes],
  sortable: {
    number: schema.invoices.number,
    issueDate: schema.invoices.issueDate,
    dueDate: schema.invoices.dueDate,
    totalCents: schema.invoices.totalCents,
    status: schema.invoices.status,
    createdAt: schema.invoices.createdAt,
  },
  defaultSort: { field: "issueDate", order: "desc" },
};

const quoteList: ListSpec = {
  search: [schema.quotes.number, schema.quotes.notes],
  sortable: {
    number: schema.quotes.number,
    issueDate: schema.quotes.issueDate,
    validUntil: schema.quotes.validUntil,
    totalCents: schema.quotes.totalCents,
    status: schema.quotes.status,
    createdAt: schema.quotes.createdAt,
  },
  defaultSort: { field: "issueDate", order: "desc" },
};

/**
 * The tabs the list is organised by.
 *
 * `unpaid` is the one a business actually lives in — everything issued and not
 * settled, whether or not it is late yet. `overdue` is the subset of that
 * which has passed its date.
 */
export const INVOICE_TABS = [
  "all",
  "draft",
  "unpaid",
  "overdue",
  "paid",
  "void",
  "credit_notes",
  "deleted",
] as const;

export const QUOTE_TABS = [
  "all",
  "draft",
  "sent",
  "accepted",
  "declined",
  "expired",
  "deleted",
] as const;

/** What a tab means, as a condition. */
function invoiceTab(tab: string, now: Date): (SQL | undefined)[] {
  const live = isNull(schema.invoices.deletedAt);
  const isInvoice = eq(schema.invoices.kind, "invoice");

  switch (tab) {
    case "deleted":
      return [isNotNull(schema.invoices.deletedAt)];
    case "credit_notes":
      return [live, eq(schema.invoices.kind, "credit_note")];
    case "draft":
      return [live, isInvoice, eq(schema.invoices.status, "draft")];
    case "paid":
      // Settled, however it was settled: paid with money, or written off by
      // credit note. A credited invoice with no tab of its own would be one
      // nobody could find again; the status badge says which it was.
      return [
        live,
        isInvoice,
        inArray(schema.invoices.status, ["paid", "credited"]),
      ];
    case "void":
      return [live, isInvoice, eq(schema.invoices.status, "void")];
    case "unpaid":
      // Issued and not settled. A draft is not unpaid — nobody has been asked.
      return [
        live,
        isInvoice,
        inArray(schema.invoices.status, ["open", "partial"]),
      ];
    case "overdue":
      // Strictly past, matching `isOverdue` and so the badge on every screen:
      // at the instant a bill falls due it is due, not late. This read `<=`,
      // which disagreed with the customer's own page by a single instant.
      return [
        live,
        isInvoice,
        inArray(schema.invoices.status, ["open", "partial"]),
        isNotNull(schema.invoices.dueDate),
        lt(schema.invoices.dueDate, now),
      ];
    default:
      // "All" still hides what was deleted and what is a credit note: both
      // have their own tab, and mixing credits into the list makes the totals
      // across the top read as less money than the business actually billed.
      return [live, isInvoice];
  }
}

function quoteTab(tab: string, now: Date): (SQL | undefined)[] {
  const live = isNull(schema.quotes.deletedAt);
  switch (tab) {
    case "deleted":
      return [isNotNull(schema.quotes.deletedAt)];
    case "expired":
      // Not a stored status: it depends on today, so storing it would be
      // wrong every morning until something reran.
      return [
        live,
        inArray(schema.quotes.status, ["draft", "sent"]),
        isNotNull(schema.quotes.validUntil),
        lte(schema.quotes.validUntil, now),
      ];
    case "draft":
    case "sent":
    case "accepted":
    case "declined":
      return [live, eq(schema.quotes.status, tab)];
    default:
      return [live];
  }
}

export function registerLists(ctx: ModuleContext) {
  /**
   * The list as a spreadsheet.
   *
   * The same filters the screen is showing, because an export that quietly
   * ignored them would hand somebody the whole table when they had asked for
   * nine rows, with nothing on screen to say so — the mistake the CRM's
   * exports were fixed for.
   *
   * Names rather than ids: a spreadsheet full of uuids is not something
   * anybody can read, edit, or take to their accountant.
   */
  for (const kind of ["invoices", "quotes"] as const) {
    ctx.app.get(
      `/api/${kind}/export.csv`,
      requireSession(),
      requirePermission({ invoicing: ["read"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const query = c.req.query();
        const now = new Date();
        const table = kind === "invoices" ? schema.invoices : schema.quotes;

        const where = allConditions([
          eq(table.organizationId, orgId),
          searchCondition(
            kind === "invoices" ? invoiceList : quoteList,
            listParams(query).q,
          ),
          ...(kind === "invoices"
            ? invoiceTab(query.tab ?? "all", now)
            : quoteTab(query.tab ?? "all", now)),
          query.contactId ? eq(table.contactId, query.contactId) : undefined,
          // A bare "to" date means the whole of that day: read as midnight,
          // the filter hid everything raised on the last day it named.
          ...issuedBetween(table, query),
        ]);

        const [rows, contacts] = await Promise.all([
          db
            .select()
            .from(table)
            .where(where)
            .orderBy(
              ...orderByWith(
                kind === "invoices" ? invoiceList : quoteList,
                listParams(query),
                table.id,
              ),
            ),
          db
            .select({ id: schema.contacts.id, name: schema.contacts.name })
            .from(schema.contacts)
            .where(eq(schema.contacts.organizationId, orgId)),
        ]);
        const customerName = new Map(contacts.map((r) => [r.id, r.name]));

        const money = (c1: number) => (c1 / 100).toFixed(2);
        const day = (value: Date | string | null) =>
          value ? new Date(value).toISOString().slice(0, 10) : "";

        const csv = toCsv(
          [
            "Number",
            "Status",
            "Customer",
            "Issued",
            kind === "invoices" ? "Due" : "Valid until",
            "Currency",
            "Subtotal",
            "Discount",
            "Tax",
            "Total",
          ],
          rows.map((r) => [
            r.number,
            r.status,
            r.contactId ? (customerName.get(r.contactId) ?? "") : "",
            day(r.issueDate),
            day(
              kind === "invoices"
                ? (r as typeof schema.invoices.$inferSelect).dueDate
                : (r as typeof schema.quotes.$inferSelect).validUntil,
            ),
            r.currency,
            money(r.subtotalCents),
            money(r.discountCents),
            money(r.taxCents),
            money(r.totalCents),
          ]),
        );
        return c.body(csv, 200, csvDownload(`${kind}.csv`));
      },
    );
  }

  ctx.app.get(
    "/api/invoices",
    requireSession(),
    requirePermission({ invoicing: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const query = c.req.query();
      const params = listParams(query);
      const now = new Date();

      const where = allConditions([
        eq(schema.invoices.organizationId, orgId),
        searchCondition(invoiceList, params.q),
        ...invoiceTab(query.tab ?? "all", now),
        query.contactId
          ? eq(schema.invoices.contactId, query.contactId)
          : undefined,
        // Narrowed to one label, the way the CRM's lists are. A subquery
        // rather than a join so the row shape and the count stay as they were.
        query.tagId
          ? inArray(
              schema.invoices.id,
              db
                .select({ id: schema.taggables.entityId })
                .from(schema.taggables)
                .where(
                  and(
                    eq(schema.taggables.tagId, query.tagId),
                    eq(schema.taggables.entityType, "invoice"),
                  ),
                ),
            )
          : undefined,
        ...issuedBetween(schema.invoices, query),
      ]);

      const window = pageWindow(params);
      // Unpaged is capped: a caller that never mentioned paging gets a long
      // list rather than the whole book, and one more row than the ceiling is
      // how it knows to say so.
      const found = await db
        .select()
        .from(schema.invoices)
        .where(where)
        .orderBy(...orderByWith(invoiceList, params, schema.invoices.id))
        .limit(window ? window.limit : UNPAGED_MAX + 1)
        .offset(window ? window.offset : 0);
      const { rows, truncated } = window
        ? { rows: found, truncated: false }
        : capUnpaged(found);

      /**
       * What is actually owed, per invoice.
       *
       * One query for the page rather than one per row, and read from the
       * payments rather than from a stored figure — a total that is kept in
       * two places is a total that eventually disagrees with itself.
       */
      const ids = rows.map((r) => r.id);
      // One query for the page's labels, not one per row.
      const labels = await tagsFor(orgId, "invoice", ids);
      /*
       * And one for the page's customer names. The screen used to fetch every
       * contact the business has and look them up in the browser, which stops
       * working — silently, and always for the same people — the moment there
       * are more contacts than an unpaged list will return.
       */
      const customers = await contactNames(
        orgId,
        rows.map((r) => r.contactId),
      );
      const paid = new Map<string, number>();
      if (ids.length > 0) {
        const sums = await db
          .select({
            invoiceId: schema.payments.invoiceId,
            total: sumCents(schema.payments.amountCents),
          })
          .from(schema.payments)
          .where(inArray(schema.payments.invoiceId, ids))
          .groupBy(schema.payments.invoiceId);
        for (const s of sums) paid.set(s.invoiceId, s.total);
      }
      // Credits settle debt the way payments do: the balance column must
      // not show money the customer was already credited back.
      const credited = await creditedAgainst(orgId, ids);

      const [counted] = window
        ? await db
            .select({ total: countExpression })
            .from(schema.invoices)
            .where(where)
        : [{ total: rows.length }];

      /** The figures across the top of the screen, for this tab. */
      const [totals] = await db
        .select({
          totalCents: sumCents(schema.invoices.totalCents),
        })
        .from(schema.invoices)
        .where(where);

      return c.json({
        invoices: rows.map((r) => {
          const paidCents = paid.get(r.id) ?? 0;
          const creditedCents = credited.get(r.id) ?? 0;
          /**
           * The state, the balance and whether it is late, from one call.
           *
           * The column filtered this query and the column is what it stays
           * for — deriving the status in SQL would mean a correlated subquery
           * over payments and credit notes for every row of every tab. But
           * the rows are in hand here, with their payments and their credits
           * already loaded, so what the screen *says* costs nothing to derive
           * and is never a second opinion about the same invoice.
           *
           * A draft owes nothing and neither does a void: nobody has been
           * asked for either, and the figure at the top of the screen is the
           * one people quote to their accountant. `invoiceState` keeps that.
           */
          const { status, balanceDue, badge } = invoiceState(
            r,
            paidCents,
            creditedCents,
            now,
          );
          return {
            ...r,
            status,
            contactName: r.contactId
              ? (customers.get(r.contactId) ?? null)
              : null,
            tags: labels.get(r.id) ?? [],
            paidCents,
            creditedCents,
            balanceCents: balanceDue,
            // Computed, not stored: it depends on today.
            overdue: badge === "overdue",
          };
        }),
        total: counted?.total ?? 0,
        billedCents: totals?.totalCents ?? 0,
        ...(truncated ? { truncated: true } : {}),
        ...(window ? { page: params.page, perPage: params.perPage } : {}),
      });
    },
  );

  ctx.app.get(
    "/api/quotes",
    requireSession(),
    requirePermission({ invoicing: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const query = c.req.query();
      const params = listParams(query);
      const now = new Date();

      const where = allConditions([
        eq(schema.quotes.organizationId, orgId),
        searchCondition(quoteList, params.q),
        ...quoteTab(query.tab ?? "all", now),
        query.contactId
          ? eq(schema.quotes.contactId, query.contactId)
          : undefined,
      ]);

      const window = pageWindow(params);
      // Unpaged is capped: a caller that never mentioned paging gets a long
      // list rather than the whole book, and one more row than the ceiling is
      // how it knows to say so.
      const found = await db
        .select()
        .from(schema.quotes)
        .where(where)
        .orderBy(...orderByWith(quoteList, params, schema.quotes.id))
        .limit(window ? window.limit : UNPAGED_MAX + 1)
        .offset(window ? window.offset : 0);
      const { rows, truncated } = window
        ? { rows: found, truncated: false }
        : capUnpaged(found);

      const [counted] = window
        ? await db
            .select({ total: countExpression })
            .from(schema.quotes)
            .where(where)
        : [{ total: rows.length }];

      // The page's customer names, for the reason the invoice list above has
      // them: a screen that looked them up out of the whole contacts table
      // showed nothing at all past the unpaged ceiling.
      const customers = await contactNames(
        orgId,
        rows.map((r) => r.contactId),
      );

      return c.json({
        quotes: rows.map((r) => ({
          ...r,
          contactName: r.contactId
            ? (customers.get(r.contactId) ?? null)
            : null,
          expired:
            (r.status === "draft" || r.status === "sent") &&
            !!r.validUntil &&
            new Date(r.validUntil) < now,
        })),
        total: counted?.total ?? 0,
        ...(window ? { page: params.page, perPage: params.perPage } : {}),
      });
    },
  );

  /**
   * How many are in each tab, so the tab strip can say so.
   *
   * The reference puts a count on every tab and it is the thing that makes the
   * screen useful at a glance: "eleven unpaid, three overdue" is the state of
   * the business, and it should not need eight clicks to find out.
   */
  ctx.app.get(
    "/api/invoices/counts",
    requireSession(),
    requirePermission({ invoicing: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const now = new Date();
      const counts: Record<string, number> = {};
      for (const tab of INVOICE_TABS) {
        const [row] = await db
          .select({ total: countExpression })
          .from(schema.invoices)
          .where(
            allConditions([
              eq(schema.invoices.organizationId, orgId),
              ...invoiceTab(tab, now),
            ]),
          );
        counts[tab] = row?.total ?? 0;
      }
      return c.json({ counts });
    },
  );

  ctx.app.get(
    "/api/quotes/counts",
    requireSession(),
    requirePermission({ invoicing: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const now = new Date();
      const counts: Record<string, number> = {};
      for (const tab of QUOTE_TABS) {
        const [row] = await db
          .select({ total: countExpression })
          .from(schema.quotes)
          .where(
            allConditions([
              eq(schema.quotes.organizationId, orgId),
              ...quoteTab(tab, now),
            ]),
          );
        counts[tab] = row?.total ?? 0;
      }
      return c.json({ counts });
    },
  );

  /**
   * Filing a document away.
   *
   * Never a delete: a document somebody sent is a thing that happened, and the
   * number it used must stay used. It goes to the "deleted" tab, where it can
   * be read and put back.
   */
  for (const kind of ["invoices", "quotes"] as const) {
    const table = kind === "invoices" ? schema.invoices : schema.quotes;

    ctx.app.delete(
      `/api/${kind}/:id`,
      requireSession(),
      requirePermission({ invoicing: ["delete"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const [row] = await db
          .update(table)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(table.id, c.req.param("id")),
              eq(table.organizationId, orgId),
              isNull(table.deletedAt),
            ),
          )
          .returning();
        if (!row) return c.json({ error: "not found" }, 404);
        return c.json({ deleted: row.id });
      },
    );

    ctx.app.post(
      `/api/${kind}/:id/restore`,
      requireSession(),
      requirePermission({ invoicing: ["delete"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const [row] = await db
          .update(table)
          .set({ deletedAt: null, updatedAt: new Date() })
          .where(
            and(
              eq(table.id, c.req.param("id")),
              eq(table.organizationId, orgId),
            ),
          )
          .returning();
        if (!row) return c.json({ error: "not found" }, 404);
        return c.json({ restored: row.id });
      },
    );
  }
}
