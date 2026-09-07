import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, inArray, schema } from "@sentrello/db";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";

/**
 * The CRM's tags, on invoices and quotes.
 *
 * The reference product has its own `tags` table; we already have one, and a
 * module that keeps a second list of labels is a second place to rename
 * "Overdue — chase" and miss half of them. `taggables` was built with an
 * `entity_type` for exactly this, so an invoice is one more kind of thing that
 * can wear a label rather than a new mechanism.
 *
 * The tag is checked against the session's organisation before anything is
 * written. Without that check a guessed id would let one business label
 * another's documents — the same reason the CRM's own routes do it twice, on
 * the way in and on the way out.
 */

export const TAGGABLE_DOCUMENTS = [
  ["invoices", "invoice"],
  ["quotes", "quote"],
] as const;

/** The tags on a set of documents, ready to hang off list rows. */
export async function tagsFor(
  orgId: string,
  entityType: string,
  ids: string[],
): Promise<Map<string, { id: string; name: string; color: string }[]>> {
  const out = new Map<string, { id: string; name: string; color: string }[]>();
  if (ids.length === 0) return out;

  const rows = await db
    .select({
      entityId: schema.taggables.entityId,
      id: schema.tags.id,
      name: schema.tags.name,
      color: schema.tags.color,
    })
    .from(schema.taggables)
    .innerJoin(schema.tags, eq(schema.tags.id, schema.taggables.tagId))
    .where(
      and(
        eq(schema.taggables.entityType, entityType),
        inArray(schema.taggables.entityId, ids),
        eq(schema.tags.organizationId, orgId),
      ),
    );

  for (const row of rows) {
    const list = out.get(row.entityId) ?? [];
    list.push({ id: row.id, name: row.name, color: row.color });
    out.set(row.entityId, list);
  }
  return out;
}

export function registerDocumentTags(ctx: ModuleContext) {
  // Three plain paths rather than one clever pattern: the CRM learned that a
  // parameterised `:entityType{...}` is not valid Hono and takes the whole
  // router down with it, not just the route that wrote it.
  for (const [plural, entityType] of TAGGABLE_DOCUMENTS) {
    ctx.app.post(
      `/api/${plural}/:id/tags`,
      requireSession(),
      requirePermission({ invoicing: ["update"] }),
      async (c: RouteContext) => {
        const orgId = activeOrganizationId(c.get("session"));
        const entityId = c.req.param("id") ?? "";
        const body = (await c.req.json().catch(() => ({}))) as {
          tagId?: string;
        };
        if (!body.tagId) return c.json({ error: "a tagId is required" }, 400);

        const [tag] = await db
          .select()
          .from(schema.tags)
          .where(
            and(
              eq(schema.tags.id, body.tagId),
              eq(schema.tags.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!tag) return c.json({ error: "no such tag" }, 404);

        // The document has to be this organisation's too, or a guessed id
        // would attach one business's label to another's invoice.
        const table = plural === "invoices" ? schema.invoices : schema.quotes;
        const [document] = await db
          .select({ id: table.id })
          .from(table)
          .where(and(eq(table.id, entityId), eq(table.organizationId, orgId)))
          .limit(1);
        if (!document) return c.json({ error: "not found" }, 404);

        // Tagging twice is somebody clicking twice, not an error. A second row
        // would show the same label on the document twice.
        const [existing] = await db
          .select()
          .from(schema.taggables)
          .where(
            and(
              eq(schema.taggables.tagId, tag.id),
              eq(schema.taggables.entityType, entityType),
              eq(schema.taggables.entityId, entityId),
            ),
          )
          .limit(1);
        if (existing) return c.json({ tag });

        await db
          .insert(schema.taggables)
          .values({ tagId: tag.id, entityType, entityId });
        return c.json({ tag }, 201);
      },
    );

    ctx.app.delete(
      `/api/${plural}/:id/tags/:tagId`,
      requireSession(),
      requirePermission({ invoicing: ["update"] }),
      async (c: RouteContext) => {
        const orgId = activeOrganizationId(c.get("session"));
        const [tag] = await db
          .select()
          .from(schema.tags)
          .where(
            and(
              eq(schema.tags.id, c.req.param("tagId") ?? ""),
              eq(schema.tags.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!tag) return c.json({ error: "no such tag" }, 404);

        await db
          .delete(schema.taggables)
          .where(
            and(
              eq(schema.taggables.tagId, tag.id),
              eq(schema.taggables.entityType, entityType),
              eq(schema.taggables.entityId, c.req.param("id") ?? ""),
            ),
          );
        return c.body(null, 204);
      },
    );
  }
}
