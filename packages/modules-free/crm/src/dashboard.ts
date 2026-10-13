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
import {
  and,
  db,
  desc,
  eq,
  gte,
  isNotNull,
  isNull,
  schema,
  sql,
} from "@sentrello/db";
import { decidedStages } from "@sentrello/db/crm";
import { dayIn, dayOf } from "@sentrello/db/day";
import { timezoneFor } from "@sentrello/db/timezone";
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
  // The business's own names, asked for in the one place that knows them.
  // This read the settings correctly and wrote the fallback words out again,
  // which is a fourth copy of "won" and "lost" in a product where what those
  // mean is configurable.
  const stages = await decidedStages(orgId);
  const won = new Set(stages.won);
  const lost = new Set(stages.lost);

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
      /*
       * What day it is where the business is.
       *
       * Late is a question about days, and the product already says so on the
       * screen this feeds: "nobody thinks their two o'clock is overdue at one."
       * The API disagreed with it — `dueAt < now` marks a task due this
       * afternoon as late by lunchtime, and a deal expected to close today as a
       * conversation somebody has been avoiding.
       */
      const today = dayIn(now, await timezoneFor(orgId));

      /*
       * The ten newest things that happened, for the panel that lists them.
       *
       * This used to be two hundred, and both contact panels were built from
       * it: who is hot, and how many are going quiet. A window of the newest
       * two hundred activities answers neither. A contact last spoken to six
       * weeks ago is exactly the one going quiet, and exactly the one that
       * window has already dropped — so on a CRM logging a few dozen emails a
       * day the count was nought for ever, and a hot contact pushed out by
       * two hundred notes about other people left the hot panel empty. Each
       * is asked as its own question now, over every activity.
       */
      const recentActivity = await db
        .select()
        .from(schema.activities)
        .where(eq(schema.activities.organizationId, orgId))
        .orderBy(desc(schema.activities.occurredAt))
        .limit(10);

      /** Each contact's most recent activity, which both panels rank by. */
      const lastActivity =
        sql<Date>`max(${schema.activities.occurredAt})`.mapWith(
          schema.activities.occurredAt,
        );
      const touched = db
        .select({
          contactId: schema.activities.contactId,
          at: lastActivity.as("at"),
        })
        .from(schema.activities)
        .where(
          and(
            eq(schema.activities.organizationId, orgId),
            isNotNull(schema.activities.contactId),
          ),
        )
        .groupBy(schema.activities.contactId)
        .as("touched");

      const [openDeals, decided, dueTasks, hotRows, [quiet]] =
        await Promise.all([
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
          /*
           * Hot and touched, most recent first. Eight, ranked in the query,
           * because ranking a window and then filtering it is the bug above.
           */
          db
            .select({
              id: schema.contacts.id,
              name: schema.contacts.name,
              email: schema.contacts.email,
              companyId: schema.contacts.companyId,
              avatarPath: schema.contacts.avatarPath,
              at: touched.at,
            })
            .from(touched)
            .innerJoin(
              schema.contacts,
              eq(schema.contacts.id, touched.contactId),
            )
            .where(
              and(
                eq(schema.contacts.organizationId, orgId),
                eq(schema.contacts.status, "hot"),
              ),
            )
            .orderBy(desc(touched.at))
            .limit(8),
          db
            .select({ count: sql<number>`count(*)::int` })
            .from(touched)
            .innerJoin(
              schema.contacts,
              eq(schema.contacts.id, touched.contactId),
            )
            .where(
              and(
                eq(schema.contacts.organizationId, orgId),
                sql`${touched.at} < ${daysFromNow(-GOING_COLD_DAYS).toISOString()}`,
              ),
            ),
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
      const hot = hotRows.map((contact) => ({
        id: contact.id,
        name: contact.name,
        email: contact.email,
        companyId: contact.companyId,
        // Whether the panel should ask for a photograph. Without this it
        // asked for one per person and took a 404 for everybody who has
        // none, which is nearly everybody.
        avatar: Boolean(contact.avatarPath),
        lastActivityAt: contact.at,
      }));

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
          /*
           * Days, inclusive of today.
           *
           * `due >= now` excludes a deal expected to close *today*, because the
           * date is midnight and the morning has already gone — and the overdue
           * filter below excludes it too, correctly. So the deals closing today,
           * the ones somebody would ring about this afternoon, appeared in
           * neither list on the panel built to show exactly that.
           */
          const due = dayOf(new Date(deal.expectedCloseOn)).getTime();
          return due >= today.getTime() && due <= dayOf(horizon).getTime();
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
        (deal) =>
          deal.expectedCloseOn &&
          dayOf(new Date(deal.expectedCloseOn)).getTime() < today.getTime(),
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
          overdue: dayOf(task.dueAt as Date).getTime() < today.getTime(),
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
        latestActivity: recentActivity.map((activity) => ({
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
        goingCold: quiet?.count ?? 0,
      });
    },
  );
}
