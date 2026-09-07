/**
 * The CRM's own dashboard: four questions, answered on opening it.
 *
 * Modelled on the reference's, which is a good dashboard because it is short —
 * who is going cold, what is about to land, what happened lately, what is due.
 * Its "Welcome" stepper is deliberately absent: a panel explaining the product
 * to somebody who already bought it is a panel they scroll past forever.
 *
 * Deliberately separate from the platform dashboard. That one answers "how is
 * the business doing" across every module; this one answers "what is happening
 * with my customers", and merging them produces a screen that does neither.
 */
import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, desc, eq, gte, isNull, schema } from "@sentrello/db";
import type { ModuleContext } from "@sentrello/module-sdk";

/** Long enough that a quiet fortnight is not an alarm, short enough to act on. */
const GOING_COLD_DAYS = 30;

/** What "upcoming" means for revenue and for tasks. */
const HORIZON_DAYS = 30;

const daysFromNow = (days: number): Date =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000);

/** The first of the month, `count` months back. */
function monthsAgo(count: number): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - count + 1, 1),
  );
}

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Six months of won and lost, with the money each way.
 *
 * Which stages count as won or lost is the business's own answer, from CRM
 * Settings — a pipeline whose last stage is "Installed" still means the money
 * came in, and hard-coding "won" would leave that business a chart of zeroes.
 *
 * Every month in the window is present, including the quiet ones: a series
 * that skips an empty month draws a shape the business never had.
 */
async function dealOutcomes(
  orgId: string,
  decided: { stage: string; amountCents: number; decidedAt: Date | null }[],
): Promise<
  {
    month: string;
    wonCount: number;
    wonCents: number;
    lostCount: number;
    lostCents: number;
  }[]
> {
  const [settings] = await db
    .select({
      wonStages: schema.crmSettings.wonStages,
      lostStages: schema.crmSettings.lostStages,
    })
    .from(schema.crmSettings)
    .where(eq(schema.crmSettings.organizationId, orgId))
    .limit(1);

  const won = new Set(settings?.wonStages ?? ["won"]);
  const lost = new Set(settings?.lostStages ?? ["lost"]);

  const months = new Map<
    string,
    {
      month: string;
      wonCount: number;
      wonCents: number;
      lostCount: number;
      lostCents: number;
    }
  >();
  const now = new Date();
  for (let i = 5; i >= 0; i -= 1) {
    const key = monthKey(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)),
    );
    months.set(key, {
      month: key,
      wonCount: 0,
      wonCents: 0,
      lostCount: 0,
      lostCents: 0,
    });
  }

  for (const deal of decided) {
    if (!deal.decidedAt) continue;
    const bucket = months.get(monthKey(new Date(deal.decidedAt)));
    if (!bucket) continue;
    if (won.has(deal.stage)) {
      bucket.wonCount += 1;
      bucket.wonCents += deal.amountCents;
    } else if (lost.has(deal.stage)) {
      bucket.lostCount += 1;
      bucket.lostCents += deal.amountCents;
    }
  }

  return [...months.values()];
}

export function registerCrmDashboard(ctx: ModuleContext) {
  ctx.app.get(
    "/api/crm/dashboard",
    requireSession(),
    requirePermission({ crm: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const now = new Date();

      const [recentActivity, openDeals, decided, dueTasks, contacts] =
        await Promise.all([
          db
            .select()
            .from(schema.activities)
            .where(eq(schema.activities.organizationId, orgId))
            .orderBy(desc(schema.activities.occurredAt))
            .limit(200),
          db
            .select()
            .from(schema.deals)
            .where(
              and(
                eq(schema.deals.organizationId, orgId),
                isNull(schema.deals.archivedAt),
              ),
            ),
          /**
           * Everything decided in the last six months, archived or not.
           *
           * The chart is about what happened, and a business files a won job
           * away the week after it lands — reading only the live board would
           * show a pipeline that had never won anything.
           *
           * Keyed on when the deal was decided rather than when the row was
           * last touched. `updatedAt` moves whenever anybody edits anything,
           * so a note added to a deal won in June used to drag it into the
           * current month and the chart rewrote its own history.
           */
          db
            .select({
              stage: schema.deals.stage,
              amountCents: schema.deals.amountCents,
              decidedAt: schema.deals.decidedAt,
            })
            .from(schema.deals)
            .where(
              and(
                eq(schema.deals.organizationId, orgId),
                gte(schema.deals.decidedAt, monthsAgo(6)),
              ),
            ),
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
            .select()
            .from(schema.contacts)
            .where(eq(schema.contacts.organizationId, orgId)),
        ]);

      /**
       * Hot contacts: the ones somebody marked hot, most recently touched
       * first.
       *
       * Two conditions, and both earn their place. The status is the business's
       * own judgement about which relationships matter right now, and a panel
       * that ignored it made the column somebody had gone to the trouble of
       * setting do nothing at all. The ordering is what makes the panel useful
       * once the status has chosen who is on it.
       *
       * Contacts with no activity at all are still excluded, marked hot or not:
       * a list that opens with somebody nobody has ever spoken to teaches you
       * to ignore the list.
       */
      const lastSeen = new Map<string, Date>();
      for (const activity of recentActivity) {
        if (!activity.contactId) continue;
        const at = activity.occurredAt;
        const known = lastSeen.get(activity.contactId);
        if (!known || at > known) lastSeen.set(activity.contactId, at);
      }

      const byId = new Map(contacts.map((contact) => [contact.id, contact]));
      const hot = [...lastSeen.entries()]
        .sort((a, b) => b[1].getTime() - a[1].getTime())
        .map(([contactId, at]) => {
          const contact = byId.get(contactId);
          return contact && contact.status === "hot"
            ? {
                id: contact.id,
                name: contact.name,
                email: contact.email,
                companyId: contact.companyId,
                lastActivityAt: at,
              }
            : null;
        })
        .filter((row): row is NonNullable<typeof row> => row !== null)
        // Sliced after the filter, not before. Taking eight and then dropping
        // the ones that are not hot leaves a panel of two on a busy CRM.
        .slice(0, 8);

      /**
       * Upcoming revenue: what is expected to close inside the horizon.
       *
       * Not weighted by stage. A probability-weighted forecast is a number
       * nobody can check and everybody argues with; "these four deals say they
       * close this month, and they add up to this" is a number somebody can
       * act on this afternoon.
       */
      const horizon = daysFromNow(HORIZON_DAYS);
      const closingSoon = openDeals
        .filter((deal) => {
          if (!deal.expectedCloseOn) return false;
          const due = new Date(deal.expectedCloseOn);
          return due >= now && due <= horizon;
        })
        .sort(
          (a, b) =>
            new Date(a.expectedCloseOn as string).getTime() -
            new Date(b.expectedCloseOn as string).getTime(),
        );

      /**
       * Overdue is its own number rather than part of the total.
       *
       * A deal whose close date has passed is not upcoming revenue — it is a
       * conversation somebody has been avoiding, and adding it to the forecast
       * hides exactly the thing worth seeing.
       */
      const overdue = openDeals.filter(
        (deal) => deal.expectedCloseOn && new Date(deal.expectedCloseOn) < now,
      );

      const sum = (rows: typeof openDeals) =>
        rows.reduce((total, deal) => total + deal.amountCents, 0);

      const tasksDue = dueTasks
        .filter((task) => task.dueAt)
        .sort(
          (a, b) => (a.dueAt as Date).getTime() - (b.dueAt as Date).getTime(),
        )
        .slice(0, 8)
        .map((task) => ({
          id: task.id,
          title: task.title,
          type: task.type,
          dueAt: task.dueAt,
          contactId: task.contactId,
          dealId: task.dealId,
          overdue: (task.dueAt as Date) < now,
        }));

      return c.json({
        hotContacts: hot,
        /**
         * Won against lost, month by month, for the last six.
         *
         * This replaced "closing in 30 days", which was a forecast — a number
         * nobody can check, and one that says nothing about whether the
         * business is actually winning work. Won and lost are facts, and the
         * shape of six months of them is the question a sales screen exists
         * to answer.
         */
        dealOutcomes: await dealOutcomes(orgId, decided),
        upcoming: {
          horizonDays: HORIZON_DAYS,
          totalCents: sum(closingSoon),
          overdue: {
            count: overdue.length,
            totalCents: sum(overdue),
          },
        },
        latestActivity: recentActivity.slice(0, 10).map((activity) => ({
          id: activity.id,
          type: activity.type,
          body: activity.body,
          occurredAt: activity.occurredAt,
          contactId: activity.contactId,
          dealId: activity.dealId,
        })),
        tasks: tasksDue,
        /**
         * The quiet ones, counted rather than listed.
         *
         * A number invites a click; eight names invite scrolling past. The
         * contacts screen already filters, so this is a prompt to go there.
         */
        goingCold: contacts.filter((contact) => {
          const at = lastSeen.get(contact.id);
          return at ? at < daysFromNow(-GOING_COLD_DAYS) : false;
        }).length,
      });
    },
  );
}
