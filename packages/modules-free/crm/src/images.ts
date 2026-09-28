/**
 * A picture on a contact or a company.
 *
 * The work of turning an upload into something safe to serve — decode,
 * straighten, shrink, re-encode as WebP — belongs to the platform rather than
 * to the CRM, and lives in the module SDK. A shop keeps product photographs
 * the same way, and two copies of that is how one of them loses the size check.
 *
 * What is left here is the part that is about contacts and companies: which
 * column each keeps its picture in, and where on disk they go.
 */
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, schema } from "@sentrello/db";
import type { ModuleContext } from "@sentrello/module-sdk";
import {
  AVATAR_RULES,
  type ProcessedImage,
  processImage,
} from "@sentrello/module-sdk";

/** Beside the note attachments, under the data directory. */
const imagesDir = () =>
  join(resolve(process.env.SENTRELLO_DATA_DIR ?? "/data"), "crm-images");

/** What a face or a logo may weigh on the way in. */
export const MAX_IMAGE_BYTES = AVATAR_RULES.maxBytes;

/**
 * Reading the stored name off either row.
 *
 * A contact and a company are different shapes, and TypeScript will not index
 * one union with the other's key. Naming both columns here is more honest than
 * casting the row away, and it fails loudly if either is ever renamed.
 */
type Pictured = { avatarPath?: string | null; logoPath?: string | null };
const storedName = (row: Pictured, column: "avatarPath" | "logoPath") =>
  row[column] ?? null;

/** The two things that can carry a picture, and the column each keeps it in. */
const SUBJECTS = {
  contacts: { table: schema.contacts, column: "avatarPath" as const },
  companies: { table: schema.companies, column: "logoPath" as const },
};
type Subject = keyof typeof SUBJECTS;

export function registerCrmImages(ctx: ModuleContext) {
  for (const subject of Object.keys(SUBJECTS) as Subject[]) {
    const { table, column } = SUBJECTS[subject];

    ctx.app.post(
      `/api/crm/${subject}/:id/image`,
      requireSession(),
      requirePermission({ crm: ["update"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const id = c.req.param("id");

        const [row] = await db
          .select()
          .from(table)
          .where(and(eq(table.id, id), eq(table.organizationId, orgId)))
          .limit(1);
        if (!row) return c.json({ error: "not found" }, 404);

        const form = await c.req.formData().catch(() => null);
        const file = form?.get("image");
        if (!(file instanceof File)) {
          return c.json({ error: "no image was sent" }, 400);
        }

        let processed: ProcessedImage;
        try {
          processed = await processImage(
            new Uint8Array(await file.arrayBuffer()),
          );
        } catch (err) {
          if (err instanceof RangeError) {
            return c.json({ error: err.message }, 400);
          }
          throw err;
        }

        // Generated, never the uploaded name: nothing a caller sends should
        // ever decide where a file lands.
        const name = `${crypto.randomUUID()}.webp`;
        await mkdir(imagesDir(), { recursive: true });
        await writeFile(join(imagesDir(), name), processed.bytes);

        const previous = storedName(row, column);
        await db
          .update(table)
          .set({ [column]: name })
          .where(and(eq(table.id, id), eq(table.organizationId, orgId)));

        // The one it replaced is now unreachable. Left behind it would be a
        // disk that only ever grows.
        if (previous) {
          await unlink(join(imagesDir(), previous)).catch(() => {});
        }

        return c.json({
          path: name,
          width: processed.width,
          height: processed.height,
          bytes: processed.bytes.byteLength,
        });
      },
    );

    ctx.app.delete(
      `/api/crm/${subject}/:id/image`,
      requireSession(),
      requirePermission({ crm: ["update"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const id = c.req.param("id");

        const [row] = await db
          .select()
          .from(table)
          .where(and(eq(table.id, id), eq(table.organizationId, orgId)))
          .limit(1);
        if (!row) return c.json({ error: "not found" }, 404);
        const existing = storedName(row, column);
        if (!existing) return c.json({ error: "there is no picture" }, 404);

        await db
          .update(table)
          .set({ [column]: null })
          .where(and(eq(table.id, id), eq(table.organizationId, orgId)));
        await unlink(join(imagesDir(), existing)).catch(() => {});
        return c.json({ removed: true });
      },
    );

    /**
     * Serving one back.
     *
     * Behind the same permission as reading the record: a picture of somebody's
     * customer is customer data. The filename is a UUID this process generated
     * and is checked against the record rather than trusted from the URL, so
     * there is nothing to traverse with.
     */
    ctx.app.get(
      `/api/crm/${subject}/:id/image`,
      requireSession(),
      requirePermission({ crm: ["read"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const [row] = await db
          .select()
          .from(table)
          .where(
            and(
              eq(table.id, c.req.param("id")),
              eq(table.organizationId, orgId),
            ),
          )
          .limit(1);
        const stored = row ? storedName(row, column) : null;
        if (!stored) return c.json({ error: "not found" }, 404);

        const file = Bun.file(join(imagesDir(), stored));
        if (!(await file.exists())) return c.json({ error: "not found" }, 404);

        return new Response(file.stream(), {
          headers: {
            "content-type": "image/webp",
            // The name changes whenever the picture does, so the old one can
            // be cached hard and a new one is never stale.
            "cache-control": "private, max-age=31536000, immutable",
            "content-security-policy": "default-src 'none'",
            "x-content-type-options": "nosniff",
          },
        });
      },
    );
  }
}
