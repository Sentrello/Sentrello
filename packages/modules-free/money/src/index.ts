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
 * The rail shows one icon per module and finds it by the entry whose id *is* the
 * module id. Without a head, the icon and the label would be whichever page
 * happened to sort first — Quotes, as it happens, at order 19.
 *
 * So each half's own entries are given `parent: "money"` as they are registered,
 * which is why this wraps the context rather than editing either package: their
 * nav is theirs, and a module that reached in to rewrite another's would be a
 * module that breaks when the other one is tidied.
 *
 * **Their ids are untouched.** A nav id is the address in the browser, so the
 * pages somebody has bookmarked are the pages they had.
 */
function asPagesOfMoney(ctx: ModuleContext): ModuleContext {
  return {
    ...ctx,
    registerNav: (entry: NavEntry) => {
      // The head itself, and anything already declared a page of it.
      if (entry.id === HEAD || entry.parent === HEAD) {
        ctx.registerNav(entry);
        return;
      }

      /*
       * Accounting's own pages come up a level with it.
       *
       * They were the pages of a module and are now the pages of half of one,
       * which would put them three deep — and the sidebar draws two. Eleven
       * screens vanished from the menu that way: the routes answered, the
       * pages rendered, and there was no longer anything to click. Found by
       * opening it rather than by any test, because every test here asks
       * whether a nav entry has a screen and none asks whether a person can
       * reach it.
       *
       * They keep their order, so they still arrive together and after the
       * Accounting entry they used to hang from. No `group` — the sidebar draws
       * those at the top level only, and setting one here would be a field that
       * looks like it does something and does not.
       */
      if (entry.parent && entry.parent !== HEAD) {
        ctx.registerNav({ ...entry, parent: HEAD });
        return;
      }

      ctx.registerNav({ ...entry, parent: HEAD });
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
