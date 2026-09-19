import accounting from "@sentrello/module-accounting";
import invoicing from "@sentrello/module-invoicing";
import type { ModuleContext } from "@sentrello/module-sdk";
import { defineModule } from "@sentrello/module-sdk";

/** The shape `registerNav` takes, which the SDK declares inline. */
type NavEntry = Parameters<ModuleContext["registerNav"]>[0];

/**
 * Money: everything a business does with it.
 *
 * Quotes, invoices, what is owed, what is owned, the ledger underneath and the
 * returns that come out of it. These were two modules and one subject, and the
 * split was ours rather than the business's — a person chasing an unpaid invoice
 * and a person reconciling the bank are doing two halves of the same job, and
 * nobody thinks of them as different applications.
 *
 * **It is an arrangement, not a rewrite.** Both halves keep their own package,
 * their own routes and their own tests; this registers them together under one
 * name. That matters beyond tidiness: the free and the paid parts of each half
 * are already decided per request, and a merge that moved code would have had to
 * re-decide every one of those.
 *
 * Nothing about the data moves. Neither half ever owned a migration — every
 * table is the platform's — so this is a name and a menu, and no instance has
 * anything to migrate.
 */

/** The one entry the rail hangs the module on. */
const HEAD = "money";

/**
 * Everything else becomes a page of it.
 *
 * The panel finds a module by the entry whose id *is* the module id. Without
 * a head, the icon and the label would be whichever page happened to sort
 * first — Quotes, as it happens, at order 19.
 *
 * So each half's own entries are given `parent: "money"` as they are registered,
 * which is why this wraps the context rather than editing either package: their
 * nav is theirs, and a module that reached in to rewrite another's would be a
 * module that breaks when the other one is tidied.
 *
 * **Their ids are untouched.** A nav id is the address in the browser, so the
 * pages somebody has bookmarked are the pages they had.
 */
/**
 * Money's panel: which heading each page sits under, and in what order.
 *
 * Sixteen screens in one list said nothing about what belongs with what. A
 * business does not look for "the eleventh item" — it looks for the bit where
 * it chases an invoice, or the bit where it reconciles the bank. These are
 * those bits, named the way the work is named rather than the way the modules
 * were once split.
 *
 * **The order is stated here rather than inherited.** The numbers begin above
 * the head's own 18.8 and the dashboard's 18.9, so the module still leads with
 * itself; below them and Money sorted after its own pages.
 *
 * Original note: Each half numbered its
 * own pages for a world where it had its own menu — invoicing around 20, the
 * books around 30 — and read as one list that put the tax returns second,
 * between the invoices and the bank. Two pages even shared 20.5, so their
 * relative position was whatever the sort did that run. Money is the thing
 * that arranges these two packages, so the arrangement belongs to Money.
 *
 * **Only the pages that come through here.** This wraps invoicing and
 * accounting, the two packages Money composes. The paid half ships as
 * `pro-accounting`, which the loader registers beside Money rather than
 * through it, so nothing written here can reach those seven pages — they name
 * their own sections, in the same words, and `pro-accounting/src/nav.test.ts`
 * pins the full set of headings so the two halves cannot drift apart.
 *
 * Keyed by nav id, and deliberately not exhaustive: a page nobody has placed
 * keeps its own order and gets no heading, so it renders at the top with the
 * dashboard — visible, and obviously unplaced. The alternative, a default
 * section, would quietly file new screens somewhere nobody chose.
 */
const SECTIONS: Record<string, { section: string; order: number }> = {
  // What the business is owed, and the paperwork that asks for it.
  quotes: { section: "Getting paid", order: 19 },
  invoicing: { section: "Getting paid", order: 19.1 },
  "invoicing-settings": { section: "Getting paid", order: 19.3 },

  // What it owes, and what it has spent.
  "accounting-money": { section: "Spending", order: 20.1 },

  // Where the money actually is.
  "accounting-accounts": { section: "Banking", order: 21.1 },

  // The record underneath all of it.
  accounting: { section: "The books", order: 22 },
  "accounting-summary": { section: "The books", order: 22.1 },
  "accounting-journal": { section: "The books", order: 22.2 },

  // What is expected, and what is owned.

  /*
   * What has to be declared, and to whom.
   *
   * Last, and its own heading. A return is a deliberate act with a legal
   * declaration attached, and somebody looking for one on a quarter-end
   * deadline should find a heading rather than read down a list of sixteen.
   * They sat second before this, between the invoices and the bank, because
   * one of them happened to be numbered 20.5.
   */
  "invoicing-us-tax": { section: "Tax", order: 24 },
  "invoicing-oss": { section: "Tax", order: 24.1 },
  "accounting-vat": { section: "Tax", order: 24.2 },
  "accounting-ca-tax": { section: "Tax", order: 24.3 },
};

/**
 * Where a page sits, or nothing at all if nobody has placed it.
 *
 * An entry that named its own section wins: this table arranges two packages it
 * does not own, and a package that grows a view about its own menu should keep
 * it rather than be silently overruled from here.
 */
function headingFor(entry: NavEntry): { section?: string; order?: number } {
  if (entry.section) return {};
  return SECTIONS[entry.id] ?? {};
}

function asPagesOfMoney(ctx: ModuleContext): ModuleContext {
  return {
    ...ctx,
    registerNav: (entry: NavEntry) => {
      // The head itself, and anything already declared a page of it.
      if (entry.id === HEAD || entry.parent === HEAD) {
        ctx.registerNav(
          entry.id === HEAD ? entry : { ...entry, ...headingFor(entry) },
        );
        return;
      }

      /*
       * Accounting's own pages come up a level with it.
       *
       * They were the pages of a module and are now the pages of half of one,
       * which would have hung a page off a page — one level below anything
       * the panel draws. Eleven screens vanished from the menu that way: the
       * routes answered, the pages rendered, and there was no longer
       * anything to click. Found by opening it rather than by any test,
       * because every test here asks whether a nav entry has a screen and
       * none asks whether a person can reach it.
       *
       * They keep their order, so they still arrive together and after the
       * Accounting entry they used to hang from. No `group` — the sidebar draws
       * those at the top level only, and setting one here would be a field that
       * looks like it does something and does not.
       */
      if (entry.parent && entry.parent !== HEAD) {
        ctx.registerNav({ ...entry, parent: HEAD, ...headingFor(entry) });
        return;
      }

      ctx.registerNav({ ...entry, parent: HEAD, ...headingFor(entry) });
    },
  };
}

export default defineModule({
  id: HEAD,
  tier: "free",
  register(ctx) {
    ctx.registerNav({
      // Written out rather than as the constant: the guard that checks every
      // nav entry has a screen behind it reads these files as text, and a
      // computed id is an entry it cannot see. Mine was invisible to it.
      id: "money",
      icon: "wallet",
      label: "Money",
      // Before both halves, so the module lands on its own summary rather than
      // on whichever page sorts first.
      order: 18.8,
      group: "Money",
      /*
       * Readable by anybody who can read either half. The books are not
       * everybody's business and neither is the sales ledger, but a person with
       * one of them has to be able to reach the module that contains it.
       */
      requires: { invoicing: ["read"] },
    });

    const pages = asPagesOfMoney(ctx);
    invoicing.register(pages);
    accounting.register(pages);
  },
});
