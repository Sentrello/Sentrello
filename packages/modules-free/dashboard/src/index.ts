import {
  activeOrganizationId,
  mayAccess,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, schema } from "@sentrello/db";
import {
  allSummaries,
  defineMiddleware,
  defineModule,
} from "@sentrello/module-sdk";
import { and, eq, isNull } from "drizzle-orm";
import { readHealth } from "./health";
import {
  WIDGETS,
  normalizeLayout,
  readInsights,
  readLayout,
  writeLayout,
} from "./pro";
import { pastQuietPeriod, readPromos, refreshPromosIfStale } from "./promos";

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
       * And once at startup, because the nightly run is a whole day away from
       * a brand-new install — a day of the built-in copy on the first screen a
       * new Free user looks at.
       *
       * The handler only fetches when the cached document is missing or over a
       * day old, so an instance restarted all afternoon still asks us once.
       */
      runAtBoot: true,
      handler: () => refreshPromosIfStale(),
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
        const balanceOf = (invoice: { id: string; totalCents: number }) =>
          Math.max(
            0,
            invoice.totalCents - (paidByInvoice.get(invoice.id) ?? 0),
          );

        // Money owed, and how much of it is late. Two numbers rather than one,
        // because "you are owed £8,000" and "£6,000 of it is overdue" call for
        // completely different afternoons.
        const unpaid = invoices.filter(
          (i) => i.status !== "paid" && i.status !== "void",
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
         * When this business started, which is what the quiet period counts
         * from — not when the process booted, and not when the licence was
         * issued. Somebody who has been using this for a year does not get
         * two more quiet months because their server was rebuilt.
         */
        const [organization] = await db
          .select({ createdAt: schema.organizations.createdAt })
          .from(schema.organizations)
          .where(eq(schema.organizations.id, orgId))
          .limit(1);
        const startedAt = organization?.createdAt ?? null;

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
           * Nothing at all for the first two months.
           *
           * A business that claimed its instance this morning has not added a
           * contact or raised an invoice, and an advertisement would be the
           * only call to action on the screen — the wrong first impression of
           * something they have just installed. After that the offer stands
           * until they take it: this is not a campaign with an end, it is what
           * Free says about Pro.
           */
          ad:
            pro || !pastQuietPeriod(startedAt)
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
     * What every loaded module says about itself.
     *
     * Not gated to Pro: a Free instance runs Invoicing and Accounting too, and
     * "what has this module got to tell me" is the same question on both. What
     * is gated is the arranging of them, which is the Pro dashboard's job.
     *
     * Each summary is asked for separately and its permission checked
     * separately. A bookkeeper's first screen should not be missing everything
     * an owner sees, and an owner's should not fail outright because one panel
     * was not theirs — so a summary that refuses, or throws, is left out
     * rather than taking the screen with it.
     */
    ctx.app.get(
      "/api/dashboard/summaries",
      requireSession(),
      requirePermission({ dashboard: ["read"] }),
      async (c) => {
        const session = c.get("session");
        const orgId = activeOrganizationId(session);

        const cards = await Promise.all(
          allSummaries().map(async (summary) => {
            if (
              summary.requires &&
              !(await mayAccess(c.req.raw.headers, summary.requires))
            ) {
              return null;
            }
            try {
              return {
                id: summary.id,
                moduleId: summary.moduleId,
                label: summary.label,
                icon: summary.icon ?? null,
                opens: summary.opens ?? null,
                figures: await summary.load(orgId),
              };
            } catch {
              // A module that cannot count itself must not stop the others
              // being counted.
              return null;
            }
          }),
        );

        return c.json({ summaries: cards.filter((card) => card !== null) });
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

    ctx.app.get(
      "/api/dashboard/layout",
      requireSession(),
      requirePermission({ dashboard: ["read"] }),
      proOnly,
      async (c) => {
        const session = c.get("session");
        return c.json({
          tabs: await readLayout(
            activeOrganizationId(session),
            session.user.id,
          ),
          widgets: WIDGETS,
        });
      },
    );

    ctx.app.put(
      "/api/dashboard/layout",
      requireSession(),
      // Arranging your own screen is not an administrative act, so it needs no
      // permission beyond the one that let you see the screen.
      requirePermission({ dashboard: ["read"] }),
      proOnly,
      async (c) => {
        const session = c.get("session");
        const body = (await c.req.json().catch(() => ({}))) as {
          tabs?: unknown;
        };
        const tabs = normalizeLayout(body.tabs);
        await writeLayout(activeOrganizationId(session), session.user.id, tabs);
        return c.json({ tabs });
      },
    );
  },
});
