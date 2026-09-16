import {
  activeOrganizationId,
  mayAccess,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, schema } from "@sentrello/db";
import { creditedAgainst } from "@sentrello/db/documents";
import {
  type RegisteredWidget,
  allOnboarding,
  defineMiddleware,
  defineModule,
  resolveGuide,
} from "@sentrello/module-sdk";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { readHealth } from "./health";
import {
  CORE_WIDGETS,
  clearStored,
  declaredWidgets,
  defaultLayout,
  normalizeLayout,
  readStored,
  shownTabs,
  withArrivals,
  writeStored,
} from "./layout";
import { readInsights } from "./pro";
import { readPromos, refreshPromosIfStale } from "./promos";

/**
 * The first screen after signing in.
 *
 * Not a report. A report is for a question somebody already has; this is for
 * the question they have not asked yet — what needs doing, and what is going
 * wrong. So it counts the things that cost money to ignore: an invoice that
 * has gone past its date, a quote nobody answered, a follow-up that was due
 * yesterday.
 *
 * One module, two dashboards, decided by entitlement rather than by shipping
 * two of them. The figures come from the modules Core owns, so a Free instance
 * lands somewhere useful — and a Pro instance sees the same figures without
 * the upgrade prompt, because not being sold to is part of what was bought.
 */

interface Attention {
  id: string;
  kind: "invoice" | "quote" | "task";
  summary: string;
  detail: string;
  amountCents?: number;
}

/**
 * Whether there is anything left to set up, anywhere in the business.
 *
 * The same guides the Setting up card draws, resolved the same way, so the
 * promo appears exactly when the checklist leaves — and reappears as the
 * checklist does if a module bought later brings new steps, or undoing
 * something brings one back. Done is derived, never stored, so there is no
 * second flag here to drift from the card.
 *
 * Deliberately blind to dismissals: hiding the checklist part-way is not
 * finishing it, and a business that just asked for the block to go away
 * should not find an advertisement standing in its place. The promo waits
 * for the steps to actually be done, which they become anyway as the
 * business uses the product.
 */
async function onboardingComplete(organizationId: string): Promise<boolean> {
  const guides = await Promise.all(
    allOnboarding().map((guide) => resolveGuide(guide, organizationId)),
  );
  return guides.every((guide) => guide.remaining === 0);
}

export default defineModule({
  id: "dashboard",
  tier: "free",
  register(ctx) {
    // First in the sidebar and first in the nav order, because it is where
    // signing in lands — the shell takes whatever the server puts first.
    ctx.registerNav({
      icon: "gauge",
      id: "dashboard",
      label: "Dashboard",
      order: 1,
      group: "",
    });
    ctx.registerPermission("dashboard:read");

    // The dashboard's own panels, declared like anybody else's. The list —
    // and why it lives in `layout.ts` — is documented on CORE_WIDGETS.
    for (const widget of CORE_WIDGETS) {
      ctx.registerWidget(widget);
    }

    /**
     * The promo document, hourly.
     *
     * On a schedule rather than on a page load: the dashboard must not wait on
     * another host to paint, and a business opening it forty times a day
     * should not make forty requests to us.
     *
     * Hourly rather than nightly, which is what it was. A campaign ends on a
     * Friday afternoon and a module ships on a Tuesday morning, and
     * neither can wait until four the next morning to appear — the first time
     * the copy was changed in anger, the change was invisible for twenty-two
     * hours and looked broken. The public document is served with
     * `cache-control: max-age=3600`, so asking once an hour is exactly as
     * often as the answer can change.
     */
    ctx.registerJob({
      name: "promos",
      cron: "17 * * * *",
      /**
       * And once at startup, because the next hourly run can still be most of
       * an hour away from a brand-new install — the built-in copy on the
       * first screen a new Free user looks at.
       *
       * The handler only fetches when the cached document is missing or
       * stale, so an instance restarted all afternoon still asks us once.
       *
       * Checked per run rather than at registration, because a licence can
       * arrive or lapse while the process runs: a Pro instance shows no promo
       * and has no business fetching one either.
       */
      runAtBoot: true,
      handler: async () => {
        if (ctx.entitled({ tier: "pro" })) return;
        await refreshPromosIfStale();
      },
    });

    ctx.app.get(
      "/api/dashboard",
      requireSession(),
      // Deliberately the widest permission in the product: everybody sees the
      // dashboard, and each panel is built from what the reader may already
      // read elsewhere.
      requirePermission({ dashboard: ["read"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const now = new Date();

        const [invoices, quotes, tasks, contacts, deals, payments] =
          await Promise.all([
            db
              .select()
              .from(schema.invoices)
              .where(eq(schema.invoices.organizationId, orgId)),
            db
              .select()
              .from(schema.quotes)
              .where(eq(schema.quotes.organizationId, orgId)),
            db
              .select()
              .from(schema.tasks)
              .where(
                and(
                  eq(schema.tasks.organizationId, orgId),
                  eq(schema.tasks.done, false),
                ),
              ),
            db
              .select({ id: schema.contacts.id })
              .from(schema.contacts)
              .where(eq(schema.contacts.organizationId, orgId)),
            db
              .select()
              .from(schema.deals)
              .where(
                and(
                  eq(schema.deals.organizationId, orgId),
                  isNull(schema.deals.archivedAt),
                ),
              ),
            db
              .select({
                invoiceId: schema.payments.invoiceId,
                amountCents: schema.payments.amountCents,
              })
              .from(schema.payments)
              .where(eq(schema.payments.organizationId, orgId)),
          ]);

        /**
         * What is still owed, not what was billed.
         *
         * A business that took a deposit this morning is owed the rest, and
         * telling it otherwise overstates the one number on this screen it is
         * most likely to act on. Found by taking a part payment and watching
         * the figure not move.
         */
        const paidByInvoice = new Map<string, number>();
        for (const p of payments) {
          if (!p.invoiceId) continue;
          paidByInvoice.set(
            p.invoiceId,
            (paidByInvoice.get(p.invoiceId) ?? 0) + p.amountCents,
          );
        }
        // Money owed, and how much of it is late. Two numbers rather than one,
        // because "you are owed £8,000" and "£6,000 of it is overdue" call for
        // completely different afternoons.
        //
        // Only live invoices count: a credit note is money going the other
        // way, a draft was never asked for, and settled is settled whether
        // money paid it or a credit note wrote it off.
        const unpaid = invoices.filter(
          (i) =>
            i.kind === "invoice" &&
            !i.deletedAt &&
            i.status !== "paid" &&
            i.status !== "credited" &&
            i.status !== "void" &&
            i.status !== "draft",
        );

        // Credits settle debt beside the payments; without them a partly
        // credited invoice showed the credited share as still owed.
        const creditedByInvoice = await creditedAgainst(
          orgId,
          unpaid.map((i) => i.id),
        );
        const balanceOf = (invoice: { id: string; totalCents: number }) =>
          Math.max(
            0,
            invoice.totalCents -
              (paidByInvoice.get(invoice.id) ?? 0) -
              (creditedByInvoice.get(invoice.id) ?? 0),
          );
        const owedCents = unpaid.reduce((sum, i) => sum + balanceOf(i), 0);
        const overdue = unpaid.filter(
          (i) => i.dueDate && new Date(i.dueDate) < now,
        );
        const overdueCents = overdue.reduce((sum, i) => sum + balanceOf(i), 0);

        const openDeals = deals.filter(
          (d) => d.stage !== "won" && d.stage !== "lost",
        );

        const attention: Attention[] = [
          ...overdue.map((i) => ({
            id: i.id,
            kind: "invoice" as const,
            summary: `Invoice ${i.number} is overdue`,
            detail: i.dueDate
              ? `Due ${new Date(i.dueDate).toDateString()}`
              : "",
            // The balance, for the same reason: chasing somebody for money
            // they have already sent is worse than not chasing at all.
            amountCents: balanceOf(i),
          })),
          ...quotes
            .filter((q) => q.status === "sent")
            .map((q) => ({
              id: q.id,
              kind: "quote" as const,
              summary: `Quote ${q.number} is waiting on an answer`,
              detail: "Sent and not yet accepted or declined",
              amountCents: q.totalCents,
            })),
          ...tasks
            .filter((t) => t.dueAt && new Date(t.dueAt) < now)
            .map((t) => ({
              id: t.id,
              kind: "task" as const,
              summary: t.title,
              detail: t.dueAt
                ? `Was due ${new Date(t.dueAt).toDateString()}`
                : "",
            })),
        ];

        const pro = ctx.entitled({ tier: "pro" });

        /**
         * Whether this business has started using it yet.
         *
         * A dashboard of zeros with nothing on it to do is what somebody sees
         * the morning they install this, and until now the only thing on that
         * screen asking for anything was an advertisement. Read from what has
         * already been fetched: no contacts, nothing invoiced, nothing in the
         * pipeline.
         *
         * It goes away by itself the moment any of those stops being true,
         * which is why there is nothing to dismiss and nothing to remember.
         */
        const nothingYet =
          contacts.length === 0 && invoices.length === 0 && deals.length === 0;

        return c.json({
          tier: pro ? "pro" : "free",
          /** Where to send somebody who has just arrived. */
          startHere: nothingYet
            ? {
                url:
                  process.env.SENTRELLO_DOCS_URL ??
                  "https://docs.sentrello.com/docs/intro",
              }
            : null,
          /**
           * The one advertisement, at the top of the screen.
           *
           * Free only. A business that has paid should not be advertised to on
           * the first screen it opens every morning — that is a large part of
           * what paying is for, and showing it anyway would make the purchase
           * feel unfinished.
           */
          /**
           * And nothing while the business is still setting up.
           *
           * Set by James: the promo takes the onboarding checklist's place
           * once there is nothing left on it — not before. A business still
           * putting its address in and raising its first invoice should not
           * find an advertisement as the only other call to action on the
           * screen. Once setting up is done the offer stands until they take
           * it: this is not a campaign with an end, it is what Free says
           * about Pro.
           *
           * Asked of the whole organization rather than of this reader: the
           * checklist a reader sees is filtered by what they may act on, but
           * a block that appears for one colleague and not another would look
           * broken rather than polite.
           */
          ad:
            pro || !(await onboardingComplete(orgId))
              ? null
              : await (async () => {
                  // The copy is a document Foothills edits centrally; the
                  // built-in wording is what shows until one has been fetched.
                  const { ad } = await readPromos();
                  return {
                    ...ad,
                    url: process.env.SENTRELLO_UPGRADE_URL ?? ad.url,
                  };
                })(),
          health: await readHealth(),
          money: {
            owedCents,
            overdueCents,
            unpaidCount: unpaid.length,
            overdueCount: overdue.length,
          },
          pipeline: {
            openCount: openDeals.length,
            openCents: openDeals.reduce((s, d) => s + d.amountCents, 0),
            wonCount: deals.filter((d) => d.stage === "won").length,
          },
          book: { contacts: contacts.length },
          // Most urgent first: an overdue invoice is money already earned and
          // not received, which outranks a quote nobody has answered.
          attention: attention.slice(0, 12),
        });
      },
    );

    /**
     * The Pro half: twelve months of ledger, and the layout it is drawn in.
     *
     * Registered on every instance and answered only on entitled ones. The
     * loader gates whole modules; this module is Free and grows a second half,
     * so the gate has to be here — and it has to be checked per request,
     * because a licence can arrive or lapse while the process is running.
     */
    const proOnly = defineMiddleware(async (c, next) => {
      // 404 rather than 403: on a Free instance this endpoint does not exist,
      // which is also what the module boot tests assert for anything gated.
      if (!ctx.entitled({ tier: "pro" })) return c.notFound();
      await next();
    });

    /**
     * The widgets this reader may see at all.
     *
     * Three gates, in the order they were decided: the licence loaded the
     * module or its widgets were never declared; the widget's own
     * `entitlement` is asked of the licence, per request, because a licence
     * can arrive or lapse while the process runs; and `requires` is asked of
     * the reader, because a shop assistant with no bookkeeping permission
     * should not be handed a tab of the books merely because the business
     * bought the module.
     *
     * Everything the dashboard answers is cut down to this list — the
     * offered widgets, every tab, the figures feed — so no response ever
     * names a widget the reader cannot have. Being told a panel exists is
     * being told what the business is hiding from you, or what we are
     * selling; the first is a leak and the second is advertising done by
     * error message.
     */
    const visibleWidgets = async (headers: Headers) => {
      const mine = await Promise.all(
        declaredWidgets().map(async (widget) => {
          if (widget.entitlement && !ctx.entitled(widget.entitlement))
            return null;
          if (widget.requires && !(await mayAccess(headers, widget.requires)))
            return null;
          return widget;
        }),
      );
      return mine.filter((w): w is RegisteredWidget => w !== null);
    };

    /**
     * The figures for every widget that carries its own.
     *
     * Each widget is asked separately and its permission checked separately.
     * A bookkeeper's first screen should not be missing everything an owner
     * sees, and an owner's should not fail outright because one panel was
     * not theirs — so a widget that refuses, or throws, is left out rather
     * than taking the screen with it.
     */
    ctx.app.get(
      "/api/dashboard/widgets",
      requireSession(),
      requirePermission({ dashboard: ["read"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const visible = await visibleWidgets(c.req.raw.headers);

        const cards = await Promise.all(
          visible.map(async (widget) => {
            if (!widget.load) return null;
            try {
              return {
                id: widget.id,
                moduleId: widget.moduleId,
                label: widget.label,
                icon: widget.icon ?? null,
                opens: widget.opens ?? null,
                figures: await widget.load(orgId),
              };
            } catch {
              // A module that cannot count itself must not stop the others
              // being counted.
              return null;
            }
          }),
        );

        return c.json({ widgets: cards.filter((card) => card !== null) });
      },
    );

    /**
     * What is left to set up, across whatever this instance loaded.
     *
     * A module arrives switched on and empty, and the person looking at it has
     * to guess which of six screens to open first. Each module says what its
     * first steps are and this draws the list — so a module bought on day 200
     * puts its own checklist in front of somebody the moment it appears, and
     * the steps a business already satisfied show as already done.
     *
     * Guides a reader cannot act on are left out entirely. Setting a module up
     * is an administrator's job, and a list of things somebody will be refused
     * is worse than no list.
     */
    /**
     * The guides this reader may act on, resolved against the data.
     *
     * Guides a reader cannot act on are left out entirely. Setting a module
     * up is an administrator's job, and a list of things somebody will be
     * refused is worse than no list.
     */
    const readableGuides = async (headers: Headers) => {
      const mine = await Promise.all(
        allOnboarding().map(async (guide) =>
          guide.requires && !(await mayAccess(headers, guide.requires))
            ? null
            : guide,
        ),
      );
      return mine.filter((g) => g !== null);
    };

    /**
     * The guides this organization put away before finishing them.
     *
     * The one stored fact in the whole of onboarding — everything else is
     * asked of the data. The states, and why they are kept apart:
     *
     * - **Not started / in progress / completed** are derived, per guide, on
     *   every read: `resolveGuide` asks each step whether it has happened and
     *   `remaining` counts the ones that have not. Never stored, so a module
     *   bought on day 200 opens with its satisfied steps already ticked, and
     *   undoing something honestly brings its step back.
     * - **Hidden part-way and ended early are the same stored fact**: a
     *   dismissal row for that guide. The steps still remain; the business
     *   said stop showing them. It survives reloads and restarts.
     * - **Restored** is the row deleted. The guide resumes where the data
     *   says it is — not at the beginning, because nothing recorded a
     *   beginning.
     * - **Completed** ignores dismissal entirely: a guide with nothing
     *   remaining is never shown and never counted as hidden, so Settings
     *   cannot offer to restore a checklist that would show nothing.
     *
     * Per guide, not one flag, and that is the whole answer to "what about a
     * module bought years after onboarding ended": its guide has no row, so
     * it appears on its own, however long ago the others were finished or
     * put away.
     *
     * Per organization, like the promo gate above and for the same reason: a
     * checklist that is hidden for one colleague and showing for another
     * looks broken rather than polite.
     */
    const dismissedIds = async (orgId: string) => {
      const rows = await db
        .select({ guideId: schema.onboardingDismissals.guideId })
        .from(schema.onboardingDismissals)
        .where(eq(schema.onboardingDismissals.organizationId, orgId));
      return new Set(rows.map((r) => r.guideId));
    };

    ctx.app.get(
      "/api/dashboard/onboarding",
      requireSession(),
      requirePermission({ dashboard: ["read"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const guides = await Promise.all(
          (await readableGuides(c.req.raw.headers)).map((guide) =>
            resolveGuide(guide, orgId),
          ),
        );
        const dismissed = await dismissedIds(orgId);

        // Finished guides are not sent. A checklist with every box ticked is
        // a card that says "well done" for ever, on the screen somebody opens
        // every morning.
        const unfinished = guides.filter((g) => g.remaining > 0);

        return c.json({
          guides: unfinished.filter((g) => !dismissed.has(g.id)),
          /**
           * How many unfinished guides are put away — what Settings offers
           * to bring back. A count rather than the guides themselves,
           * because the offer is "show these again", not a second checklist.
           */
          hidden: unfinished.filter((g) => dismissed.has(g.id)).length,
        });
      },
    );

    /**
     * Put the checklist away, finished or not.
     *
     * One press hides every guide this reader can currently see, which is
     * both of James's asks at once: hide the block, and end onboarding
     * part-way. Safe to offer freely because nothing is lost — done is
     * derived, so Settings can bring the list back exactly where the data
     * says it is.
     */
    ctx.app.post(
      "/api/dashboard/onboarding/hide",
      requireSession(),
      requirePermission({ dashboard: ["read"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const guides = await Promise.all(
          (await readableGuides(c.req.raw.headers)).map((guide) =>
            resolveGuide(guide, orgId),
          ),
        );
        // Only what is actually on the screen: a finished guide needs no row,
        // and a guide this reader may not see is not theirs to put away.
        const showing = guides.filter((g) => g.remaining > 0);
        if (showing.length > 0) {
          await db
            .insert(schema.onboardingDismissals)
            .values(
              showing.map((g) => ({ organizationId: orgId, guideId: g.id })),
            )
            // Hiding what a colleague already hid is one decision, not an
            // error.
            .onConflictDoNothing();
        }
        return c.json({ hidden: showing.length });
      },
    );

    /**
     * Bring it back. The Settings screen's side of the bargain: dismissing
     * is free because this exists.
     */
    ctx.app.post(
      "/api/dashboard/onboarding/restore",
      requireSession(),
      requirePermission({ dashboard: ["read"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const mine = (await readableGuides(c.req.raw.headers)).map((g) => g.id);
        if (mine.length > 0) {
          await db
            .delete(schema.onboardingDismissals)
            .where(
              and(
                eq(schema.onboardingDismissals.organizationId, orgId),
                inArray(schema.onboardingDismissals.guideId, mine),
              ),
            );
        }
        return c.json({ restored: true });
      },
    );

    ctx.app.get(
      "/api/dashboard/insights",
      requireSession(),
      requirePermission({ dashboard: ["read"] }),
      proOnly,
      async (c) =>
        c.json(await readInsights(activeOrganizationId(c.get("session")))),
    );

    /*
     * Arranging is not a paid feature. James, 2026-09-13: the Free and the Pro
     * dashboard are the same screen, and Free additionally carries the promo
     * block. Deciding which of your own panels you look at first is not
     * something to charge for — what Pro sells is the panels there are to
     * arrange.
     */
    /**
     * What this reader's dashboard looks like, cut down to what they may see.
     *
     * The tabs are the organization's one arrangement — stored or, until
     * somebody arranges, the default built from what is visible. Either way a
     * widget the reader cannot have is not in it, and a widget that arrived
     * after the arranging — a module bought on day 200 — is appended with a
     * tab of its own, so buying a module puts it on the screen with nobody
     * doing anything.
     */
    ctx.app.get(
      "/api/dashboard/layout",
      requireSession(),
      requirePermission({ dashboard: ["read"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const visible = await visibleWidgets(c.req.raw.headers);
        const ids = new Set(visible.map((w) => w.id));
        const stored = await readStored(orgId);
        return c.json({
          tabs: stored
            ? shownTabs(withArrivals(stored.tabs, stored.known, visible), ids)
            : defaultLayout(visible),
          // Offered by name, so the arranging screen has words rather than
          // ids somebody has to decode.
          widgets: visible.map((w) => ({
            id: w.id,
            label: w.label,
            icon: w.icon ?? null,
          })),
        });
      },
    );

    ctx.app.put(
      "/api/dashboard/layout",
      requireSession(),
      // Arranging the business's screen is not an administrative act, so it
      // needs no permission beyond the one that let anybody see the screen.
      requirePermission({ dashboard: ["read"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const body = (await c.req.json().catch(() => ({}))) as {
          tabs?: unknown;
        };
        const visible = await visibleWidgets(c.req.raw.headers);
        const tabs = normalizeLayout(body.tabs);

        if (tabs.length === 0) {
          // An empty save resets rather than empties: a layout with no tabs
          // is a blank screen with no way back to a usable one.
          await clearStored(orgId);
        } else {
          /*
           * `known` is what suppresses the day-200 append: everything this
           * arrangement had the chance to place. The union with what was
           * known before matters — this writer may lack a permission a
           * colleague holds, and their save must not turn a colleague's
           * deliberately-removed widget back into a new arrival.
           */
          const stored = await readStored(orgId);
          const known = [
            ...new Set([
              ...(stored?.known ?? []),
              ...visible.map((w) => w.id),
              ...tabs.flatMap((t) => t.widgets),
            ]),
          ];
          await writeStored(orgId, tabs, known);
        }

        // Answer with what this reader now sees, which is also the rule that
        // a save naming a widget the writer cannot have never echoes it.
        const ids = new Set(visible.map((w) => w.id));
        const now = await readStored(orgId);
        return c.json({
          tabs: now
            ? shownTabs(withArrivals(now.tabs, now.known, visible), ids)
            : defaultLayout(visible),
        });
      },
    );
  },
});
