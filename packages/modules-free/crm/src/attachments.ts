import { join, resolve } from "node:path";
import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, schema } from "@sentrello/db";
import {
  MAX_ATTACHMENT_BYTES,
  attachmentsDir,
  displayFilename,
  safeExtension,
  storeAttachment,
} from "@sentrello/module-sdk";
import type { ModuleContext } from "@sentrello/module-sdk";
import { and, eq } from "drizzle-orm";

/**
 * Files on notes.
 *
 * A quote, a photo of the damp patch, a signed job sheet. Kept on disk under
 * the data directory and recorded on the note as a path — not as bytes in a
 * column, which would bloat every backup and every query that touches the row.
 *
 * Three things here are security, not housekeeping:
 *
 *  - the stored filename is generated, never the one that was uploaded, so
 *    nothing a caller sends can climb out of the directory;
 *  - files come back as downloads with a neutral content type, so an uploaded
 *    .html or .svg cannot execute against this origin as the signed-in user;
 *  - reading one requires permission on the note it hangs from, since the
 *    files themselves have no owner of their own.
 */

/**
 * The pieces that used to live here now live in the module SDK.
 *
 * Every module that keeps files has the same three problems — a generated
 * name, a size cap, and a neutral content type on the way out — and this was
 * the only solution to them. Moved rather than copied, because the copy that
 * gets made is the one that loses the size check. Re-exported so nothing that
 * imported them from here has to change.
 */
export { MAX_ATTACHMENT_BYTES, displayFilename, safeExtension };

export function registerAttachments(ctx: ModuleContext) {
  ctx.app.post(
    "/api/notes/:id/attachments",
    requireSession(),
    requirePermission({ crm: ["update"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const noteId = c.req.param("id");

      const [note] = await db
        .select()
        .from(schema.notes)
        .where(
          and(
            eq(schema.notes.id, noteId),
            eq(schema.notes.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!note) return c.json({ error: "not found" }, 404);

      const body = await c.req.parseBody();
      const file = body.file;
      if (!(file instanceof File)) {
        return c.json({ error: "a file is required" }, 400);
      }
      // The name on disk is ours, the size is capped, and both live in the SDK
      // now: `../../etc/passwd` and a filename full of quotes are a display
      // string by the time this sees them.
      let attachment: Awaited<ReturnType<typeof storeAttachment>>;
      try {
        attachment = await storeAttachment(orgId, file);
      } catch (err) {
        return c.json(
          {
            error: err instanceof Error ? err.message : "that file was refused",
          },
          err instanceof Error && err.message.includes("large") ? 413 : 400,
        );
      }
      const [updated] = await db
        .update(schema.notes)
        .set({ attachments: [...(note.attachments ?? []), attachment] })
        .where(eq(schema.notes.id, noteId))
        .returning();

      return c.json({ note: updated }, 201);
    },
  );

  ctx.app.get(
    "/api/notes/:id/attachments/:index",
    requireSession(),
    requirePermission({ crm: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));

      const [note] = await db
        .select()
        .from(schema.notes)
        .where(
          and(
            eq(schema.notes.id, c.req.param("id")),
            eq(schema.notes.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!note) return c.json({ error: "not found" }, 404);

      const index = Number(c.req.param("index"));
      const attachment = (note.attachments ?? [])[index];
      if (!attachment) return c.json({ error: "not found" }, 404);

      // The path came from the row, not the request — but it is still resolved
      // and checked against the directory, because a row written by an older
      // version is not a promise about today's code.
      const full = resolve(join(attachmentsDir(), attachment.path));
      if (!full.startsWith(resolve(attachmentsDir()))) {
        return c.json({ error: "not found" }, 404);
      }

      const file = Bun.file(full);
      if (!(await file.exists())) {
        // The row survived and the file did not — a half-restored backup, or
        // somebody tidying the disk. Saying so beats a 500.
        return c.json({ error: "that file is no longer on the server" }, 410);
      }
      const bytes = Buffer.from(await file.arrayBuffer());

      return c.body(new Uint8Array(bytes), 200, {
        // Never the uploaded content type. An .html or .svg served back as
        // itself would run as this origin, with the signed-in user's session.
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${attachment.name.replaceAll('"', "")}"`,
        "x-content-type-options": "nosniff",
      });
    },
  );
}
