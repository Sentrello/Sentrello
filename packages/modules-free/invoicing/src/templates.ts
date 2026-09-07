import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, schema } from "@sentrello/db";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";
import {
  AVATAR_RULES,
  type ProcessedImage,
  processImage,
  rateLimit,
} from "@sentrello/module-sdk";

/**
 * What a business's own documents look like.
 *
 * The reference makes this a HTML body with a template language in it, per template, rendered into
 * the page the customer opens. We do not: that page is same-origin with the
 * application, so a stored `<script>` written by anybody with invoicing:update
 * would run with an administrator's session the first time they previewed it.
 * A permission to edit invoice wording is not a permission to do anything.
 *
 * What a small business actually wants is its logo, its colour and its own
 * wording, and those can be held as fields and escaped on the way out. If
 * somebody genuinely needs arbitrary layout, that is a template *file* shipped
 * with a module, not a text box on a settings screen.
 */

/** Beside the CRM's pictures, under the data directory. */
const logosDir = () =>
  join(resolve(process.env.SENTRELLO_DATA_DIR ?? "/data"), "invoice-logos");

const PAPER = ["letter", "a4"] as const;

/**
 * The layouts we ship, by name.
 *
 * Kept here as well as in share.ts so the validator refuses a name that has no
 * stylesheet behind it: a template saved with a layout nothing renders is a
 * document that quietly falls back to plain and a business that cannot see
 * why.
 */
const LAYOUT_NAMES = ["classic", "modern", "compact"] as const;

/**
 * A colour, or nothing.
 *
 * It is written into a stylesheet, so anything that is not plainly a hex
 * colour is refused rather than escaped and hoped about: `red;}body{...` is a
 * perfectly ordinary-looking string that would otherwise rewrite the page.
 */
export function validColour(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(trimmed) ? trimmed : null;
}

export function validateTemplate(body: Record<string, unknown>): {
  error?: string;
  values?: {
    name: string;
    appliesTo: string;
    accentColor: string | null;
    headerNote: string | null;
    footerNote: string | null;
    paperSize: string;
    layout: string;
  };
} {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { error: "give it a name" };

  if (body.accentColor && !validColour(body.accentColor)) {
    return { error: "a colour looks like #1d4ed8" };
  }

  const paperSize =
    typeof body.paperSize === "string" &&
    (PAPER as readonly string[]).includes(body.paperSize)
      ? body.paperSize
      : "letter";

  const appliesTo =
    body.appliesTo === "quote" || body.appliesTo === "statement"
      ? body.appliesTo
      : "invoice";

  const layout =
    typeof body.layout === "string" &&
    (LAYOUT_NAMES as readonly string[]).includes(body.layout)
      ? body.layout
      : "classic";

  const text = (value: unknown) =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : null;

  return {
    values: {
      name,
      appliesTo,
      accentColor: validColour(body.accentColor),
      headerNote: text(body.headerNote),
      footerNote: text(body.footerNote),
      paperSize,
      layout,
    },
  };
}

export type Template = typeof schema.documentTemplates.$inferSelect;

/**
 * The template a document is drawn with.
 *
 * The one it names, then the business's default, then nothing — and nothing is
 * a working document, because a business that has never opened this screen
 * still has to be able to send an invoice.
 */
export async function templateFor(
  orgId: string,
  templateId: string | null,
): Promise<Template | null> {
  if (templateId) {
    const [named] = await db
      .select()
      .from(schema.documentTemplates)
      .where(
        and(
          eq(schema.documentTemplates.id, templateId),
          eq(schema.documentTemplates.organizationId, orgId),
        ),
      )
      .limit(1);
    if (named) return named;
  }

  const [fallback] = await db
    .select()
    .from(schema.documentTemplates)
    .where(
      and(
        eq(schema.documentTemplates.organizationId, orgId),
        eq(schema.documentTemplates.isDefault, true),
      ),
    )
    .limit(1);
  return fallback ?? null;
}

export function registerTemplates(ctx: ModuleContext) {
  ctx.app.get(
    "/api/invoicing/templates",
    requireSession(),
    requirePermission({ invoicing: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const templates = await db
        .select()
        .from(schema.documentTemplates)
        .where(eq(schema.documentTemplates.organizationId, orgId));
      return c.json({ templates });
    },
  );

  ctx.app.post(
    "/api/invoicing/templates",
    requireSession(),
    requirePermission({ invoicing: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const checked = validateTemplate(body);
      if (checked.error || !checked.values) {
        return c.json({ error: checked.error }, 400);
      }

      const [existing] = await db
        .select({ id: schema.documentTemplates.id })
        .from(schema.documentTemplates)
        .where(eq(schema.documentTemplates.organizationId, orgId))
        .limit(1);

      const [template] = await db
        .insert(schema.documentTemplates)
        .values({
          organizationId: orgId,
          ...checked.values,
          // The first one a business makes is the one its documents use:
          // a template nothing points at is a screen somebody filled in for
          // nothing.
          isDefault: !existing,
        })
        .returning();
      return c.json({ template }, 201);
    },
  );

  ctx.app.patch(
    "/api/invoicing/templates/:id",
    requireSession(),
    requirePermission({ invoicing: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const checked = validateTemplate(body);
      if (checked.error || !checked.values) {
        return c.json({ error: checked.error }, 400);
      }

      const [updated] = await db
        .update(schema.documentTemplates)
        .set({ ...checked.values, updatedAt: new Date() })
        .where(
          and(
            eq(schema.documentTemplates.id, c.req.param("id") ?? ""),
            eq(schema.documentTemplates.organizationId, orgId),
          ),
        )
        .returning();
      if (!updated) return c.json({ error: "not found" }, 404);
      return c.json({ template: updated });
    },
  );

  /** Which one new documents are drawn with. Exactly one, always. */
  ctx.app.post(
    "/api/invoicing/templates/:id/default",
    requireSession(),
    requirePermission({ invoicing: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("id") ?? "";

      const [mine] = await db
        .select({ id: schema.documentTemplates.id })
        .from(schema.documentTemplates)
        .where(
          and(
            eq(schema.documentTemplates.id, id),
            eq(schema.documentTemplates.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!mine) return c.json({ error: "not found" }, 404);

      await db.transaction(async (tx) => {
        await tx
          .update(schema.documentTemplates)
          .set({ isDefault: false })
          .where(eq(schema.documentTemplates.organizationId, orgId));
        await tx
          .update(schema.documentTemplates)
          .set({ isDefault: true })
          .where(eq(schema.documentTemplates.id, id));
      });
      return c.json({ isDefault: true });
    },
  );

  ctx.app.delete(
    "/api/invoicing/templates/:id",
    requireSession(),
    requirePermission({ invoicing: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const [gone] = await db
        .delete(schema.documentTemplates)
        .where(
          and(
            eq(schema.documentTemplates.id, c.req.param("id") ?? ""),
            eq(schema.documentTemplates.organizationId, orgId),
          ),
        )
        .returning();
      if (!gone) return c.json({ error: "not found" }, 404);
      if (gone.logoPath) {
        await unlink(join(logosDir(), gone.logoPath)).catch(() => {});
      }
      // Documents that named it fall back to the default, which is why
      // templateFor takes the id rather than trusting it.
      return c.json({ deleted: true });
    },
  );

  ctx.app.post(
    "/api/invoicing/templates/:id/logo",
    requireSession(),
    requirePermission({ invoicing: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("id") ?? "";

      const [template] = await db
        .select()
        .from(schema.documentTemplates)
        .where(
          and(
            eq(schema.documentTemplates.id, id),
            eq(schema.documentTemplates.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!template) return c.json({ error: "not found" }, 404);

      const form = await c.req.formData().catch(() => null);
      const file = form?.get("image");
      if (!(file instanceof File)) {
        return c.json({ error: "no image was sent" }, 400);
      }

      // Decoded and re-encoded, never stored as it arrived: this is the file
      // a stranger's browser will fetch off a public link.
      let processed: ProcessedImage;
      try {
        processed = await processImage(
          new Uint8Array(await file.arrayBuffer()),
          AVATAR_RULES,
        );
      } catch (err) {
        if (err instanceof RangeError)
          return c.json({ error: err.message }, 400);
        throw err;
      }

      const name = `${crypto.randomUUID()}.webp`;
      await mkdir(logosDir(), { recursive: true });
      await writeFile(join(logosDir(), name), processed.bytes);

      await db
        .update(schema.documentTemplates)
        .set({ logoPath: name, updatedAt: new Date() })
        .where(eq(schema.documentTemplates.id, id));
      if (template.logoPath) {
        await unlink(join(logosDir(), template.logoPath)).catch(() => {});
      }

      return c.json({ path: name });
    },
  );

  /**
   * The logo, to anybody holding the link.
   *
   * Public on purpose: it is drawn on the invoice the customer opens, and they
   * have no account. It is a business's own logo, printed on documents it
   * posts to strangers — the thing it least wants kept private. Rate limited
   * all the same, because it is an unauthenticated route that touches disk.
   */
  ctx.app.get("/share/template/:id/logo", async (c: RouteContext) => {
    const limited = rateLimit(
      `logo:${c.req.header("x-real-ip") ?? "anon"}`,
      120,
      60_000,
    );
    if (!limited.allowed) return c.text("Too many requests", 429);

    const [template] = await db
      .select({ logoPath: schema.documentTemplates.logoPath })
      .from(schema.documentTemplates)
      .where(eq(schema.documentTemplates.id, c.req.param("id") ?? ""))
      .limit(1);
    if (!template?.logoPath) return c.notFound();

    const file = Bun.file(join(logosDir(), template.logoPath));
    if (!(await file.exists())) return c.notFound();

    return new Response(file.stream(), {
      headers: {
        "content-type": "image/webp",
        "cache-control": "public, max-age=86400",
        "content-security-policy": "default-src 'none'",
        "x-content-type-options": "nosniff",
      },
    });
  });
}
