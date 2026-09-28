import { db, eq, notInArray, schema, sql } from "@sentrello/db";
import type { ModuleContext, SummaryFigure } from "@sentrello/module-sdk";
import { DEFAULT_LOST_STAGES, DEFAULT_WON_STAGES } from "./settings";

/**
 * The CRM on the dashboard, which it was not on at all.
 *
 * Every instance has the CRM — it is Free, and it is where a customer exists
 * before anything can be sold to one — and the dashboard said nothing about
 * it. Storage, the Newsletter, Booking, the Shop and Invoicing all had a
 * panel; the module every business uses did not.
 *
 * Three figures, chosen because each is a thing somebody would act on rather
 * than a number that only goes up. A count of contacts is the second kind:
 * it rises whatever happens and tells nobody what to do this morning.
 */
export async function crmFigures(
  organizationId: string,
): Promise<SummaryFigure[]> {
  const [settings] = await db
    .select({
      wonStages: schema.crmSettings.wonStages,
      lostStages: schema.crmSettings.lostStages,
    })
    .from(schema.crmSettings)
    .where(eq(schema.crmSettings.organizationId, organizationId))
    .limit(1);

  /*
   * Decided is won *or* lost, read from this business's own settings.
   *
   * A business renames its stages — "invoiced", "dead" — and a hard-coded
   * "won" would report every one of its closed deals as still open. The
   * defaults are only what an instance that has never touched the settings
   * screen has.
   */
  const decided = [
    ...(settings?.wonStages ?? DEFAULT_WON_STAGES),
    ...(settings?.lostStages ?? DEFAULT_LOST_STAGES),
  ];

  /*
   * Composed as a Drizzle condition rather than written as `<> all(...)`.
   *
   * A JS array bound into a raw `sql` template arrives as a parameter the
   * driver has not made an array of, and Postgres answers "op ANY/ALL
   * (array) requires array on right side". Building the `not in` with the
   * query builder and dropping the result into the template gets the same
   * SQL with the values bound one by one.
   */
  const stillOpen = notInArray(schema.deals.stage, decided);

  const [row] = await db
    .select({
      openCents: sql<number>`coalesce(sum(
        ${schema.deals.amountCents}
      ) filter (
        where ${stillOpen} and ${schema.deals.archivedAt} is null
      ), 0)::bigint`.mapWith(Number),
      open: sql<number>`count(*) filter (
        where ${stillOpen} and ${schema.deals.archivedAt} is null
      )::int`,
      /*
       * A deal whose expected close date has gone by and which nobody has
       * decided. It is the one number here that asks for something to be
       * done today, which is the whole reason a panel is worth a tab.
       */
      slipped: sql<number>`count(*) filter (
        where ${stillOpen}
          and ${schema.deals.archivedAt} is null
          and ${schema.deals.expectedCloseOn} is not null
          and ${schema.deals.expectedCloseOn} < current_date
      )::int`,
    })
    .from(schema.deals)
    .where(eq(schema.deals.organizationId, organizationId));

  return [
    { label: "In the pipeline", value: row?.openCents ?? 0, kind: "money" },
    { label: "Open deals", value: row?.open ?? 0, kind: "count" },
    {
      label: "Past their close date",
      value: row?.slipped ?? 0,
      kind: "count",
      tone: (row?.slipped ?? 0) > 0 ? "bad" : "plain",
    },
  ];
}

export function registerCrmSummary(ctx: ModuleContext): void {
  ctx.registerSummary({
    id: "crm",
    label: "CRM",
    icon: "contact-round",
    opens: "deals",
    requires: { crm: ["read"] },
    load: crmFigures,
  });
}
