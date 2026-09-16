import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, schema } from "@sentrello/db";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";
import { and, asc, eq } from "drizzle-orm";

/**
 * A list screen's state, kept under a name.
 *
 * "My open deals over five thousand" is a question somebody asks every
 * Monday, and until now the answer lived in whichever filters they could
 * remember setting. A view is that state — search, sort, filters, grouping —
 * named and replayed, not a second query language: applying one sends the
 * server exactly the parameters the screen would have sent by hand, so a
 * view can never do anything the list itself cannot.
 *
 * Views belong to a person inside an organization. They are how one person
 * works, not configuration of the business — so the owner is the platform
 * user from the session, never a notion of identity invented here, and
 * nobody is handed a colleague's saved worries.
 */

/** The lists a view can be a view of. */
const RESOURCES = ["contacts", "companies", "deals"] as const;

/**
 * The stored state, reduced to what the list machinery actually sends.
 *
 * Stored as data and replayed into a query string later, so anything that is
 * not a plain string in a known slot is dropped rather than kept — a view is
 * somebody's saved filters, not a place to park a payload.
 */
function cleanView(raw: unknown): Record<string, unknown> {
  const source = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof source.q === "string") out.q = source.q.slice(0, 200);
  if (typeof source.sort === "string") out.sort = source.sort.slice(0, 60);
  if (source.order === "asc" || source.order === "desc") {
    out.order = source.order;
  }
  if (typeof source.groupBy === "string") {
    out.groupBy = source.groupBy.slice(0, 60);
  }
  if (source.filters && typeof source.filters === "object") {
    const filters: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      source.filters as Record<string, unknown>,
    ).slice(0, 20)) {
      if (typeof value === "string")
        filters[key.slice(0, 60)] = value.slice(0, 200);
    }
    out.filters = filters;
  }
  return out;
}

export function registerSavedViews(ctx: ModuleContext) {
  ctx.app.get(
    "/api/crm/views",
    requireSession(),
    requirePermission({ crm: ["read"] }),
    async (c: RouteContext) => {
      const session = c.get("session");
      const orgId = activeOrganizationId(session);
      const resource = c.req.query("resource");
      const rows = await db
        .select()
        .from(schema.savedViews)
        .where(
          and(
            eq(schema.savedViews.organizationId, orgId),
            eq(schema.savedViews.userId, session.user.id),
            ...(resource ? [eq(schema.savedViews.resource, resource)] : []),
          ),
        )
        .orderBy(asc(schema.savedViews.name));
      return c.json({ views: rows });
    },
  );

  /*
   * Creating a view needs only `crm: read`, deliberately: somebody allowed
   * to look at the book is allowed to remember how they were looking at it.
   * A view changes nothing but its owner's own screen.
   */
  ctx.app.post(
    "/api/crm/views",
    requireSession(),
    requirePermission({ crm: ["read"] }),
    async (c: RouteContext) => {
      const session = c.get("session");
      const orgId = activeOrganizationId(session);
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      const resource = String(body.resource ?? "");
      if (!(RESOURCES as readonly string[]).includes(resource)) {
        return c.json({ error: "that is not a list views exist for" }, 400);
      }
      const name = String(body.name ?? "")
        .trim()
        .slice(0, 80);
      if (!name) return c.json({ error: "a view needs a name" }, 400);

      const [made] = await db
        .insert(schema.savedViews)
        .values({
          organizationId: orgId,
          userId: session.user.id,
          resource,
          name,
          view: cleanView(body.view),
        })
        .returning();
      return c.json({ view: made }, 201);
    },
  );

  /** Save the screen's current state into an existing view. */
  ctx.app.patch(
    "/api/crm/views/:id",
    requireSession(),
    requirePermission({ crm: ["read"] }),
    async (c: RouteContext) => {
      const session = c.get("session");
      const orgId = activeOrganizationId(session);
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const [row] = await db
        .update(schema.savedViews)
        .set({ view: cleanView(body.view), updatedAt: new Date() })
        .where(
          and(
            eq(schema.savedViews.id, c.req.param("id") ?? ""),
            eq(schema.savedViews.organizationId, orgId),
            // Only the owner: a view is personal, so even a colleague with
            // every permission edits their own, not this one.
            eq(schema.savedViews.userId, session.user.id),
          ),
        )
        .returning();
      if (!row) return c.json({ error: "not found" }, 404);
      return c.json({ view: row });
    },
  );

  ctx.app.delete(
    "/api/crm/views/:id",
    requireSession(),
    requirePermission({ crm: ["read"] }),
    async (c: RouteContext) => {
      const session = c.get("session");
      const orgId = activeOrganizationId(session);
      const [row] = await db
        .delete(schema.savedViews)
        .where(
          and(
            eq(schema.savedViews.id, c.req.param("id") ?? ""),
            eq(schema.savedViews.organizationId, orgId),
            eq(schema.savedViews.userId, session.user.id),
          ),
        )
        .returning();
      if (!row) return c.json({ error: "not found" }, 404);
      return c.json({ ok: true });
    },
  );
}
