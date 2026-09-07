import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, isNull, lte, schema } from "@sentrello/db";
import { type Interval, nextRun } from "@sentrello/jobs/dates";
import type {
  ModuleContext,
  RouteContext,
  SentrelloEnv,
} from "@sentrello/module-sdk";
import type { MiddlewareHandler } from "hono";
import { isUuid } from "./chart";

/**
 * Bills that arrive on a schedule.
 *
 * Rent, insurance, the accountant's retainer. The business already knows they
 * are coming; what it wants is for them to be waiting rather than remembered.
 *
 * Each run copies a template bill into a **draft**, never an approved one. A
 * bill is somebody else's claim: the figure often differs from last month's,
 * and posting a liability nobody has looked at is how a set of books fills up
 * with amounts the business never agreed to. Invoicing can raise and send its
 * recurring documents unattended because those are the business's own claims;
 * this deliberately cannot.
 */

export const INTERVALS: Interval[] = [
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
];

/** A bill copied whole — lines included — as a fresh draft. */
export async function copyBill(
  orgId: string,
  templateId: string,
  billDate: Date,
): Promise<string> {
  return db.transaction(async (tx) => {
    const [template] = await tx
      .select()
      .from(schema.bills)
      .where(
        and(
          eq(schema.bills.id, templateId),
          eq(schema.bills.organizationId, orgId),
        ),
      )
      .limit(1);
    if (!template) throw new Error(`no bill ${templateId} to copy`);

    /**
     * The due date keeps its distance from the bill date.
     *
     * A template due fourteen days after it was raised produces copies due
     * fourteen days after each of theirs — copying the date itself would
     * produce a bill that arrived already overdue.
     */
    const dueDate = template.dueDate
      ? new Date(
          billDate.getTime() +
            (template.dueDate.getTime() - template.billDate.getTime()),
        )
      : null;

    const [made] = await tx
      .insert(schema.bills)
      .values({
        organizationId: orgId,
        vendorId: template.vendorId,
        number: template.number,
        status: "draft",
        currency: template.currency,
        billDate,
        dueDate,
        subtotalCents: template.subtotalCents,
        taxCents: template.taxCents,
        totalCents: template.totalCents,
        notes: template.notes,
      })
      .returning();
    if (!made) throw new Error("bill copy returned no row");

    const lines = await tx
      .select()
      .from(schema.billLines)
      .where(eq(schema.billLines.billId, template.id));
    if (lines.length > 0) {
      await tx.insert(schema.billLines).values(
        lines.map((line) => ({
          billId: made.id,
          description: line.description,
          quantityMilli: line.quantityMilli,
          unitPriceCents: line.unitPriceCents,
          accountId: line.accountId,
          taxDefinitionId: line.taxDefinitionId,
          taxRateBp: line.taxRateBp,
          sortOrder: line.sortOrder,
        })),
      );
    }
    return made.id;
  });
}

/**
 * Every schedule whose run has come round.
 *
 * The schedule moves on in the same transaction as the bill it produced —
 * a run that writes the bill and then fails to advance writes it again on the
 * next tick, and a business chasing a duplicate bill it never received is a
 * support call about its own books.
 */
export async function runRecurringBills(now = new Date()): Promise<number> {
  const due = await db
    .select()
    .from(schema.recurringBills)
    .where(
      and(
        eq(schema.recurringBills.active, true),
        lte(schema.recurringBills.nextRunAt, now),
      ),
    );

  let made = 0;
  for (const schedule of due) {
    if (schedule.endsOn && schedule.endsOn < now) {
      await db
        .update(schema.recurringBills)
        .set({ active: false })
        .where(eq(schema.recurringBills.id, schedule.id));
      continue;
    }

    try {
      await copyBill(
        schedule.organizationId,
        schedule.templateBillId,
        schedule.nextRunAt,
      );
    } catch (err) {
      // A template somebody deleted stops its schedule rather than failing
      // every run for ever after.
      console.error(
        `[recurring-bills] ${schedule.id} could not copy its template`,
        err,
      );
      await db
        .update(schema.recurringBills)
        .set({ active: false })
        .where(eq(schema.recurringBills.id, schedule.id));
      continue;
    }

    await db
      .update(schema.recurringBills)
      .set({
        nextRunAt: nextRun(
          schedule.nextRunAt,
          schedule.interval as Interval,
          schedule.intervalCount,
        ),
        generatedCount: schedule.generatedCount + 1,
        lastGeneratedAt: now,
      })
      .where(eq(schema.recurringBills.id, schedule.id));
    made += 1;
  }
  return made;
}

export function registerRecurringBills(
  ctx: ModuleContext,
  proOnly: MiddlewareHandler<SentrelloEnv>,
) {
  /**
   * Once a day, and only where the licence covers it.
   *
   * The job is registered on every instance because a module registers its
   * jobs when it loads, and this module loads everywhere. The entitlement is
   * checked when it runs, so a licence that lapses stops producing bills
   * rather than leaving a scheduler entry nobody can see.
   */
  ctx.registerJob({
    name: "recurring-bills",
    cron: "22 5 * * *",
    handler: async () => {
      if (!ctx.entitled({ tier: "pro" })) return { skipped: "not entitled" };
      return { drafted: await runRecurringBills() };
    },
  });

  ctx.app.get(
    "/api/recurring-bills",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const rows = await db
        .select()
        .from(schema.recurringBills)
        .where(eq(schema.recurringBills.organizationId, orgId))
        .orderBy(schema.recurringBills.nextRunAt);
      return c.json({ schedules: rows });
    },
  );

  ctx.app.post(
    "/api/recurring-bills",
    requireSession(),
    requirePermission({ bookkeeping: ["create"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = await c.req.json();
      const templateBillId = String(body.templateBillId ?? "");
      const interval = String(body.interval ?? "monthly") as Interval;

      if (!INTERVALS.includes(interval)) {
        return c.json(
          { error: `interval must be one of ${INTERVALS.join(", ")}` },
          400,
        );
      }
      const intervalCount = Number(body.intervalCount ?? 1);
      if (!Number.isInteger(intervalCount) || intervalCount < 1) {
        return c.json({ error: "intervalCount" }, 400);
      }
      if (!isUuid(templateBillId)) {
        return c.json({ error: "a template bill" }, 400);
      }

      const [template] = await db
        .select({ id: schema.bills.id, vendorId: schema.bills.vendorId })
        .from(schema.bills)
        .where(
          and(
            eq(schema.bills.id, templateBillId),
            eq(schema.bills.organizationId, orgId),
            isNull(schema.bills.deletedAt),
          ),
        )
        .limit(1);
      if (!template) return c.json({ error: "bill not found" }, 404);

      const nextRunAt = body.nextRunAt ? new Date(body.nextRunAt) : new Date();
      if (Number.isNaN(nextRunAt.getTime())) {
        return c.json({ error: "unreadable date" }, 400);
      }
      const endsOn = body.endsOn ? new Date(body.endsOn) : null;
      if (endsOn && Number.isNaN(endsOn.getTime())) {
        return c.json({ error: "unreadable date" }, 400);
      }

      const [row] = await db
        .insert(schema.recurringBills)
        .values({
          organizationId: orgId,
          vendorId: template.vendorId,
          name: body.name ?? null,
          interval,
          intervalCount,
          nextRunAt,
          endsOn,
          templateBillId: template.id,
        })
        .returning();
      return c.json({ schedule: row }, 201);
    },
  );

  /** Stopping one, or starting it again. */
  ctx.app.patch(
    "/api/recurring-bills/:id",
    requireSession(),
    requirePermission({ bookkeeping: ["update"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("id") ?? "";
      if (!isUuid(id)) return c.json({ error: "not found" }, 404);
      const body = await c.req.json().catch(() => ({}));

      const [row] = await db
        .update(schema.recurringBills)
        .set({
          ...(typeof body.active === "boolean" ? { active: body.active } : {}),
          ...(body.nextRunAt ? { nextRunAt: new Date(body.nextRunAt) } : {}),
          ...(body.name !== undefined ? { name: body.name || null } : {}),
        })
        .where(
          and(
            eq(schema.recurringBills.id, id),
            eq(schema.recurringBills.organizationId, orgId),
          ),
        )
        .returning();
      if (!row) return c.json({ error: "not found" }, 404);
      return c.json({ schedule: row });
    },
  );
}
