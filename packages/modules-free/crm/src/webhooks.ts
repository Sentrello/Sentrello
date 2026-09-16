import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, schema } from "@sentrello/db";
import { record } from "@sentrello/db/security-events";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";
import { mayCall, secrets, signOutbound } from "@sentrello/module-sdk";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";

/**
 * Telling the business's own systems that a record changed.
 *
 * The change feed already announces every contact, company and deal write —
 * the whole reason this file is small. What is added here is the outward
 * half: a subscriber table, a signed POST, a retry schedule and a delivery
 * log a person can read, because a webhook a business cannot see failing is
 * one they discover from their own missing data.
 *
 * The feed's `handledAt` belongs to the automation dispatcher and is not
 * touched; each endpoint carries its own cursor into the feed instead, so an
 * endpoint added today does not replay the business's history at whoever
 * just typed the URL.
 */

/** The records an endpoint can ask to hear about. */
export const WEBHOOK_ENTITIES = ["contact", "company", "deal"] as const;

/**
 * Minutes until the next try, by how many tries have already failed.
 *
 * Backing off rather than hammering: a receiver down for a deploy is back
 * within the first two retries, and one down for the day gets a handful of
 * polite attempts instead of a thousand. After the last entry — six attempts
 * across roughly fifteen hours — the delivery is abandoned, and the log says
 * so, because retrying for ever turns one dead endpoint into a permanent
 * background job.
 */
export const RETRY_MINUTES = [1, 5, 30, 120, 720] as const;

/** How long a webhook may wait for somebody else's server. */
const TIMEOUT_MS = 10_000;

/** How many events one endpoint takes off the feed per sweep. */
const FAN_OUT_LIMIT = 500;

/** How many due deliveries one sweep takes on. */
const SWEEP_LIMIT = 100;

/**
 * The record as the receiver may see it.
 *
 * Everything on a contact is the business's own data except the portal
 * token, which is a credential: whoever holds it can open the customer's
 * invoices. A webhook body ends up in the receiver's request logs, which is
 * not where a credential belongs.
 */
function withoutCredentials(
  row: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!row) return null;
  const { portalToken: _credential, ...rest } = row;
  return rest;
}

/**
 * Queue every fresh feed event for every endpoint that wants it.
 *
 * A row per endpoint, not per event: two endpoints are two deliveries with
 * two histories, and one failing must not hide the other succeeding. The
 * cursor moves to the last event taken; the read is `>=` and the unique
 * (webhook, event) pair swallows the overlap, so a crash between the insert
 * and the cursor write costs nothing and doubles nothing.
 */
export async function fanOutDue(): Promise<void> {
  const hooks = await db.select().from(schema.crmWebhooks);

  for (const hook of hooks) {
    if (hook.entities.length === 0) continue;
    const events = await db
      .select()
      .from(schema.recordEvents)
      .where(
        and(
          eq(schema.recordEvents.organizationId, hook.organizationId),
          gte(schema.recordEvents.at, hook.cursorAt),
          inArray(schema.recordEvents.entity, hook.entities),
        ),
      )
      .orderBy(asc(schema.recordEvents.at))
      .limit(FAN_OUT_LIMIT);
    if (events.length === 0) continue;

    // Due now by this process's clock, the same clock the sweep compares
    // against — a containerised database drifts seconds ahead, and a fresh
    // delivery must not sit "not due yet" because of it.
    const now = new Date();
    await db
      .insert(schema.crmWebhookDeliveries)
      .values(
        events.map((event) => ({
          organizationId: hook.organizationId,
          webhookId: hook.id,
          eventId: event.id,
          event: `${event.entity}.${event.action}`,
          payload: {
            event: `${event.entity}.${event.action}`,
            entity: event.entity,
            entityId: event.entityId,
            action: event.action,
            changed: event.changed,
            before: withoutCredentials(event.before ?? null),
            after: withoutCredentials(event.after ?? null),
            at: event.at.toISOString(),
          },
          nextAttemptAt: now,
        })),
      )
      .onConflictDoNothing();

    const last = events[events.length - 1];
    if (last) {
      await db
        .update(schema.crmWebhooks)
        .set({ cursorAt: last.at })
        .where(eq(schema.crmWebhooks.id, hook.id));
    }
  }
}

/**
 * Deliver everything that is due.
 *
 * One pass, oldest first, a hundred at a time. Each delivery's URL is judged
 * again before anything is sent: DNS can change between the day an endpoint
 * was accepted and today, and yesterday's public name pointing at
 * `127.0.0.1` now is exactly the trick the guard exists for.
 */
export async function deliverDue(
  now: Date = new Date(),
  /**
   * The sender, so a test can watch without anything leaving the machine.
   * Typed as the one call rather than as `fetch` itself, which carries
   * `preconnect`.
   */
  send: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<{ delivered: number; retried: number; abandoned: number }> {
  const due = await db
    .select({ delivery: schema.crmWebhookDeliveries, hook: schema.crmWebhooks })
    .from(schema.crmWebhookDeliveries)
    .innerJoin(
      schema.crmWebhooks,
      eq(schema.crmWebhookDeliveries.webhookId, schema.crmWebhooks.id),
    )
    .where(
      and(
        eq(schema.crmWebhookDeliveries.status, "pending"),
        lte(schema.crmWebhookDeliveries.nextAttemptAt, now),
      ),
    )
    .orderBy(asc(schema.crmWebhookDeliveries.nextAttemptAt))
    .limit(SWEEP_LIMIT);

  const outcome = { delivered: 0, retried: 0, abandoned: 0 };

  for (const { delivery, hook } of due) {
    const answer = await attempt(delivery, hook, send);

    if (answer.ok) {
      outcome.delivered += 1;
      await db
        .update(schema.crmWebhookDeliveries)
        .set({
          status: "delivered",
          attempts: delivery.attempts + 1,
          lastStatus: answer.status,
          lastError: null,
          deliveredAt: now,
        })
        .where(eq(schema.crmWebhookDeliveries.id, delivery.id));
      continue;
    }

    const attempts = delivery.attempts + 1;
    const minutes = RETRY_MINUTES[attempts - 1];
    const abandoned = minutes === undefined;
    if (abandoned) outcome.abandoned += 1;
    else outcome.retried += 1;

    await db
      .update(schema.crmWebhookDeliveries)
      .set({
        status: abandoned ? "abandoned" : "pending",
        attempts,
        lastStatus: answer.status ?? null,
        lastError: answer.why,
        ...(abandoned
          ? {}
          : { nextAttemptAt: new Date(now.getTime() + minutes * 60_000) }),
      })
      .where(eq(schema.crmWebhookDeliveries.id, delivery.id));
  }

  return outcome;
}

type Delivery = typeof schema.crmWebhookDeliveries.$inferSelect;
type Hook = typeof schema.crmWebhooks.$inferSelect;

async function attempt(
  delivery: Delivery,
  hook: Hook,
  send: (url: string, init: RequestInit) => Promise<Response>,
): Promise<{ ok: boolean; status?: number; why?: string }> {
  const allowed = await mayCall(hook.url, {
    allowInsecure: hook.allowInsecure,
  });
  if (!allowed.ok) return { ok: false, why: allowed.why };

  let secret: string;
  try {
    secret = secrets.open(hook.secret);
  } catch {
    return { ok: false, why: "the endpoint's secret cannot be opened" };
  }

  const body = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000);

  const controller = new AbortController();
  const giveUp = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const answer = await send(hook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Sentrello-Webhook/1",
        "x-sentrello-event": delivery.event,
        "x-sentrello-delivery": delivery.id,
        "x-sentrello-signature": signOutbound(secret, timestamp, body),
      },
      body,
      // A redirect is the guard's question again from a place we are no
      // longer looking. An endpoint that moved can be re-pointed.
      redirect: "manual",
      signal: controller.signal,
    });
    if (!answer.ok) {
      return {
        ok: false,
        status: answer.status,
        why: `that server answered ${answer.status}`,
      };
    }
    return { ok: true, status: answer.status };
  } catch (error) {
    const why =
      (error as Error).name === "AbortError"
        ? "that server did not answer in ten seconds"
        : (error as Error).message.slice(0, 200);
    return { ok: false, why };
  } finally {
    clearTimeout(giveUp);
  }
}

export function registerWebhooks(ctx: ModuleContext) {
  // The sweep, every minute: take fresh events off the feed, then deliver
  // whatever is due, retries included.
  ctx.registerJob({
    name: "webhooks",
    cron: "* * * * *",
    handler: async () => {
      await fanOutDue();
      return deliverDue();
    },
  });

  ctx.app.get(
    "/api/crm/webhooks",
    requireSession(),
    requirePermission({ crm: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const rows = await db
        .select()
        .from(schema.crmWebhooks)
        .where(eq(schema.crmWebhooks.organizationId, orgId))
        .orderBy(desc(schema.crmWebhooks.createdAt));
      return c.json({
        // Never the secret — it was shown once, when it was issued.
        webhooks: rows.map(({ secret: _secret, ...hook }) => hook),
      });
    },
  );

  ctx.app.post(
    "/api/crm/webhooks",
    requireSession(),
    requirePermission({ crm: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      const url = String(body.url ?? "")
        .trim()
        .slice(0, 2048);
      const allowInsecure = body.allowInsecure === true;
      const allowed = await mayCall(url, { allowInsecure });
      if (!allowed.ok) return c.json({ error: allowed.why }, 400);

      const asked = body.entities;
      const entities = Array.isArray(asked)
        ? WEBHOOK_ENTITIES.filter((entity) => asked.includes(entity))
        : [...WEBHOOK_ENTITIES];
      if (entities.length === 0) {
        return c.json(
          { error: "pick at least one kind of record to be told about" },
          400,
        );
      }

      /**
       * Issued here, returned once, and sealed in the row.
       *
       * The receiver keeps it and uses it to verify our signature. A secret
       * that can be read back is a secret that leaks from a screen left
       * open; a business that loses one deletes the endpoint and adds it
       * again.
       */
      const secret = `crmwh_${crypto.randomUUID().replace(/-/g, "")}`;
      const [made] = await db
        .insert(schema.crmWebhooks)
        .values({
          organizationId: orgId,
          url,
          secret: secrets.seal(secret),
          entities,
          allowInsecure,
        })
        .returning();
      if (!made) throw new Error("the webhook was not written");

      // The destination and what it hears — never the signing secret.
      await record({
        organizationId: orgId,
        actor: c.get("session").user,
        action: "crm.webhook.created",
        detail: { url, entities },
      });

      const { secret: _sealed, ...hook } = made;
      return c.json({ webhook: hook, secret }, 201);
    },
  );

  ctx.app.delete(
    "/api/crm/webhooks/:id",
    requireSession(),
    requirePermission({ crm: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("id") ?? "";
      const [gone] = await db
        .delete(schema.crmWebhooks)
        .where(
          and(
            eq(schema.crmWebhooks.id, id),
            eq(schema.crmWebhooks.organizationId, orgId),
          ),
        )
        .returning();
      if (!gone) return c.json({ error: "not found" }, 404);
      // Its history goes with it: a log for an endpoint that no longer
      // exists is a screen full of rows nobody can act on.
      await db
        .delete(schema.crmWebhookDeliveries)
        .where(eq(schema.crmWebhookDeliveries.webhookId, id));

      await record({
        organizationId: orgId,
        actor: c.get("session").user,
        action: "crm.webhook.deleted",
        detail: { url: gone.url },
      });

      return c.json({ ok: true });
    },
  );

  /**
   * What fired, what happened, and what is being retried.
   *
   * The most recent hundred, newest first — enough to answer "did you tell
   * us about that change" without paging, which is the question this screen
   * exists for. The counts are whole-history, because "how many has it
   * abandoned" is about the endpoint, not about the slice being read.
   */
  ctx.app.get(
    "/api/crm/webhooks/:id/deliveries",
    requireSession(),
    requirePermission({ crm: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("id") ?? "";
      const [hook] = await db
        .select({ id: schema.crmWebhooks.id })
        .from(schema.crmWebhooks)
        .where(
          and(
            eq(schema.crmWebhooks.id, id),
            eq(schema.crmWebhooks.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!hook) return c.json({ error: "not found" }, 404);

      const scope = and(
        eq(schema.crmWebhookDeliveries.webhookId, id),
        eq(schema.crmWebhookDeliveries.organizationId, orgId),
      );
      const [rows, [counts]] = await Promise.all([
        db
          .select()
          .from(schema.crmWebhookDeliveries)
          .where(scope)
          .orderBy(desc(schema.crmWebhookDeliveries.createdAt))
          .limit(100),
        db
          .select({
            delivered: sql<number>`count(*) filter (where status = 'delivered')::int`,
            pending: sql<number>`count(*) filter (where status = 'pending')::int`,
            abandoned: sql<number>`count(*) filter (where status = 'abandoned')::int`,
          })
          .from(schema.crmWebhookDeliveries)
          .where(scope),
      ]);

      return c.json({ deliveries: rows, counts });
    },
  );
}
