import {
  activeOrganizationId,
  mayAccess,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, desc, eq, schema } from "@sentrello/db";
import { defineModule } from "@sentrello/module-sdk";
import { registerCaReturns } from "./ca-returns";
import { registerChart } from "./chart";
import { registerFxRevaluation } from "./fx-revaluation";
import { registerMtd } from "./mtd-routes";
import { registerPeriodLock } from "./period";
import { registerReceipts } from "./receipts";
import { registerReports } from "./reports";
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
        const rows = await db
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
          .where(eq(schema.journalEntries.organizationId, orgId))
          .orderBy(desc(schema.journalEntries.postedAt));

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

        return c.json({ lines: rows, mayPost });
      },
    );
  },
});
