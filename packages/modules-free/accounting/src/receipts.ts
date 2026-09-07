import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, isNull, schema } from "@sentrello/db";
import {
  AttachmentError,
  attachmentFile,
  attachmentHeaders,
  storeAttachment,
} from "@sentrello/module-sdk";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";
import { isUuid } from "./chart";

/**
 * The paper behind a figure.
 *
 * Bookkeeping is half arithmetic and half evidence: an inspector, an
 * accountant and a bank all ask for the receipt rather than the entry, and a
 * business that has the entry and not the paper is in the same position as one
 * that has neither. So a transaction or a bill can carry the scan of the
 * document it came from.
 *
 * The storing is the SDK's, unchanged and for good reasons — the name on disk
 * is generated so nothing a caller sends can climb out of the directory, and
 * files come back as downloads with a neutral content type so an uploaded
 * .html cannot run against this origin as the person who opened it. What is
 * this module's job, and cannot be anyone else's, is the permission check on
 * the record the file hangs from.
 */

/** Receipts live apart from note attachments; they are kept for years. */
const FOLDER = "receipts";

type Holder = "transactions" | "bills";

/** The row a receipt hangs from, confirmed to be this business's. */
async function owned(
  orgId: string,
  holder: Holder,
  id: string,
): Promise<{ receiptFileKey: string | null } | null> {
  if (!isUuid(id)) return null;
  if (holder === "transactions") {
    const [row] = await db
      .select({ receiptFileKey: schema.transactions.receiptFileKey })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.id, id),
          eq(schema.transactions.organizationId, orgId),
        ),
      )
      .limit(1);
    return row ?? null;
  }
  const [row] = await db
    .select({ receiptFileKey: schema.bills.receiptFileKey })
    .from(schema.bills)
    .where(
      and(
        eq(schema.bills.id, id),
        eq(schema.bills.organizationId, orgId),
        isNull(schema.bills.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function record(
  orgId: string,
  holder: Holder,
  id: string,
  key: string | null,
): Promise<void> {
  if (holder === "transactions") {
    await db
      .update(schema.transactions)
      .set({ receiptFileKey: key })
      .where(
        and(
          eq(schema.transactions.id, id),
          eq(schema.transactions.organizationId, orgId),
        ),
      );
    return;
  }
  await db
    .update(schema.bills)
    .set({ receiptFileKey: key, updatedAt: new Date() })
    .where(
      and(eq(schema.bills.id, id), eq(schema.bills.organizationId, orgId)),
    );
}

/**
 * The stored path, and the name to hand it back under.
 *
 * Both are kept in one column — `<path>|<name>` — rather than in a table of
 * their own. A receipt belongs to exactly one row and dies with it; a table
 * would be a second row to keep in step for no question it answers.
 */
export function packKey(path: string, name: string): string {
  return `${path}|${name.replace(/\|/g, "-")}`;
}

export function unpackKey(key: string): { path: string; name: string } {
  const bar = key.indexOf("|");
  return bar === -1
    ? { path: key, name: "receipt" }
    : { path: key.slice(0, bar), name: key.slice(bar + 1) };
}

export function registerReceipts(ctx: ModuleContext) {
  for (const holder of ["transactions", "bills"] as const) {
    ctx.app.post(
      `/api/${holder}/:id/receipt`,
      requireSession(),
      requirePermission({ bookkeeping: ["update"] }),
      async (c: RouteContext) => {
        const orgId = activeOrganizationId(c.get("session"));
        const id = c.req.param("id") ?? "";
        if (!(await owned(orgId, holder, id))) {
          return c.json({ error: "not found" }, 404);
        }

        const form = await c.req.formData().catch(() => null);
        const file = form?.get("file");
        if (!(file instanceof File)) {
          return c.json({ error: "a file" }, 400);
        }

        try {
          const stored = await storeAttachment(orgId, file, FOLDER);
          await record(orgId, holder, id, packKey(stored.path, stored.name));
          return c.json(
            { receipt: { name: stored.name, size: stored.size } },
            201,
          );
        } catch (err) {
          if (err instanceof AttachmentError) {
            return c.json({ error: err.message }, 400);
          }
          throw err;
        }
      },
    );

    ctx.app.get(
      `/api/${holder}/:id/receipt`,
      requireSession(),
      // Read, not update: whoever may see the books may see what is behind a
      // figure in them. The check is on the record, because the file has no
      // owner of its own.
      requirePermission({ bookkeeping: ["read"] }),
      async (c: RouteContext) => {
        const orgId = activeOrganizationId(c.get("session"));
        const id = c.req.param("id") ?? "";
        const row = await owned(orgId, holder, id);
        if (!row?.receiptFileKey) return c.json({ error: "not found" }, 404);

        const { path, name } = unpackKey(row.receiptFileKey);
        const file = attachmentFile(path, FOLDER);
        if (!file || !(await file.exists())) {
          return c.json({ error: "not found" }, 404);
        }
        return new Response(file, { headers: attachmentHeaders(name) });
      },
    );

    ctx.app.delete(
      `/api/${holder}/:id/receipt`,
      requireSession(),
      requirePermission({ bookkeeping: ["update"] }),
      async (c: RouteContext) => {
        const orgId = activeOrganizationId(c.get("session"));
        const id = c.req.param("id") ?? "";
        const row = await owned(orgId, holder, id);
        if (!row) return c.json({ error: "not found" }, 404);
        /**
         * The row forgets the file; the file itself stays on disk.
         *
         * Deleting the bytes when somebody detaches a receipt is how a
         * mis-click loses the only copy of a document a business is required
         * to keep for years. Housekeeping can reclaim orphans later; nothing
         * about a wrong figure is worth destroying evidence over.
         */
        await record(orgId, holder, id, null);
        return c.json({ detached: true });
      },
    );
  }
}
