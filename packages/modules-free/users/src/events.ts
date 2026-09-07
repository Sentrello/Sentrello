import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, schema } from "@sentrello/db";
import {
  type ListSpec,
  allConditions,
  countExpression,
  listParams,
  orderBy,
  pageWindow,
} from "@sentrello/db/list-query";
import { and, eq, gte, lte, or, sql } from "@sentrello/db/orm";
import {
  ACTION_TEXT,
  type SecurityAction,
} from "@sentrello/db/security-events";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";

/**
 * The whole audit log, searchable rather than only skimmable.
 *
 * `GET /api/users`'s Recent-changes card is the last 25 administrative
 * changes — a glance, not an investigation. This is the investigation: every
 * row, filtered to one action, one actor, one subject, or a window of time,
 * paged with the same `list-query.ts` helpers the contacts list uses rather
 * than a second pager written for this one screen.
 */

/**
 * Not sortable by anything a caller chooses — an audit log ordered by
 * anything other than time defeats the reason to read one. `orderBy` still
 * needs a `ListSpec` to fall back to, so `at` is both the only sortable
 * column and the default.
 */
const EVENTS_LIST: ListSpec = {
  sortable: { at: schema.securityEvents.at },
  defaultSort: { field: "at", order: "desc" },
};

/** A `from`/`to` query value, or `undefined` if it does not parse. */
function dateParam(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function registerEvents(ctx: ModuleContext) {
  ctx.app.get(
    "/api/users/events",
    requireSession(),
    // `settings:update`, not `settings:read` — this is the audit log, and
    // `defaults.ts` grants `read` to executives, managers and accounting. A
    // manager forbidden from `GET /api/users` could otherwise read the
    // owner's failed sign-in addresses, every password reset and every role
    // change: the same class of administrative cross-person read as the
    // session list (`sessions.ts:157`), which is already `update`.
    // `GET /api/users/roles/:role` stays at `read` — `GET /api/users/groups`
    // already hands back name and email at `read` (`groups.ts:45`), so that
    // route matches the module's existing posture rather than opening
    // something new.
    requirePermission({ settings: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const query = c.req.query();
      const params = listParams(query);

      const actor = query.actor?.trim() || undefined;
      const subject = query.subject?.trim() || undefined;
      const group = query.group?.trim() || undefined;
      const action = query.action?.trim() || undefined;
      const from = dateParam(query.from);
      const to = dateParam(query.to);

      const where = allConditions([
        eq(schema.securityEvents.organizationId, orgId),
        actor ? eq(schema.securityEvents.actorId, actor) : undefined,
        subject ? eq(schema.securityEvents.subjectId, subject) : undefined,
        /**
         * Everything about one group, which is not the same as everything
         * whose subject is one.
         *
         * `group.created`, `changed` and `deleted` record the group as their
         * subject. `group.joined` and `group.left` record the *person*, since
         * a person is who joined — so a group's own history is split across
         * two ways of being about it, and filtering on `subject` alone shows
         * half of it while looking complete. That is worse than showing
         * nothing: an administrator reading a group's Activity would conclude
         * nobody had ever been added to it.
         *
         * `detail->>'groupId'` is the other half. Compared as text against a
         * uuid rendered as text, which is what `->>` yields.
         */
        group
          ? or(
              eq(schema.securityEvents.subjectId, group),
              sql`${schema.securityEvents.detail} ->> 'groupId' = ${group}`,
            )
          : undefined,
        action ? eq(schema.securityEvents.action, action) : undefined,
        from ? gte(schema.securityEvents.at, from) : undefined,
        to ? lte(schema.securityEvents.at, to) : undefined,
      ]);

      const order = orderBy(EVENTS_LIST, params);
      const toRow = (e: typeof schema.securityEvents.$inferSelect) => ({
        id: e.id,
        at: e.at,
        actorId: e.actorId,
        actor: e.actorName,
        subjectId: e.subjectId,
        subject: e.subjectName,
        action: e.action,
        says: ACTION_TEXT[e.action as SecurityAction] ?? e.action,
        detail: e.detail,
      });

      const window = pageWindow(params);
      if (!window) {
        const rows = await db
          .select()
          .from(schema.securityEvents)
          .where(where)
          .orderBy(order);
        return c.json({ events: rows.map(toRow), total: rows.length });
      }

      // Two queries rather than a window function, matching the CRM list:
      // the count has to ignore the page, and `count(*) over ()` returns
      // nothing at all for a page past the end — the exact moment the
      // browser most needs to be told how many rows really exist.
      const [rows, [counted]] = await Promise.all([
        db
          .select()
          .from(schema.securityEvents)
          .where(where)
          .orderBy(order)
          .limit(window.limit)
          .offset(window.offset),
        db
          .select({ total: countExpression })
          .from(schema.securityEvents)
          .where(where),
      ]);

      return c.json({
        events: rows.map(toRow),
        total: counted?.total ?? 0,
        page: params.page,
        perPage: params.perPage,
      });
    },
  );
}
