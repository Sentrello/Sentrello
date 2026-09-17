import {
  activeOrganizationId,
  mayAccess,
  requireSession,
} from "@sentrello/auth/hono";
import { db, schema } from "@sentrello/db";
import type {
  ModuleContext,
  RouteContext,
  SentrelloEnv,
} from "@sentrello/module-sdk";
import { and, asc, eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";

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
 *
 * **Registered here and addressed as `/api/views`.** This was built for the
 * CRM's three lists and gated on `crm: read`, which quietly meant a bookkeeper
 * who lives in the invoice list could not save one — the table was already
 * generic, the only thing tying it to one module was the door. It is one
 * registration rather than one per module because two modules cannot register
 * the same path, and it sits in the package that already has it rather than
 * moving to a module the permission sweep does not walk.
 */

/** The lists a view can be a view of. */
const RESOURCES = [
  "contacts",
  "companies",
  "deals",
  "invoices",
  "quotes",
] as const;

/**
 * What each list asks of a reader, so the door matches the list behind it.
 *
 * Read permission on the list itself, and nothing more: somebody allowed to
 * look at a list is allowed to remember how they were looking at it, and a
 * view changes nothing but its owner's own screen.
 */
const NEEDS: Record<string, Record<string, string[]>> = {
  contacts: { crm: ["read"] },
  companies: { crm: ["read"] },
  deals: { crm: ["read"] },
  invoices: { invoicing: ["read"] },
  quotes: { invoicing: ["read"] },
};

/**
 * Refuses anybody who may read none of the lists views exist for.
 *
 * A single `requirePermission` cannot say "the CRM's or the invoice list's",
 * and picking one of them is what shut the other module's readers out. The
 * resource-level check is done in each handler against `NEEDS`; this is the
 * outer door, so a member holding nothing is refused before any of them.
 */
function mayUseViews() {
  return createMiddleware<SentrelloEnv>(async (c, next) => {
    const allowed = await Promise.all(
      Object.values(NEEDS).map((need) => mayAccess(c.req.raw.headers, need)),
    );
    if (!allowed.some(Boolean)) return c.json({ error: "forbidden" }, 403);
    await next();
  });
}

/** The one list's own gate, once the request says which list it means. */
async function mayUse(headers: Headers, resource: string): Promise<boolean> {
  const need = NEEDS[resource];
  return need ? mayAccess(headers, need) : false;
}

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
    "/api/views",
    requireSession(),
    mayUseViews(),
    async (c: RouteContext) => {
      const session = c.get("session");
      const orgId = activeOrganizationId(session);
      const resource = c.req.query("resource");
      // Asked for one list in particular: it has to be one this reader may
      // read, or the names somebody gave their saved questions leak.
      if (resource && !(await mayUse(c.req.raw.headers, resource))) {
        return c.json({ error: "forbidden" }, 403);
      }
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
   * Creating a view needs only read on the list it is a view of, deliberately:
   * somebody allowed to look at a list is allowed to remember how they were
   * looking at it. A view changes nothing but its owner's own screen.
   */
  ctx.app.post(
    "/api/views",
    requireSession(),
    mayUseViews(),
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
      if (!(await mayUse(c.req.raw.headers, resource))) {
        return c.json({ error: "forbidden" }, 403);
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
    "/api/views/:id",
    requireSession(),
    mayUseViews(),
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
    "/api/views/:id",
    requireSession(),
    mayUseViews(),
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
