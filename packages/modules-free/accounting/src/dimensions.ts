import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, asc, db, eq, isNull, schema } from "@sentrello/db";
import type {
  ModuleContext,
  RouteContext,
  SentrelloEnv,
} from "@sentrello/module-sdk";
import type { MiddlewareHandler } from "hono";

/**
 * Which part of the business a figure belongs to.
 *
 * A builder wants to know whether the kitchen job made money. A shop with two
 * branches wants each one's profit and loss on its own. Neither is answerable
 * from a chart of accounts, because an account says *what* was spent and this
 * says *which part of the business* spent it — so a business that needs both
 * ends up inventing "Fuel — Branch A" and "Fuel — Branch B" and doubling its
 * chart every time it opens a shop.
 *
 * Two kinds, used together and meaning different things. A class is a job, a
 * project, a department, a product line; a location is a branch, a van, a site.
 *
 * They live on the journal line rather than the entry, because one bill can
 * cover two jobs and a business forced to split it into two bills to report on
 * them stops bothering.
 */
export const KINDS = ["class", "location"] as const;
export type DimensionKind = (typeof KINDS)[number];

export function registerDimensions(
  ctx: ModuleContext,
  proOnly: MiddlewareHandler<SentrelloEnv>,
) {
  ctx.app.get(
    "/api/dimensions",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const includeArchived = c.req.query("archived") === "yes";
      const rows = await db
        .select()
        .from(schema.dimensions)
        .where(
          and(
            eq(schema.dimensions.organizationId, orgId),
            ...(includeArchived ? [] : [isNull(schema.dimensions.archivedAt)]),
          ),
        )
        .orderBy(asc(schema.dimensions.kind), asc(schema.dimensions.name));
      return c.json({ dimensions: rows });
    },
  );

  ctx.app.post(
    "/api/dimensions",
    requireSession(),
    requirePermission({ bookkeeping: ["create"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      const kind = String(body.kind ?? "");
      if (!KINDS.includes(kind as DimensionKind)) {
        return c.json({ error: "a class or a location" }, 400);
      }
      const name = String(body.name ?? "")
        .trim()
        .slice(0, 80);
      if (!name) return c.json({ error: "give it a name" }, 400);

      const [clash] = await db
        .select({ id: schema.dimensions.id })
        .from(schema.dimensions)
        .where(
          and(
            eq(schema.dimensions.organizationId, orgId),
            eq(schema.dimensions.kind, kind),
            eq(schema.dimensions.name, name),
            isNull(schema.dimensions.archivedAt),
          ),
        )
        .limit(1);
      if (clash) {
        // Two live classes with one name is a report split in half and nobody
        // able to tell which half is which.
        return c.json({ error: `there is already a ${kind} called that` }, 409);
      }

      const [made] = await db
        .insert(schema.dimensions)
        .values({
          organizationId: orgId,
          kind,
          name,
          code: body.code ? String(body.code).trim().slice(0, 20) : null,
        })
        .returning();
      return c.json({ dimension: made }, 201);
    },
  );

  /**
   * Retiring one, which is the only way it ever goes away.
   *
   * A job that ended still has a year of figures posted against it. Deleting it
   * would leave every one of them pointing at nothing, and the report that
   * explained last year's profit would stop explaining it.
   */
  ctx.app.post(
    "/api/dimensions/:id/archive",
    requireSession(),
    requirePermission({ bookkeeping: ["update"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const [row] = await db
        .update(schema.dimensions)
        .set({ archivedAt: body.archived === false ? null : new Date() })
        .where(
          and(
            eq(schema.dimensions.id, c.req.param("id") ?? ""),
            eq(schema.dimensions.organizationId, orgId),
          ),
        )
        .returning();
      if (!row) return c.json({ error: "not found" }, 404);
      return c.json({ dimension: row });
    },
  );
}

/**
 * A class or a location this business has, checked before anything posts to it.
 *
 * An archived one is still valid to post against — a job closed in March can
 * still receive a correcting entry in April, and refusing that would send
 * somebody to un-archive a job to fix a typo.
 */
export async function ownedDimension(
  organizationId: string,
  kind: DimensionKind,
  id: unknown,
): Promise<string | null | "unknown"> {
  if (id === undefined || id === null || id === "") return null;
  const [row] = await db
    .select({ id: schema.dimensions.id })
    .from(schema.dimensions)
    .where(
      and(
        eq(schema.dimensions.id, String(id)),
        eq(schema.dimensions.organizationId, organizationId),
        eq(schema.dimensions.kind, kind),
      ),
    )
    .limit(1);
  return row ? row.id : "unknown";
}

export interface Tagging {
  classId: string | null;
  locationId: string | null;
}

/**
 * The class and location on a request, both checked.
 *
 * Returned together because they are used together, and refused as a pair: a
 * request naming a location that is not this business's should not quietly
 * post with the class it did get right.
 */
export async function taggingFrom(
  organizationId: string,
  body: Record<string, unknown>,
): Promise<Tagging | { error: string }> {
  const classId = await ownedDimension(organizationId, "class", body.classId);
  if (classId === "unknown") {
    return { error: "that is not a class of yours" };
  }
  const locationId = await ownedDimension(
    organizationId,
    "location",
    body.locationId,
  );
  if (locationId === "unknown") {
    return { error: "that is not a location of yours" };
  }
  return { classId, locationId };
}
