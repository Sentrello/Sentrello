import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, desc, eq, isNotNull, schema } from "@sentrello/db";
import {
  type ModuleContext,
  type RouteContext,
  defineMiddleware,
} from "@sentrello/module-sdk";
import { parseDate } from "./recurring";

/**
 * Selling the same thing every month, and looking after the people who buy it.
 *
 * A subscription is a customer, a plan, and the price they agreed to. It bills
 * through the recurring machinery that already exists — one scheduler, because
 * two things that each believe they own a renewal is how somebody is charged
 * twice — and adds the part a subscription business actually spends its time
 * on: trials, pauses, upgrades, and cancellations that take effect at the end
 * of the period the customer has already paid for.
 *
 * A plan is a catalogue item with a billing interval on it. Not a table of its
 * own: a plan is priced and taxed exactly like anything else this business
 * sells, and a second catalogue would be a second answer to what a thing costs.
 */

export const BILLING_INTERVALS = [
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
] as const;

export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export const isBillingInterval = (value: unknown): value is BillingInterval =>
  typeof value === "string" &&
  (BILLING_INTERVALS as readonly string[]).includes(value);

/** trialing → active → paused → cancelled. Nothing skips to the front. */
export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "paused",
  "cancelled",
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/**
 * When the next invoice falls, given a start and a trial.
 *
 * A trial bills on the day it ends, not a period later: somebody who takes a
 * fourteen-day trial on the 1st expects to pay on the 15th, and billing them
 * on the 1st of next month would be two free weeks nobody offered.
 */
export function firstRun(startsOn: Date, trialEndsAt: Date | null): Date {
  return trialEndsAt && trialEndsAt > startsOn ? trialEndsAt : startsOn;
}

/**
 * What a cancellation means, in dates.
 *
 * "At the end of the period" is the default because the customer has paid for
 * it. Immediately is a business deciding to stop billing now — it still does
 * not refund anything, and saying so is the honest thing for the screen to do.
 */
export function cancellation(
  now: Date,
  nextRunAt: Date,
  immediately: boolean,
): {
  status: SubscriptionStatus;
  cancelAt: Date;
  cancelledAt: Date;
  active: boolean;
} {
  return immediately
    ? { status: "cancelled", cancelAt: now, cancelledAt: now, active: false }
    : { status: "active", cancelAt: nextRunAt, cancelledAt: now, active: true };
}

interface SubscriptionInput {
  contactId?: unknown;
  planItemId?: unknown;
  quantity?: unknown;
  unitPriceCents?: unknown;
  interval?: unknown;
  intervalCount?: unknown;
  startsOn?: unknown;
  trialEndsAt?: unknown;
  name?: unknown;
  autoSend?: unknown;
  externalRef?: unknown;
  currency?: unknown;
}

/** A plan as the catalogue holds it, or nothing if this is not one. */
async function planFor(orgId: string, planItemId: string) {
  const [plan] = await db
    .select()
    .from(schema.billableItems)
    .where(
      and(
        eq(schema.billableItems.id, planItemId),
        eq(schema.billableItems.organizationId, orgId),
      ),
    )
    .limit(1);
  return plan ?? null;
}

/** The rate a named tax charges, copied onto the subscription at signup. */
async function rateFor(
  orgId: string,
  taxDefinitionId: string | null,
): Promise<number> {
  if (!taxDefinitionId) return 0;
  const [tax] = await db
    .select({ rateBp: schema.taxDefinitions.rateBp })
    .from(schema.taxDefinitions)
    .where(
      and(
        eq(schema.taxDefinitions.id, taxDefinitionId),
        eq(schema.taxDefinitions.organizationId, orgId),
      ),
    )
    .limit(1);
  return tax?.rateBp ?? 0;
}

export function registerSubscriptions(ctx: ModuleContext) {
  /**
   * Subscriptions are the Pro half of Invoicing.
   *
   * Free bills for work done: an invoice, a quote, a service on the price
   * list. Selling the same thing every month is a different business with
   * different questions — who is on what, whose trial ends this week, who has
   * given notice — and that is what Pro is for.
   *
   * 404 rather than 403, matching the Pro half of the dashboard: on a Free
   * instance these endpoints do not exist. Checked per request rather than at
   * boot, because a licence can arrive or lapse while the process is running.
   */
  const proOnly = defineMiddleware(async (c, next) => {
    if (!ctx.entitled({ tier: "pro" })) return c.notFound();
    await next();
  });

  // -------------------------------------------------------------------------
  // Plans — the catalogue items that carry a billing interval
  // -------------------------------------------------------------------------

  ctx.app.get(
    "/api/invoicing/plans",
    requireSession(),
    requirePermission({ invoicing: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const plans = await db
        .select()
        .from(schema.billableItems)
        .where(
          and(
            eq(schema.billableItems.organizationId, orgId),
            isNotNull(schema.billableItems.billingInterval),
          ),
        )
        .orderBy(schema.billableItems.name);
      return c.json({ plans });
    },
  );

  /**
   * Turning an item into a plan, or making one outright.
   *
   * The same endpoint does both because they are the same act: a plan is a
   * thing you sell with a period attached, and a business that already sells
   * "Monthly support" as a line on an invoice should not have to type it in
   * again to sell it on a repeat.
   */
  ctx.app.post(
    "/api/invoicing/plans",
    requireSession(),
    requirePermission({ invoicing: ["update"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      if (!isBillingInterval(body.billingInterval)) {
        return c.json(
          { error: `interval must be one of ${BILLING_INTERVALS.join(", ")}` },
          400,
        );
      }
      const count = Number(body.billingIntervalCount ?? 1);
      if (!Number.isInteger(count) || count < 1) {
        return c.json({ error: "every how many of those?" }, 400);
      }

      if (typeof body.itemId === "string") {
        const [row] = await db
          .update(schema.billableItems)
          .set({
            billingInterval: body.billingInterval,
            billingIntervalCount: count,
          })
          .where(
            and(
              eq(schema.billableItems.id, body.itemId),
              eq(schema.billableItems.organizationId, orgId),
            ),
          )
          .returning();
        if (!row) return c.json({ error: "not found" }, 404);
        return c.json({ plan: row });
      }

      const name = String(body.name ?? "").trim();
      if (!name) return c.json({ error: "a name" }, 400);
      const unitPriceCents = body.unitPriceCents;
      if (!Number.isInteger(unitPriceCents) || (unitPriceCents as number) < 0) {
        return c.json(
          { error: "the price must be a whole number of cents" },
          400,
        );
      }

      const [row] = await db
        .insert(schema.billableItems)
        .values({
          organizationId: orgId,
          name,
          description: (body.description as string) ?? null,
          unitPriceCents: unitPriceCents as number,
          unit: "subscription",
          kind: "service",
          taxDefinitionId: (body.taxDefinitionId as string) ?? null,
          billingInterval: body.billingInterval,
          billingIntervalCount: count,
        })
        .returning();
      return c.json({ plan: row }, 201);
    },
  );

  /** Withdrawing a plan. Subscribers on it keep their price and their dates. */
  ctx.app.delete(
    "/api/invoicing/plans/:id",
    requireSession(),
    requirePermission({ invoicing: ["update"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const [row] = await db
        .update(schema.billableItems)
        .set({ active: false })
        .where(
          and(
            eq(schema.billableItems.id, c.req.param("id") ?? ""),
            eq(schema.billableItems.organizationId, orgId),
          ),
        )
        .returning();
      if (!row) return c.json({ error: "not found" }, 404);
      return c.json({ withdrawn: row.id });
    },
  );

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  ctx.app.get(
    "/api/invoicing/subscriptions",
    requireSession(),
    requirePermission({ invoicing: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const rows = await db
        .select({
          id: schema.recurringProfiles.id,
          name: schema.recurringProfiles.name,
          contactId: schema.recurringProfiles.contactId,
          customerName: schema.contacts.name,
          customerEmail: schema.contacts.email,
          planItemId: schema.recurringProfiles.planItemId,
          planName: schema.billableItems.name,
          quantity: schema.recurringProfiles.quantity,
          unitPriceCents: schema.recurringProfiles.unitPriceCents,
          currency: schema.recurringProfiles.currency,
          interval: schema.recurringProfiles.interval,
          intervalCount: schema.recurringProfiles.intervalCount,
          status: schema.recurringProfiles.status,
          active: schema.recurringProfiles.active,
          startedAt: schema.recurringProfiles.startedAt,
          trialEndsAt: schema.recurringProfiles.trialEndsAt,
          nextRunAt: schema.recurringProfiles.nextRunAt,
          cancelAt: schema.recurringProfiles.cancelAt,
          cancelledAt: schema.recurringProfiles.cancelledAt,
          generatedCount: schema.recurringProfiles.generatedCount,
          lastGeneratedAt: schema.recurringProfiles.lastGeneratedAt,
          autoSend: schema.recurringProfiles.autoSend,
          externalRef: schema.recurringProfiles.externalRef,
        })
        .from(schema.recurringProfiles)
        .leftJoin(
          schema.contacts,
          eq(schema.recurringProfiles.contactId, schema.contacts.id),
        )
        .leftJoin(
          schema.billableItems,
          eq(schema.recurringProfiles.planItemId, schema.billableItems.id),
        )
        .where(
          and(
            eq(schema.recurringProfiles.organizationId, orgId),
            eq(schema.recurringProfiles.kind, "subscription"),
          ),
        )
        .orderBy(desc(schema.recurringProfiles.active));

      /**
       * What the business is owed every month, whatever the plans are billed
       * at. A yearly plan is a twelfth of itself here — the question "what do
       * we make a month" has one answer, and a mix of intervals must not make
       * it unanswerable.
       */
      const perMonth = rows
        .filter((row) => row.active && row.status !== "cancelled")
        .reduce((sum, row) => {
          const line = (row.unitPriceCents ?? 0) * (row.quantity ?? 1);
          const every = row.intervalCount ?? 1;
          const months =
            row.interval === "yearly"
              ? 12 * every
              : row.interval === "quarterly"
                ? 3 * every
                : row.interval === "weekly"
                  ? every / 4.345
                  : every;
          return sum + Math.round(line / months);
        }, 0);

      return c.json({ subscriptions: rows, monthlyRecurringCents: perMonth });
    },
  );

  ctx.app.post(
    "/api/invoicing/subscriptions",
    requireSession(),
    requirePermission({ invoicing: ["create"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as SubscriptionInput;

      const contactId =
        typeof body.contactId === "string" ? body.contactId : null;
      if (!contactId) return c.json({ error: "pick a customer" }, 400);
      const [customer] = await db
        .select({ id: schema.contacts.id })
        .from(schema.contacts)
        .where(
          and(
            eq(schema.contacts.id, contactId),
            eq(schema.contacts.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!customer) return c.json({ error: "unknown customer" }, 400);

      const planItemId =
        typeof body.planItemId === "string" ? body.planItemId : null;
      const plan = planItemId ? await planFor(orgId, planItemId) : null;
      if (planItemId && !plan) return c.json({ error: "unknown plan" }, 400);

      /**
       * The plan sets the terms; anything sent explicitly overrides it.
       *
       * That is how a discount is given without inventing a second plan for
       * one customer, and why the agreed price is stored here rather than read
       * from the catalogue each period.
       */
      const interval = isBillingInterval(body.interval)
        ? body.interval
        : (plan?.billingInterval ?? null);
      if (!isBillingInterval(interval)) {
        return c.json({ error: "how often should it bill?" }, 400);
      }
      const intervalCount = Number(
        body.intervalCount ?? plan?.billingIntervalCount ?? 1,
      );
      if (!Number.isInteger(intervalCount) || intervalCount < 1) {
        return c.json({ error: "every how many of those?" }, 400);
      }

      const unitPriceCents =
        body.unitPriceCents === undefined
          ? (plan?.unitPriceCents ?? null)
          : Number(body.unitPriceCents);
      if (
        unitPriceCents === null ||
        !Number.isInteger(unitPriceCents) ||
        unitPriceCents < 0
      ) {
        return c.json(
          { error: "the price must be a whole number of cents" },
          400,
        );
      }
      const quantity = Number(body.quantity ?? 1);
      if (!Number.isInteger(quantity) || quantity < 1) {
        return c.json({ error: "how many?" }, 400);
      }

      const startsOn = parseDate(body.startsOn) ?? new Date();
      const trialEndsAt = parseDate(body.trialEndsAt);
      if (trialEndsAt && trialEndsAt < startsOn) {
        return c.json({ error: "a trial cannot end before it starts" }, 400);
      }

      const [subscription] = await db
        .insert(schema.recurringProfiles)
        .values({
          organizationId: orgId,
          kind: "subscription",
          contactId,
          name: (body.name as string) ?? plan?.name ?? null,
          planItemId,
          quantity,
          unitPriceCents,
          taxRateBp: await rateFor(orgId, plan?.taxDefinitionId ?? null),
          taxDefinitionId: plan?.taxDefinitionId ?? null,
          currency: (body.currency as string) ?? "USD",
          interval,
          intervalCount,
          nextRunAt: firstRun(startsOn, trialEndsAt),
          status: trialEndsAt ? "trialing" : "active",
          startedAt: startsOn,
          trialEndsAt,
          autoSend: body.autoSend === true,
          externalRef: (body.externalRef as string) ?? null,
        })
        .returning();

      return c.json({ subscription }, 201);
    },
  );

  /**
   * Everything that happens to a subscription after it starts.
   *
   * One endpoint rather than five, because they are all the same edit to the
   * same row and a screen that has to remember which verb does what is a
   * screen that gets it wrong.
   */
  ctx.app.patch(
    "/api/invoicing/subscriptions/:id",
    requireSession(),
    requirePermission({ invoicing: ["update"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("id") ?? "";
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      const [existing] = await db
        .select()
        .from(schema.recurringProfiles)
        .where(
          and(
            eq(schema.recurringProfiles.id, id),
            eq(schema.recurringProfiles.organizationId, orgId),
            eq(schema.recurringProfiles.kind, "subscription"),
          ),
        )
        .limit(1);
      if (!existing) return c.json({ error: "not found" }, 404);

      const now = new Date();
      const patch: Record<string, unknown> = {};

      if (body.action === "pause") {
        if (existing.status === "cancelled") {
          return c.json({ error: "that subscription has ended" }, 409);
        }
        patch.status = "paused";
      }

      if (body.action === "resume") {
        if (existing.status !== "paused") {
          return c.json({ error: "that subscription is not paused" }, 409);
        }
        patch.status =
          existing.trialEndsAt && existing.trialEndsAt > now
            ? "trialing"
            : "active";
        /**
         * Picked up from today, not from where it stopped.
         *
         * A subscription paused for three months would otherwise raise three
         * invoices the moment it resumed, for periods in which the customer
         * had nothing.
         */
        if (existing.nextRunAt < now) patch.nextRunAt = now;
      }

      if (body.action === "cancel") {
        const decided = cancellation(
          now,
          existing.nextRunAt,
          body.immediately === true,
        );
        Object.assign(patch, decided);
      }

      if (body.action === "uncancel") {
        if (!existing.cancelAt) {
          return c.json({ error: "that subscription is not cancelled" }, 409);
        }
        patch.cancelAt = null;
        patch.cancelledAt = null;
        patch.status = "active";
        patch.active = true;
      }

      /**
       * Changing the plan is a change from the next invoice, never a bill
       * today: the customer has paid for the period they are in, and a plan
       * change that charged the difference immediately is the kind of surprise
       * that ends a subscription.
       */
      if (typeof body.planItemId === "string") {
        const plan = await planFor(orgId, body.planItemId);
        if (!plan) return c.json({ error: "unknown plan" }, 400);
        patch.planItemId = plan.id;
        patch.name = plan.name;
        if (body.unitPriceCents === undefined) {
          patch.unitPriceCents = plan.unitPriceCents;
        }
        patch.taxDefinitionId = plan.taxDefinitionId;
        patch.taxRateBp = await rateFor(orgId, plan.taxDefinitionId);
        if (isBillingInterval(plan.billingInterval)) {
          patch.interval = plan.billingInterval;
          patch.intervalCount = plan.billingIntervalCount;
        }
      }

      if (body.unitPriceCents !== undefined) {
        const price = Number(body.unitPriceCents);
        if (!Number.isInteger(price) || price < 0) {
          return c.json(
            { error: "the price must be a whole number of cents" },
            400,
          );
        }
        patch.unitPriceCents = price;
      }

      if (body.quantity !== undefined) {
        const quantity = Number(body.quantity);
        if (!Number.isInteger(quantity) || quantity < 1) {
          return c.json({ error: "how many?" }, 400);
        }
        patch.quantity = quantity;
      }

      if (body.nextRunAt !== undefined) {
        const when = parseDate(body.nextRunAt);
        if (!when) return c.json({ error: "unreadable date" }, 400);
        patch.nextRunAt = when;
      }

      if (typeof body.autoSend === "boolean") patch.autoSend = body.autoSend;
      if (body.externalRef !== undefined) {
        patch.externalRef = body.externalRef || null;
      }

      if (Object.keys(patch).length === 0) {
        return c.json({ error: "nothing to change" }, 400);
      }

      const [row] = await db
        .update(schema.recurringProfiles)
        .set(patch)
        .where(
          and(
            eq(schema.recurringProfiles.id, id),
            eq(schema.recurringProfiles.organizationId, orgId),
          ),
        )
        .returning();
      return c.json({ subscription: row });
    },
  );

  /** Every invoice this subscription has raised, newest first. */
  ctx.app.get(
    "/api/invoicing/subscriptions/:id/invoices",
    requireSession(),
    requirePermission({ invoicing: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("id") ?? "";
      const [subscription] = await db
        .select({ contactId: schema.recurringProfiles.contactId })
        .from(schema.recurringProfiles)
        .where(
          and(
            eq(schema.recurringProfiles.id, id),
            eq(schema.recurringProfiles.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!subscription) return c.json({ error: "not found" }, 404);

      const invoices = await db
        .select({
          id: schema.invoices.id,
          number: schema.invoices.number,
          status: schema.invoices.status,
          issueDate: schema.invoices.issueDate,
          totalCents: schema.invoices.totalCents,
          currency: schema.invoices.currency,
        })
        .from(schema.invoices)
        .where(
          and(
            eq(schema.invoices.organizationId, orgId),
            eq(schema.invoices.contactId, subscription.contactId),
          ),
        )
        .orderBy(desc(schema.invoices.issueDate))
        .limit(50);
      return c.json({ invoices });
    },
  );
}
