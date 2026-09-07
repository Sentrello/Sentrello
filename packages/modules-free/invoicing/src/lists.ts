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
  lte,
  schema,
  sql,
} from "@sentrello/db";
import {
  type ListSpec,
  allConditions,
  countExpression,
  listParams,
  orderBy,
  pageWindow,
  searchCondition,
} from "@sentrello/db/list-query";
import { type ModuleContext, csvDownload, toCsv } from "@sentrello/module-sdk";
import type { SQL } from "drizzle-orm";
import { tagsFor } from "./tags";

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
      return [live, isInvoice, eq(schema.invoices.status, "paid")];
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
      return [
        live,
        isInvoice,
        inArray(schema.invoices.status, ["open", "partial"]),
        isNotNull(schema.invoices.dueDate),
        lte(schema.invoices.dueDate, now),
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
          query.from ? gte(table.issueDate, new Date(query.from)) : undefined,
          query.to ? lte(table.issueDate, new Date(query.to)) : undefined,
        ]);

        const [rows, contacts] = await Promise.all([
          db
            .select()
            .from(table)
            .where(where)
            .orderBy(
              orderBy(
                kind === "invoices" ? invoiceList : quoteList,
                listParams(query),
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
        query.from
          ? gte(schema.invoices.issueDate, new Date(query.from))
          : undefined,
        query.to
          ? lte(schema.invoices.issueDate, new Date(query.to))
          : undefined,
      ]);

      const window = pageWindow(params);
      const rows = await (window
        ? db
            .select()
            .from(schema.invoices)
            .where(where)
            .orderBy(orderBy(invoiceList, params))
            .limit(window.limit)
            .offset(window.offset)
        : db
            .select()
            .from(schema.invoices)
            .where(where)
            .orderBy(orderBy(invoiceList, params)));

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
      const paid = new Map<string, number>();
      if (ids.length > 0) {
        const sums = await db
          .select({
            invoiceId: schema.payments.invoiceId,
            total: sql<number>`coalesce(sum(${schema.payments.amountCents}), 0)::int`,
          })
          .from(schema.payments)
          .where(inArray(schema.payments.invoiceId, ids))
          .groupBy(schema.payments.invoiceId);
        for (const s of sums) paid.set(s.invoiceId, s.total);
      }

      const [counted] = window
        ? await db
            .select({ total: countExpression })
            .from(schema.invoices)
            .where(where)
        : [{ total: rows.length }];

      /** The figures across the top of the screen, for this tab. */
      const [totals] = await db
        .select({
          totalCents: sql<number>`coalesce(sum(${schema.invoices.totalCents}), 0)::int`,
        })
        .from(schema.invoices)
        .where(where);

      return c.json({
        invoices: rows.map((r) => {
          const paidCents = paid.get(r.id) ?? 0;
          /**
           * A draft owes nothing, and neither does a void.
           *
           * Nobody has been asked for a draft, so showing its total as
           * outstanding puts money in the "owed" column that the business has
           * no claim to — and the figure at the top of the screen is the one
           * people quote to their accountant.
           */
          const claimable = r.status !== "draft" && r.status !== "void";
          return {
            ...r,
            tags: labels.get(r.id) ?? [],
            paidCents,
            balanceCents: claimable ? Math.max(0, r.totalCents - paidCents) : 0,
            // Computed, not stored: it depends on today.
            overdue:
              r.status !== "paid" &&
              r.status !== "void" &&
              r.status !== "draft" &&
              !!r.dueDate &&
              new Date(r.dueDate) < now,
          };
        }),
        total: counted?.total ?? 0,
        billedCents: totals?.totalCents ?? 0,
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
      const rows = await (window
        ? db
            .select()
            .from(schema.quotes)
            .where(where)
            .orderBy(orderBy(quoteList, params))
            .limit(window.limit)
            .offset(window.offset)
        : db
            .select()
            .from(schema.quotes)
            .where(where)
            .orderBy(orderBy(quoteList, params)));

      const [counted] = window
        ? await db
            .select({ total: countExpression })
            .from(schema.quotes)
            .where(where)
        : [{ total: rows.length }];

      return c.json({
        quotes: rows.map((r) => ({
          ...r,
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
