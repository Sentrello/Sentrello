import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, eq, schema } from "@sentrello/db";
import { closedThrough } from "@sentrello/db/ledger";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";

/**
 * Closing the books to a date.
 *
 * A business that has filed a return, or given figures to an accountant, needs
 * those figures to stay what they were. Until now nothing stopped anybody with
 * invoicing permission posting into a month that had already been reported on —
 * `postJournalEntry` took any date, and payments have always posted on the day
 * the money arrived.
 *
 * The rule itself lives in `postJournalEntry`, where it binds every module.
 * This is only the screen's end of it.
 */

/** `2026-03-31` → the last instant of that day, which is what is closed. */
export function dayFrom(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function registerPeriodLock(ctx: ModuleContext) {
  ctx.app.get(
    "/api/accounting/period",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const closed = await closedThrough(orgId);
      return c.json({
        closedThrough: closed ? closed.toISOString().slice(0, 10) : null,
      });
    },
  );

  /**
   * Moving the line, in either direction.
   *
   * Reopening is allowed and deliberately so: a business told by its
   * accountant to correct something in a closed month must be able to, and a
   * lock that can only tighten is one somebody works around by not using it.
   * What matters is that the entry is a decision somebody made rather than
   * something that happens by accident.
   */
  ctx.app.put(
    "/api/accounting/period",
    requireSession(),
    requirePermission({ bookkeeping: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      // Null clears the lock. Anything that is neither null nor a date is a
      // mistake, and a mistake that silently cleared the lock would be the
      // worst of the three outcomes.
      const wanted =
        body.closedThrough === null ? null : dayFrom(body.closedThrough);
      if (body.closedThrough !== null && !wanted) {
        return c.json({ error: "a date looks like 2026-03-31" }, 400);
      }
      if (wanted && wanted.getTime() > Date.now()) {
        // Closing the future would stop today's invoice being raised, and the
        // person who did it would have no idea why.
        return c.json(
          { error: "the books cannot be closed into the future" },
          400,
        );
      }

      await db
        .insert(schema.ledgerSettings)
        .values({ organizationId: orgId, closedThrough: wanted })
        .onConflictDoUpdate({
          target: schema.ledgerSettings.organizationId,
          set: { closedThrough: wanted, updatedAt: new Date() },
        });

      return c.json({
        closedThrough: wanted ? wanted.toISOString().slice(0, 10) : null,
      });
    },
  );
}
