import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
/**
 * The access point a business brings with it, connected from its own screen.
 *
 * Authorise, store, test, sandbox, then live — the same shape as every other
 * third-party connection in the product, and the shape the platform's build
 * rules ask for. Nobody edits a `.env` on a server they may not have shell
 * access to.
 *
 * **No key in this repository, and none in any build.** The key is the
 * customer's own, sealed in their own database, used only to send their own
 * invoices.
 */
import { and, db, eq, schema } from "@sentrello/db";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";
import { secrets } from "@sentrello/module-sdk";
import { transportFor, transports } from "./einvoice-transport";

/** What the screen is told. Never the key: a hint is enough to recognise it. */
async function connectionFor(orgId: string) {
  const [row] = await db
    .select()
    .from(schema.peppolConnections)
    .where(eq(schema.peppolConnections.organizationId, orgId))
    .limit(1);
  if (!row) return null;
  return {
    provider: row.provider,
    legalEntityId: row.legalEntityId,
    sandbox: row.sandbox,
    /*
     * The last four characters, which is how somebody tells the key they
     * pasted from the one they meant to. The whole key never leaves the
     * database — not to the screen, not into a log, not into a support
     * conversation.
     */
    keyHint: secrets.hint(secrets.open(row.apiKey)),
    checkedAt: row.checkedAt,
    lastError: row.lastError,
    connectedAt: row.connectedAt,
  };
}

export function registerPeppol(ctx: ModuleContext) {
  ctx.app.get(
    "/api/einvoice/connection",
    requireSession(),
    requirePermission({ invoicing: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      return c.json({
        connection: await connectionFor(orgId),
        /*
         * What this build can talk to, so the screen offers a list rather
         * than hard-coding a name that a later release might not be the
         * only one of.
         */
        providers: transports().map((t) => ({ id: t.id, label: t.label })),
      });
    },
  );

  ctx.app.put(
    "/api/einvoice/connection",
    requireSession(),
    requirePermission({ invoicing: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as {
        provider?: string;
        apiKey?: string;
        legalEntityId?: string;
        sandbox?: boolean;
      };

      const provider = transportFor(body.provider ?? "storecove");
      if (!provider) {
        return c.json({ error: "this instance has no such access point" }, 400);
      }
      const apiKey = (body.apiKey ?? "").trim();
      const legalEntityId = (body.legalEntityId ?? "").trim();
      if (!apiKey || !legalEntityId) {
        return c.json(
          {
            error:
              "Both the API key and the legal entity id come from the access point's own dashboard, and neither works without the other.",
          },
          400,
        );
      }
      if (!secrets.secretsAvailable()) {
        return c.json(
          {
            error:
              "This instance cannot store a credential safely yet: set SENTRELLO_SECRET_KEY, or BETTER_AUTH_SECRET, and restart.",
          },
          400,
        );
      }

      const sandbox = body.sandbox !== false;

      /*
       * Tried before it is saved.
       *
       * A connection that is written first and checked later is a settings
       * screen that says "connected" over a key that has never worked. The
       * name that comes back is also the confirmation that the key and the
       * entity id belong to each other, which is the ordinary mistake.
       */
      let name = "";
      try {
        const checked = await provider.check({
          apiKey,
          legalEntityId,
          sandbox,
        });
        name = checked.name;
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }

      const values = {
        organizationId: orgId,
        provider: provider.id,
        apiKey: secrets.seal(apiKey),
        legalEntityId,
        sandbox,
        checkedAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      };
      await db
        .insert(schema.peppolConnections)
        .values(values)
        .onConflictDoUpdate({
          target: schema.peppolConnections.organizationId,
          set: values,
        });

      return c.json({ connection: await connectionFor(orgId), name });
    },
  );

  /**
   * Asking again, without changing anything.
   *
   * A key that has been revoked answers 401 and nothing else changes, so
   * the first sign is otherwise an invoice that did not arrive.
   */
  ctx.app.post(
    "/api/einvoice/connection/test",
    requireSession(),
    requirePermission({ invoicing: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const [row] = await db
        .select()
        .from(schema.peppolConnections)
        .where(eq(schema.peppolConnections.organizationId, orgId))
        .limit(1);
      if (!row) return c.json({ error: "nothing is connected" }, 404);
      const provider = transportFor(row.provider);
      if (!provider) {
        return c.json(
          { error: `this instance no longer has ${row.provider}` },
          400,
        );
      }

      try {
        const checked = await provider.check({
          apiKey: secrets.open(row.apiKey),
          legalEntityId: row.legalEntityId,
          sandbox: row.sandbox,
        });
        await db
          .update(schema.peppolConnections)
          .set({ checkedAt: new Date(), lastError: null })
          .where(eq(schema.peppolConnections.organizationId, orgId));
        return c.json({ ok: true, name: checked.name });
      } catch (err) {
        const message = (err as Error).message;
        // Written down, so the screen says so on arrival rather than only
        // to whoever happened to press the button.
        await db
          .update(schema.peppolConnections)
          .set({ checkedAt: new Date(), lastError: message })
          .where(eq(schema.peppolConnections.organizationId, orgId));
        return c.json({ ok: false, error: message }, 400);
      }
    },
  );

  ctx.app.delete(
    "/api/einvoice/connection",
    requireSession(),
    requirePermission({ invoicing: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      await db
        .delete(schema.peppolConnections)
        .where(eq(schema.peppolConnections.organizationId, orgId));
      /*
       * The submissions stay. They are the record that an invoice was
       * delivered, which outlives the connection it went through and is
       * the answer to "we never received it".
       */
      return c.json({ ok: true });
    },
  );

  ctx.app.get(
    "/api/invoices/:id/einvoice/submissions",
    requireSession(),
    requirePermission({ invoicing: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const rows = await db
        .select()
        .from(schema.peppolSubmissions)
        .where(
          and(
            eq(schema.peppolSubmissions.organizationId, orgId),
            eq(schema.peppolSubmissions.invoiceId, c.req.param("id") ?? ""),
          ),
        );
      return c.json({ submissions: rows });
    },
  );
}
