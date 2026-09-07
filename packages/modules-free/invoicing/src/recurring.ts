import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, desc, eq, schema } from "@sentrello/db";
import {
  type ModuleContext,
  type RouteContext,
  defineMiddleware,
} from "@sentrello/module-sdk";

/**
 * Invoices that repeat, and the screens that set them up.
 *
 * The job that raises them has existed since the first packet and there was no
 * way to create a profile for it — the table was only reachable by writing SQL
 * by hand. A scheduler nobody can configure is a scheduler nobody uses.
 *
 * A profile is a customer, a schedule and a template invoice. The template is
 * a real draft invoice rather than a form of its own: it is priced, taxed and
 * corrected with the same screen as any other invoice, and what the customer
 * will receive is a document somebody can actually look at first.
 */

const INTERVALS = [
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
] as const;

type Interval = (typeof INTERVALS)[number];

const isInterval = (value: unknown): value is Interval =>
  typeof value === "string" && (INTERVALS as readonly string[]).includes(value);

/** A date the browser sent, or nothing. Never an Invalid Date. */
export function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * What a profile is allowed to say.
 *
 * Rejected rather than corrected: a schedule silently changed from what
 * somebody typed bills their customer on a day they did not choose. The one
 * exception is the count, which is clamped — "every 0 months" is not a
 * schedule, it is a profile that would re-issue on every run for ever.
 */
export function validateProfile(body: Record<string, unknown>): {
  error?: string;
  interval?: Interval;
  intervalCount?: number;
  nextRunAt?: Date;
  endsOn?: Date | null;
} {
  if (!isInterval(body.interval)) {
    return { error: "pick how often it repeats" };
  }
  const nextRunAt = parseDate(body.nextRunAt);
  if (!nextRunAt) return { error: "pick when it first runs" };

  const endsOn = parseDate(body.endsOn);
  if (endsOn && endsOn < nextRunAt) {
    return { error: "it cannot end before it starts" };
  }

  const raw = body.intervalCount;
  const intervalCount =
    typeof raw === "number" && Number.isFinite(raw)
      ? Math.max(1, Math.trunc(raw))
      : 1;

  return { interval: body.interval, intervalCount, nextRunAt, endsOn };
}

export function registerRecurring(ctx: ModuleContext) {
  /**
   * 404 rather than 403, matching Subscriptions and Statements: on a Free
   * instance these endpoints do not exist. After `requirePermission`, so
   * somebody who may not read invoicing at all is refused for that reason
   * first on both tiers — no caller learns an instance's licence from the
   * shape of its refusal. Checked per request, because a licence can arrive or
   * lapse while the process is running.
   *
   * The profiles themselves are never touched. A licence that lapses stops the
   * screens and stops the job; what somebody already set up is still in the
   * database, still readable, and starts working again the day the licence
   * comes back.
   */
  const proOnly = defineMiddleware(async (c, next) => {
    if (!ctx.entitled({ tier: "pro" })) return c.notFound();
    await next();
  });

  ctx.app.get(
    "/api/invoicing/recurring",
    requireSession(),
    requirePermission({ invoicing: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const profiles = await db
        .select({
          id: schema.recurringProfiles.id,
          name: schema.recurringProfiles.name,
          contactId: schema.recurringProfiles.contactId,
          interval: schema.recurringProfiles.interval,
          intervalCount: schema.recurringProfiles.intervalCount,
          nextRunAt: schema.recurringProfiles.nextRunAt,
          endsOn: schema.recurringProfiles.endsOn,
          autoSend: schema.recurringProfiles.autoSend,
          active: schema.recurringProfiles.active,
          generatedCount: schema.recurringProfiles.generatedCount,
          lastGeneratedAt: schema.recurringProfiles.lastGeneratedAt,
          templateInvoiceId: schema.recurringProfiles.templateInvoiceId,
          templateNumber: schema.invoices.number,
          templateTotalCents: schema.invoices.totalCents,
          currency: schema.invoices.currency,
        })
        .from(schema.recurringProfiles)
        .leftJoin(
          schema.invoices,
          eq(schema.recurringProfiles.templateInvoiceId, schema.invoices.id),
        )
        .where(eq(schema.recurringProfiles.organizationId, orgId))
        .orderBy(desc(schema.recurringProfiles.active));

      return c.json({ profiles });
    },
  );

  ctx.app.post(
    "/api/invoicing/recurring",
    requireSession(),
    requirePermission({ invoicing: ["create"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      const checked = validateProfile(body);
      if (checked.error) return c.json({ error: checked.error }, 400);

      /**
       * The template has to be this organization's own invoice.
       *
       * Without the check, a profile could be pointed at somebody else's
       * invoice and would copy their prices, their notes and their lines into
       * a document billed under this business's number.
       */
      const templateInvoiceId =
        typeof body.templateInvoiceId === "string"
          ? body.templateInvoiceId
          : null;
      let contactId =
        typeof body.contactId === "string" ? body.contactId : null;

      if (templateInvoiceId) {
        const [template] = await db
          .select()
          .from(schema.invoices)
          .where(
            and(
              eq(schema.invoices.id, templateInvoiceId),
              eq(schema.invoices.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!template) return c.json({ error: "not found" }, 404);
        contactId = contactId ?? template.contactId;
      }

      if (!contactId) return c.json({ error: "pick a customer" }, 400);

      const [profile] = await db
        .insert(schema.recurringProfiles)
        .values({
          organizationId: orgId,
          contactId,
          name: typeof body.name === "string" ? body.name : null,
          interval: checked.interval as string,
          intervalCount: checked.intervalCount as number,
          nextRunAt: checked.nextRunAt as Date,
          endsOn: checked.endsOn,
          templateInvoiceId,
          autoSend: body.autoSend === true,
        })
        .returning();

      return c.json({ profile }, 201);
    },
  );

  ctx.app.patch(
    "/api/invoicing/recurring/:id",
    requireSession(),
    requirePermission({ invoicing: ["update"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      const patch: Partial<typeof schema.recurringProfiles.$inferInsert> = {};
      if (isInterval(body.interval)) patch.interval = body.interval;
      if (typeof body.intervalCount === "number") {
        patch.intervalCount = Math.max(1, Math.trunc(body.intervalCount));
      }
      const nextRunAt = parseDate(body.nextRunAt);
      if (nextRunAt) patch.nextRunAt = nextRunAt;
      if ("endsOn" in body) patch.endsOn = parseDate(body.endsOn);
      if (typeof body.autoSend === "boolean") patch.autoSend = body.autoSend;
      if (typeof body.active === "boolean") patch.active = body.active;
      if (typeof body.name === "string") patch.name = body.name;

      if (Object.keys(patch).length === 0) {
        return c.json({ error: "nothing to change" }, 400);
      }
      if (patch.endsOn && patch.nextRunAt && patch.endsOn < patch.nextRunAt) {
        return c.json({ error: "it cannot end before it starts" }, 400);
      }

      const [updated] = await db
        .update(schema.recurringProfiles)
        .set(patch)
        .where(
          and(
            eq(schema.recurringProfiles.id, c.req.param("id") ?? ""),
            eq(schema.recurringProfiles.organizationId, orgId),
          ),
        )
        .returning();
      if (!updated) return c.json({ error: "not found" }, 404);
      return c.json({ profile: updated });
    },
  );

  ctx.app.delete(
    "/api/invoicing/recurring/:id",
    requireSession(),
    requirePermission({ invoicing: ["delete"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const [gone] = await db
        .delete(schema.recurringProfiles)
        .where(
          and(
            eq(schema.recurringProfiles.id, c.req.param("id") ?? ""),
            eq(schema.recurringProfiles.organizationId, orgId),
          ),
        )
        .returning({ id: schema.recurringProfiles.id });
      if (!gone) return c.json({ error: "not found" }, 404);
      // The invoices it already raised stay: they were sent and may be owed.
      return c.json({ deleted: true });
    },
  );
}
