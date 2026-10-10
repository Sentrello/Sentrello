import { grantableBy, newApiKey } from "@sentrello/auth/api-keys";
import {
  activeOrganizationId,
  isKeyCaller,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { type DbTx, and, db, desc, eq, isNull, schema } from "@sentrello/db";
import { daysLate } from "@sentrello/db/day";
import { record } from "@sentrello/db/security-events";
import { asText, checkedText, notText } from "@sentrello/db/text-columns";
import { timezoneFor } from "@sentrello/db/timezone";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";
import { idFrom } from "./groups";

/**
 * Keys for scripts, made and taken back here.
 *
 * Behind `settings:update` like everything else in this module, because a key
 * is a way into the business that nobody signs in to — the same weight as
 * inviting somebody. The rules a key lives by at the door are in
 * `@sentrello/auth/api-keys`; this is only the making and the list.
 */

/** `YYYY-MM-DD`, the day a key stops working after. Anything else is refused. */
function expiryDay(raw: unknown): Date | null | "invalid" {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return "invalid";
  }
  const day = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== raw
    ? "invalid"
    : day;
}

/**
 * Every working key a person made here, taken back.
 *
 * For the moment they are removed or suspended. Their keys already stop at
 * the door while they are not a working member, but only by that check: a
 * person let back in a year later would find every key they ever made alive
 * again, in whatever scripts still hold them. Revoked, they stay revoked.
 *
 * Inside the caller's transaction, so a removal never lands without this. The
 * audit lines are the caller's to write once the transaction has committed,
 * from what this returns.
 */
export async function revokeKeysOf(
  tx: DbTx,
  organizationId: string,
  userId: string,
  revokedBy: string,
): Promise<{ id: string; name: string; prefix: string }[]> {
  return tx
    .update(schema.apiKeys)
    .set({ revokedAt: new Date(), revokedBy })
    .where(
      and(
        eq(schema.apiKeys.organizationId, organizationId),
        eq(schema.apiKeys.createdBy, userId),
        isNull(schema.apiKeys.revokedAt),
      ),
    )
    .returning({
      id: schema.apiKeys.id,
      name: schema.apiKeys.name,
      prefix: schema.apiKeys.prefix,
    });
}

/** The audit lines for keys `revokeKeysOf` took back, and why. */
export async function recordKeysRevoked(
  organizationId: string,
  actor: { id: string; name?: string | null; email?: string | null },
  keys: { id: string; name: string; prefix: string }[],
  because: "member.removed" | "account.disabled",
): Promise<void> {
  for (const key of keys) {
    await record({
      organizationId,
      actor,
      subject: { id: key.id, name: key.name, email: null },
      action: "api-key.revoked",
      detail: { prefix: key.prefix, because },
    });
  }
}

export function registerApiKeys(ctx: ModuleContext) {
  ctx.app.get(
    "/api/users/api-keys",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const rows = await db
        .select({
          id: schema.apiKeys.id,
          name: schema.apiKeys.name,
          prefix: schema.apiKeys.prefix,
          permissions: schema.apiKeys.permissions,
          createdBy: schema.apiKeys.createdBy,
          createdByName: schema.user.name,
          createdAt: schema.apiKeys.createdAt,
          lastUsedAt: schema.apiKeys.lastUsedAt,
          expiresOn: schema.apiKeys.expiresOn,
        })
        .from(schema.apiKeys)
        .leftJoin(schema.user, eq(schema.user.id, schema.apiKeys.createdBy))
        .where(
          and(
            eq(schema.apiKeys.organizationId, orgId),
            isNull(schema.apiKeys.revokedAt),
          ),
        )
        .orderBy(desc(schema.apiKeys.createdAt));

      // Past its day is still listed, and says so: revoking it is the tidy
      // end, and a key that vanished on its own leaves somebody wondering
      // whether it was ever made.
      const zone = await timezoneFor(orgId);
      const now = new Date();
      return c.json({
        keys: rows.map((row) => ({
          ...row,
          expired: row.expiresOn
            ? daysLate(row.expiresOn, now, zone) > 0
            : false,
        })),
      });
    },
  );

  ctx.app.post(
    "/api/users/api-keys",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c: RouteContext) => {
      const session = c.get("session");
      const orgId = activeOrganizationId(session);

      /*
       * A key cannot make keys.
       *
       * Its maker can, and a key that held `settings:update` would otherwise
       * mint a second key carrying everything that person holds — wider than
       * the key it came from, which is the one thing a key must never be.
       */
      if (isKeyCaller(c)) {
        return c.json({ error: "an API key cannot make or revoke keys" }, 403);
      }

      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const shaped = checkedText(schema.apiKeys, { name: body.name });
      if (!shaped.ok) return c.json({ error: notText(shaped.field) }, 400);
      const name = asText(body.name, "name").trim().slice(0, 80);
      if (!name) return c.json({ error: "a name is required" }, 400);

      const expiresOn = expiryDay(body.expiresOn);
      if (expiresOn === "invalid") {
        return c.json({ error: "expiresOn must be a day, as YYYY-MM-DD" }, 400);
      }
      if (
        expiresOn &&
        daysLate(expiresOn, new Date(), await timezoneFor(orgId)) > 0
      ) {
        return c.json({ error: "that day has already passed" }, 400);
      }

      const granted = await grantableBy(
        orgId,
        session.user.id,
        body.permissions,
      );
      if (!granted.ok) return c.json({ error: granted.error }, 400);

      const { key, prefix, hash } = newApiKey();
      const [row] = await db
        .insert(schema.apiKeys)
        .values({
          organizationId: orgId,
          name,
          prefix,
          tokenHash: hash,
          permissions: granted.permissions,
          createdBy: session.user.id,
          expiresOn,
        })
        .returning({
          id: schema.apiKeys.id,
          name: schema.apiKeys.name,
          prefix: schema.apiKeys.prefix,
          permissions: schema.apiKeys.permissions,
          createdAt: schema.apiKeys.createdAt,
          expiresOn: schema.apiKeys.expiresOn,
        });

      await record({
        organizationId: orgId,
        actor: session.user,
        subject: { id: row?.id ?? null, name, email: null },
        action: "api-key.created",
        detail: { prefix, permissions: granted.permissions },
      });

      // The only time the key is ever in a response. It is not stored, so
      // there is no second chance to read it.
      return c.json({ key, apiKey: row }, 201);
    },
  );

  ctx.app.delete(
    "/api/users/api-keys/:id",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c: RouteContext) => {
      const session = c.get("session");
      const orgId = activeOrganizationId(session);
      if (isKeyCaller(c)) {
        return c.json({ error: "an API key cannot make or revoke keys" }, 403);
      }
      const id = idFrom(c);
      if (!id) return c.json({ error: "not found" }, 404);

      const [row] = await db
        .update(schema.apiKeys)
        .set({ revokedAt: new Date(), revokedBy: session.user.id })
        .where(
          and(
            eq(schema.apiKeys.id, id),
            eq(schema.apiKeys.organizationId, orgId),
            isNull(schema.apiKeys.revokedAt),
          ),
        )
        .returning({
          name: schema.apiKeys.name,
          prefix: schema.apiKeys.prefix,
        });
      if (!row) return c.json({ error: "not found" }, 404);

      await record({
        organizationId: orgId,
        actor: session.user,
        subject: { id, name: row.name, email: null },
        action: "api-key.revoked",
        detail: { prefix: row.prefix },
      });
      return c.json({ ok: true });
    },
  );
}
