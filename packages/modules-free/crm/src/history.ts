import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, desc, eq, inArray, schema } from "@sentrello/db";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";

/**
 * Everything that happened, in one column.
 *
 * A CRM's real question is "what has gone on with these people", and the
 * answer was spread across four panels: notes here, tasks there, a deal on
 * another screen, an email captured into a fifth. This merges them.
 *
 * Derived from the records rather than kept in a log table of its own. A
 * second table would be a second thing to write to on every path — and the
 * first time somebody forgot, the history would quietly start lying, which is
 * worse than not having one.
 */

export interface HistoryEntry {
  at: string;
  kind: "note" | "email" | "call" | "meeting" | "task" | "deal" | "contact";
  title: string;
  detail?: string | null;
  /** What to open when somebody clicks it. */
  link?: { moduleId: string; recordId: string; title: string } | null;
}

/**
 * Newest first, and stable when two things share a timestamp.
 *
 * Imported records all carry the same created date, and a list that reorders
 * itself between two renders is a list nobody trusts.
 */
export function mergeHistory(entries: HistoryEntry[], limit = 50) {
  return [...entries]
    .sort(
      (a, b) =>
        new Date(b.at).getTime() - new Date(a.at).getTime() ||
        a.title.localeCompare(b.title),
    )
    .slice(0, limit);
}

/** "Called", "Emailed" — the activity types the CRM records. */
const ACTIVITY_KINDS: Record<string, HistoryEntry["kind"]> = {
  call: "call",
  email: "email",
  meeting: "meeting",
  note: "note",
};

export function registerCrmHistory(ctx: ModuleContext) {
  ctx.app.get(
    "/api/crm/history",
    requireSession(),
    requirePermission({ crm: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const contactId = c.req.query("contactId");
      const companyId = c.req.query("companyId");
      const dealId = c.req.query("dealId");

      /**
       * A company's history is its people's history.
       *
       * Nothing is attached to a company directly — notes, tasks and emails
       * all hang from a person — so asking about a company means asking about
       * everybody who works there, or the panel is permanently empty.
       */
      let contactIds: string[] = contactId ? [contactId] : [];
      if (companyId) {
        const people = await db
          .select({ id: schema.contacts.id })
          .from(schema.contacts)
          .where(
            and(
              eq(schema.contacts.organizationId, orgId),
              eq(schema.contacts.companyId, companyId),
            ),
          );
        contactIds = people.map((p) => p.id);
      }

      const scoped = contactIds.length > 0 || Boolean(dealId);

      const [notes, activities, tasks, deals] = await Promise.all([
        db
          .select()
          .from(schema.notes)
          .where(
            and(
              eq(schema.notes.organizationId, orgId),
              scoped
                ? dealId
                  ? and(
                      eq(schema.notes.entityType, "deal"),
                      eq(schema.notes.entityId, dealId),
                    )
                  : and(
                      eq(schema.notes.entityType, "contact"),
                      inArray(schema.notes.entityId, contactIds),
                    )
                : undefined,
            ),
          )
          .orderBy(desc(schema.notes.createdAt))
          .limit(100),
        db
          .select()
          .from(schema.activities)
          .where(
            and(
              eq(schema.activities.organizationId, orgId),
              dealId
                ? eq(schema.activities.dealId, dealId)
                : contactIds.length > 0
                  ? inArray(schema.activities.contactId, contactIds)
                  : undefined,
            ),
          )
          .orderBy(desc(schema.activities.occurredAt))
          .limit(100),
        db
          .select()
          .from(schema.tasks)
          .where(
            and(
              eq(schema.tasks.organizationId, orgId),
              dealId
                ? eq(schema.tasks.dealId, dealId)
                : contactIds.length > 0
                  ? inArray(schema.tasks.contactId, contactIds)
                  : undefined,
            ),
          )
          .limit(100),
        db
          .select()
          .from(schema.deals)
          .where(
            and(
              eq(schema.deals.organizationId, orgId),
              dealId ? eq(schema.deals.id, dealId) : undefined,
              companyId ? eq(schema.deals.companyId, companyId) : undefined,
            ),
          )
          .limit(100),
      ]);

      const entries: HistoryEntry[] = [
        ...notes.map((note) => ({
          at: note.createdAt.toISOString(),
          kind: "note" as const,
          title:
            note.text.length > 120
              ? `${note.text.slice(0, 117)}…`
              : note.text || "A note",
          detail:
            note.attachments && note.attachments.length > 0
              ? `${note.attachments.length} file${note.attachments.length === 1 ? "" : "s"}`
              : null,
        })),
        ...activities.map((activity) => ({
          at: activity.occurredAt.toISOString(),
          kind: ACTIVITY_KINDS[activity.type] ?? ("note" as const),
          title: activity.body ?? activity.type,
          detail: null,
        })),
        ...tasks.flatMap((task) => {
          const rows: HistoryEntry[] = [];
          // A task earns two lines: one when it was set, one when it was
          // finished. "We said we would call, and we did" is the history.
          if (task.doneAt) {
            rows.push({
              at: task.doneAt.toISOString(),
              kind: "task",
              title: `Done: ${task.title}`,
              detail: task.type,
            });
          } else if (task.dueAt) {
            rows.push({
              at: task.dueAt.toISOString(),
              kind: "task",
              title: `Due: ${task.title}`,
              detail: task.type,
            });
          }
          return rows;
        }),
        /**
         * Only the deals these people are actually on.
         *
         * A deal carries its contacts in a JSON column, so the filter happens
         * here rather than in the query. Without it, asking for one person's
         * history returned every deal the business has ever opened — which is
         * how this was found: the panel was right on an empty database and
         * wrong on a real one.
         */
        ...deals
          .filter(
            (deal) =>
              !scoped ||
              Boolean(dealId) ||
              Boolean(companyId) ||
              (deal.contactIds ?? []).some((id) => contactIds.includes(id)),
          )
          .map((deal) => ({
            at: (deal.archivedAt ?? deal.createdAt).toISOString(),
            kind: "deal" as const,
            title: deal.archivedAt
              ? `Filed away: ${deal.name}`
              : `Deal opened: ${deal.name}`,
            detail: deal.stage,
            link: { moduleId: "deals", recordId: deal.id, title: deal.name },
          })),
      ];

      return c.json({ history: mergeHistory(entries) });
    },
  );
}
