import {
  activeOrganizationId,
  mayAccess,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import {
  and,
  asc,
  db,
  desc,
  eq,
  gte,
  inArray,
  lte,
  schema,
  sql,
} from "@sentrello/db";
import {
  allConditions,
  countExpression,
  listParams,
  searchCondition,
} from "@sentrello/db/list-query";
import type { ListSpec } from "@sentrello/db/list-query";
import { defineModule } from "@sentrello/module-sdk";
import { registerCaReturns } from "./ca-returns";
import { registerChart } from "./chart";
import { registerFxRevaluation } from "./fx-revaluation";
import { registerMtd } from "./mtd-routes";
import { registerPeriodLock } from "./period";
import { registerReceipts } from "./receipts";
import { registerReports } from "./reports";
import { registerAccountingSummary } from "./summary";
import { registerTransactions } from "./transactions";
import { registerVatScheme } from "./vat-scheme";

/**
 * Accounting — the books, and everything that posts into them.
 *
 * The Free half is what a business genuinely cannot do without: a chart of
 * accounts, money in and money out, and the two statements everybody is asked
 * for. The Pro half — bills and vendors, bank accounts and reconciliation,
 * budgets, multi-currency, dimensions, custom fields, the manual journal entry
 * and the rest of the report set — lives in `pro-accounting`, a bundle in the
 * commercial repository, and hangs off the same ledger and the same nav entry
 * so there is one place a customer looks and the licence decides how far it
 * goes. Nothing in this package gates a route behind `entitled({ tier: "pro"
 * })` any more; the one check left below decides what a screen *offers*, not
 * what the instance *answers* — the bundle's own `proOnly` middleware is what
 * actually refuses a request, and it is not here to refuse. The paid pages'
 * nav entries live with the bundle too, beside the screens they open.
 *
 * The permission resource stays `bookkeeping`. It is on every role a business
 * has already saved, and renaming it would lock people out of the module it
 * was meant to describe better.
 */
/**
 * What the journal can be asked for.
 *
 * The ledger is the one list where a business arrives knowing what it is
 * looking for — a figure it has to explain, on a date, against an account —
 * and until now the screen offered a page number and nothing else. Every
 * other list screen has had search, filters and a sort for months; this one
 * was skipped because it pages over entries and renders lines, and that made
 * it look like a different kind of list. It is not.
 *
 * Only `postedAt` is sortable, deliberately. An entry has no other column a
 * reader would order books by — a ledger sorted by memo is not a ledger — and
 * the page is taken over entries, so a sort on anything belonging to a line
 * would not be a stable order at all.
 */
const JOURNAL: ListSpec = {
  search: [schema.journalEntries.memo, schema.journalEntries.source],
  sortable: { postedAt: schema.journalEntries.postedAt },
  defaultSort: { field: "postedAt", order: "desc" },
};

/** A day, as the browser sends it, or nothing if it sent something else. */
function day(raw: string | undefined): Date | undefined {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** Everything the request asked to narrow the ledger by. */
function journalWhere(
  orgId: string,
  params: ReturnType<typeof listParams>,
  query: Record<string, string | undefined>,
) {
  const from = day(query.from);
  const to = day(query.to);
  const accountId = query.accountId?.trim();

  return allConditions([
    eq(schema.journalEntries.organizationId, orgId),
    searchCondition(JOURNAL, params.q),
    from ? gte(schema.journalEntries.postedAt, from) : undefined,
    /*
     * To the end of the day named, not to its first instant.
     *
     * `postedAt` is a timestamp and the filter is a date, so `lte(postedAt,
     * 2026-03-31)` excludes everything posted on the 31st — which is every
     * entry a quarter-end actually turns on.
     */
    to
      ? lte(
          schema.journalEntries.postedAt,
          new Date(to.getTime() + 24 * 60 * 60 * 1000 - 1),
        )
      : undefined,
    /*
     * Entries touching one account, without joining to its lines.
     *
     * A join here would return one row per matching line and break both the
     * page window and the count — an entry with two lines on the account
     * would take two of the twenty-five places and be counted twice.
     *
     * `journal_lines` carries no `organizationId` of its own: a line is
     * scoped through the entry it belongs to, and the entry is filtered by
     * organization in the same condition list. An account id from another
     * organization matches nothing rather than leaking, because no line of
     * this organization's entries can reference it.
     */
    accountId
      ? sql`exists (select 1 from ${schema.journalLines} where ${schema.journalLines.entryId} = ${schema.journalEntries.id} and ${schema.journalLines.accountId} = ${accountId})`
      : undefined,
  ]);
}

/**
 * The order, with the tiebreaker kept.
 *
 * Two entries posted in the same instant must not swap places between page
 * one and page two — that hides a row from whoever is reading — so the id
 * follows the date in whichever direction the date is going.
 */
function journalOrder(params: ReturnType<typeof listParams>) {
  const ascending = params.sort === "postedAt" ? params.order === "asc" : false;
  return ascending
    ? [asc(schema.journalEntries.postedAt), asc(schema.journalEntries.id)]
    : [desc(schema.journalEntries.postedAt), desc(schema.journalEntries.id)];
}

export default defineModule({
  id: "accounting",
  tier: "free",
  register(ctx) {
    registerMtd(ctx);
    registerVatScheme(ctx);
    registerCaReturns(ctx);
    ctx.registerNav({
      id: "accounting",
      icon: "wallet",
      label: "Accounting",
      order: 30,
      group: "Money",
      // The books are not everybody's business, and the routes behind this
      // already say so.
      requires: { bookkeeping: ["read"] },
    });

    /**
     * Its pages, as pages.
     *
     * As tabs the module had nothing to put in the sidebar's second level; as
     * pages the rail says what is there. Only the Free half's pages are here:
     * the paid half's — bills, banking, budgets, assets, the Pro reports, tax
     * and currency — are registered by `pro-accounting`, the bundle that also
     * draws their screens, so on a Free instance the doors are absent along
     * with the routes behind them.
     */
    for (const page of [
      { id: "accounting-summary", label: "Summary", icon: "gauge" },
      { id: "accounting-money", label: "Money in and out", icon: "wallet" },
      { id: "accounting-accounts", label: "Accounts", icon: "boxes" },
      { id: "accounting-journal", label: "Journal", icon: "file-text" },
      /*
       * Its own page rather than a panel on the reports screen. Filing a VAT
       * return is a deliberate act with a legal declaration attached, and a
       * business looking for it on a quarter-end deadline should not be hunting
       * through a report.
       */
      { id: "accounting-vat", label: "VAT return", icon: "landmark" },
      /*
       * Canada's returns share the VAT return's reasoning — a deadline, a
       * legal declaration, and no appetite for hunting — but not its form:
       * one business may owe the CRA, Revenu Québec and a province, and
       * the page shows one card per authority its rates call for.
       */
      { id: "accounting-ca-tax", label: "Canadian tax", icon: "landmark" },
    ].entries()) {
      ctx.registerNav({
        ...page[1],
        /**
         * Beside its own parent, not at the front of everything.
         *
         * `order` sorts the whole nav, not each module's pages. Numbering
         * these 1..4 put them among the CRM's, which uses the same small
         * numbers — so they take fractions of the parent's own order and stay
         * where they belong.
         */
        order: 30 + (page[0] + 1) / 100,
        parent: "accounting",
        group: "Money",
        requires: { bookkeeping: ["read"] },
      });
    }

    for (const p of ["read", "create", "update", "delete"]) {
      ctx.registerPermission(`bookkeeping:${p}`);
    }
    ctx.registerPermission("reports:read");

    registerChart(ctx);
    registerTransactions(ctx);
    registerReports(ctx);
    registerAccountingSummary(ctx);
    registerReceipts(ctx);
    registerPeriodLock(ctx);
    registerFxRevaluation(ctx);

    /**
     * The journal itself.
     *
     * Almost every line arrives through `postJournalEntry` from whatever
     * recorded the event, so the books mostly cannot hold a figure no document
     * explains. The exception is the adjusting entry an accountant posts by
     * hand, which lives in the Pro half and is marked as such in its source.
     */
    ctx.app.get(
      "/api/journal",
      requireSession(),
      requirePermission({ bookkeeping: ["read"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        /*
         * A page of entries, not a page of lines.
         *
         * This route returned every line the business had ever posted, joined
         * to accounts and users, with no limit of any kind. At five years of
         * trading that is 1.19 million rows: a 356 MB response, four seconds,
         * and 3.9 GB of resident memory for one request — a denial of service
         * a customer performs on themselves by opening a menu. No browser
         * renders it and no self-hosted box survives it.
         *
         * The page is taken over `journal_entries` and the lines then fetched
         * for those entries, because the screen groups lines back into
         * entries: a limit on the lines would cut an entry in half and show a
         * reader books that do not balance. Ordered by `postedAt` and then by
         * id, so two entries posted in the same instant cannot swap places
         * between page one and page two and hide a row.
         */
        const params = listParams(c.req.query());
        const page = params.page ?? 1;
        const where = journalWhere(orgId, params, c.req.query());
        const [entries, [counted]] = await Promise.all([
          db
            .select({ id: schema.journalEntries.id })
            .from(schema.journalEntries)
            .where(where)
            .orderBy(...journalOrder(params))
            .limit(params.perPage)
            .offset((page - 1) * params.perPage),
          db
            .select({ total: countExpression })
            .from(schema.journalEntries)
            .where(where),
        ]);
        const ids = entries.map((e) => e.id);

        const rows =
          ids.length === 0
            ? []
            : await db
                .select({
                  id: schema.journalEntries.id,
                  memo: schema.journalEntries.memo,
                  source: schema.journalEntries.source,
                  postedAt: schema.journalEntries.postedAt,
                  /**
                   * Who put the figure in the books, where a person did.
                   *
                   * Null for everything a job or a webhook wrote, which is most of
                   * the ledger. The name rather than the id: an audit trail showing
                   * user ids is one somebody has to look up line by line.
                   */
                  postedBy: schema.user.name,
                  postedById: schema.journalEntries.createdBy,
                  debitCents: schema.journalLines.debitCents,
                  creditCents: schema.journalLines.creditCents,
                  accountId: schema.journalLines.accountId,
                  accountCode: schema.accounts.code,
                  accountName: schema.accounts.name,
                })
                .from(schema.journalEntries)
                .innerJoin(
                  schema.journalLines,
                  eq(schema.journalLines.entryId, schema.journalEntries.id),
                )
                .leftJoin(
                  schema.accounts,
                  and(
                    eq(schema.journalLines.accountId, schema.accounts.id),
                    eq(schema.accounts.organizationId, orgId),
                  ),
                )
                .leftJoin(
                  schema.user,
                  eq(schema.user.id, schema.journalEntries.createdBy),
                )
                .where(and(where, inArray(schema.journalEntries.id, ids)))
                // The same order as the page above it, so an ascending page
                // is not rendered descending inside itself.
                .orderBy(...journalOrder(params));

        /**
         * Whether this person can post one by hand, answered here.
         *
         * Two things have to be true — the instance is Pro, and this person
         * may create — and the browser can check neither without a second copy
         * of both rules. A control that answers 403 or 404 is worse than no
         * control.
         */
        const mayPost =
          ctx.entitled({ tier: "pro" }) &&
          (await mayAccess(c.req.raw.headers, { bookkeeping: ["create"] }));

        return c.json({
          lines: rows,
          mayPost,
          // Entries, not lines: it is what the screen counts and what its
          // pager divides by.
          total: counted?.total ?? 0,
          page,
          perPage: params.perPage,
        });
      },
    );
  },
});
