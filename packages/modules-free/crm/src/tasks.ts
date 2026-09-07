/**
 * The four things anybody does to a task without opening it.
 *
 * Tick it off, push it to tomorrow, push it to next week. Editing and deleting
 * are already the generic CRUD's `PATCH /api/tasks/:id` and
 * `DELETE /api/tasks/:id`, and are deliberately not repeated here — a second
 * implementation of "change this row" is a second set of rules about who may.
 *
 * These exist as their own routes rather than as a PATCH the browser composes
 * because the arithmetic belongs on this side. "Next week" computed in a
 * browser is computed in that browser's time zone, against that browser's
 * clock, and two people looking at the same task would move it to two
 * different days.
 */
import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, schema } from "@sentrello/db";
import type { ModuleContext } from "@sentrello/module-sdk";

const DAY_MS = 86_400_000;

/** How far each interval moves a task. A week is seven days, not five. */
const INTERVALS: Record<string, number> = {
  day: DAY_MS,
  week: 7 * DAY_MS,
};

export function registerTaskActions(ctx: ModuleContext) {
  /**
   * Ticking a task off, and putting it back.
   *
   * One route rather than two because it is one switch, and the body says
   * which way it is being flipped. Absent means done, which is what the
   * checkbox on a list of outstanding work means when somebody clicks it.
   *
   * `doneAt` is cleared on the way back so a task that was ticked by mistake
   * does not keep a completion date it never earned.
   */
  ctx.app.post(
    "/api/tasks/:id/complete",
    requireSession(),
    requirePermission({ crm: ["update"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as { done?: unknown };
      const done = body.done === undefined ? true : body.done !== false;

      const [row] = await db
        .update(schema.tasks)
        .set({ done, doneAt: done ? new Date() : null })
        .where(
          and(
            eq(schema.tasks.id, c.req.param("id")),
            eq(schema.tasks.organizationId, orgId),
          ),
        )
        .returning();

      if (!row) return c.json({ error: "not found" }, 404);
      return c.json({ task: row });
    },
  );

  /**
   * Pushing a task out.
   *
   * Measured from the date it is already due rather than from now, so
   * postponing something twice moves it two days rather than landing it on
   * tomorrow both times.
   *
   * A task with no due date gets one, counted from today. The alternative is a
   * button that does nothing at all, silently, which everybody reads as broken.
   */
  ctx.app.post(
    "/api/tasks/:id/postpone",
    requireSession(),
    requirePermission({ crm: ["update"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as { by?: unknown };
      const step = INTERVALS[String(body.by)];
      if (!step) {
        return c.json({ error: "postpone by a day or by a week" }, 400);
      }

      const [task] = await db
        .select()
        .from(schema.tasks)
        .where(
          and(
            eq(schema.tasks.id, c.req.param("id")),
            eq(schema.tasks.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!task) return c.json({ error: "not found" }, 404);

      const from = task.dueAt ? task.dueAt.getTime() : Date.now();
      const [row] = await db
        .update(schema.tasks)
        .set({ dueAt: new Date(from + step) })
        .where(
          and(
            eq(schema.tasks.id, task.id),
            eq(schema.tasks.organizationId, orgId),
          ),
        )
        .returning();

      return c.json({ task: row });
    },
  );
}
