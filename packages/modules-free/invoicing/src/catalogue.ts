import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, asc, db, eq, schema } from "@sentrello/db";
import type { ModuleContext } from "@sentrello/module-sdk";

/**
 * The two lists a business fills in once and then picks from.
 *
 * **Tax definitions** — the rates it actually charges, named. A rate typed
 * into a line is a rate somebody will mistype, and a tax summary built from
 * mistyped rates is not a tax summary. Naming them is also what makes the
 * EN 16931 category code somewhere to live, which is what an e-invoice will
 * need to state later.
 *
 * **Billable items** — what it sells, so a line is picked rather than
 * retyped. Deliberately not the Shop's products: Shop is a paid module for
 * selling to the public, with variants, stock and delivery. This is a list of
 * things to put on an invoice, and most businesses that need one will never
 * buy the other.
 */

/**
 * EN 16931's tax categories.
 *
 * Stored now even though nothing renders an e-invoice yet, because the
 * alternative is a migration over live documents later — and because the
 * distinction between "zero-rated" and "exempt" is a real one that a business
 * gets asked about at the end of the year.
 */
export const TAX_CATEGORIES = [
  { code: "S", label: "Standard rate" },
  { code: "Z", label: "Zero-rated" },
  { code: "E", label: "Exempt" },
  { code: "AE", label: "Reverse charge" },
  { code: "G", label: "Export, outside the tax area" },
  { code: "O", label: "Outside the scope of tax" },
] as const;

const CATEGORY_CODES = new Set(TAX_CATEGORIES.map((c) => c.code));

/** Enough for any business's list, and a refusal for a runaway loop. */
const MAX_RATE_BP = 100_00;

export class CatalogueError extends Error {}

/** A tax rate as the browser sent it, or a refusal saying which part is wrong. */
export function parseTaxDefinition(body: Record<string, unknown>): {
  name: string;
  rateBp: number;
  categoryCode: string;
  description: string | null;
} {
  const name = String(body.name ?? "").trim();
  if (!name) throw new CatalogueError("a name is required");
  if (name.length > 60) throw new CatalogueError("that name is too long");

  const rateBp = body.rateBp;
  if (!Number.isInteger(rateBp)) {
    // Basis points, not a percentage: 8.75% is 875, and accepting 8.75 here
    // would quietly charge everybody 0.0875%.
    throw new CatalogueError(
      "the rate must be whole basis points (875 = 8.75%)",
    );
  }
  if ((rateBp as number) < 0 || (rateBp as number) > MAX_RATE_BP) {
    throw new CatalogueError("that rate is not a tax rate");
  }

  const categoryCode = String(body.categoryCode ?? "S").trim();
  if (!CATEGORY_CODES.has(categoryCode as "S")) {
    throw new CatalogueError("that is not a tax category");
  }

  /**
   * A category that means "no tax" cannot carry a rate.
   *
   * Zero-rated at 20% is not a thing, and a document that says so is one a
   * tax authority will ask about. Refusing here beats discovering it on a
   * return.
   */
  const zeroOnly =
    categoryCode === "Z" ||
    categoryCode === "E" ||
    categoryCode === "AE" ||
    categoryCode === "G" ||
    categoryCode === "O";
  if (zeroOnly && (rateBp as number) !== 0) {
    throw new CatalogueError(
      `a ${categoryCode} rate is charged at nothing; set the rate to 0`,
    );
  }

  return {
    name,
    rateBp: rateBp as number,
    categoryCode,
    description: String(body.description ?? "").trim() || null,
  };
}

/**
 * Exactly one default, or none.
 *
 * Two defaults means the line editor picks whichever the database happened to
 * return first, which is a different tax rate on different days.
 */
async function clearOtherDefaults(orgId: string, keepId: string) {
  await db
    .update(schema.taxDefinitions)
    .set({ isDefault: false })
    .where(
      and(
        eq(schema.taxDefinitions.organizationId, orgId),
        eq(schema.taxDefinitions.isDefault, true),
      ),
    );
  await db
    .update(schema.taxDefinitions)
    .set({ isDefault: true })
    .where(eq(schema.taxDefinitions.id, keepId));
}

/**
 * The terms and the units a business starts with.
 *
 * The same list the column defaults to, kept here as well because the GET
 * answers before a row exists — an instance that has never opened the settings
 * screen still has to offer something on the invoice form.
 */
export const DEFAULT_PAYMENT_TERMS = [
  { label: "Due on receipt", days: 0 },
  { label: "Net 7", days: 7 },
  { label: "Net 14", days: 14 },
  { label: "Net 30", days: 30 },
  { label: "Net 60", days: 60 },
];

export const DEFAULT_UNITS = [
  "piece",
  "hour",
  "day",
  "week",
  "month",
  "kg",
  "m",
  "lump sum",
];

/**
 * A term is a name and a number of days, and nothing else.
 *
 * Anything unreadable falls back to the list everybody starts with rather than
 * being saved as-is: this drives a select on the invoice form, and a malformed
 * entry there is a business unable to pick any terms at all.
 */
function cleanTerms(given: unknown): { label: string; days: number }[] {
  if (!Array.isArray(given)) return DEFAULT_PAYMENT_TERMS;
  const out: { label: string; days: number }[] = [];
  for (const entry of given.slice(0, 20)) {
    if (!entry || typeof entry !== "object") continue;
    const label = String((entry as { label?: unknown }).label ?? "").trim();
    const days = Number((entry as { days?: unknown }).days);
    if (!label || !Number.isInteger(days) || days < 0 || days > 365) continue;
    out.push({ label: label.slice(0, 60), days });
  }
  return out;
}

/** Units, trimmed and deduplicated — "hour" and "Hour" are one unit. */
function cleanUnits(given: unknown): string[] {
  if (!Array.isArray(given)) return DEFAULT_UNITS;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of given.slice(0, 40)) {
    const unit = String(entry ?? "")
      .trim()
      .slice(0, 30);
    if (!unit || seen.has(unit.toLowerCase())) continue;
    seen.add(unit.toLowerCase());
    out.push(unit);
  }
  return out;
}

export function registerCatalogue(ctx: ModuleContext) {
  // ---------------------------------------------------------------------
  // Tax definitions
  // ---------------------------------------------------------------------

  ctx.app.get(
    "/api/invoicing/taxes",
    requireSession(),
    // Read, not update: the line editor needs the rates to offer them, and
    // anybody who can raise an invoice can see what it may be taxed at.
    requirePermission({ invoicing: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const rows = await db
        .select()
        .from(schema.taxDefinitions)
        .where(eq(schema.taxDefinitions.organizationId, orgId))
        .orderBy(asc(schema.taxDefinitions.name));
      return c.json({ taxes: rows, categories: TAX_CATEGORIES });
    },
  );

  ctx.app.post(
    "/api/invoicing/taxes",
    requireSession(),
    requirePermission({ invoicing: ["update"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      let parsed: ReturnType<typeof parseTaxDefinition>;
      try {
        parsed = parseTaxDefinition(body);
      } catch (err) {
        if (err instanceof CatalogueError) {
          return c.json({ error: err.message }, 400);
        }
        throw err;
      }

      const [made] = await db
        .insert(schema.taxDefinitions)
        .values({ organizationId: orgId, ...parsed })
        .returning();
      if (!made) throw new Error("tax insert returned no row");

      if (body.isDefault === true) await clearOtherDefaults(orgId, made.id);
      return c.json({ tax: made }, 201);
    },
  );

  ctx.app.patch(
    "/api/invoicing/taxes/:id",
    requireSession(),
    requirePermission({ invoicing: ["update"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("id");
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      const patch: Record<string, unknown> = {};
      if (body.name !== undefined || body.rateBp !== undefined) {
        // Re-read the row so a partial edit is validated as a whole: changing
        // only the category on a 20% rate has to be refused the same way.
        const [current] = await db
          .select()
          .from(schema.taxDefinitions)
          .where(
            and(
              eq(schema.taxDefinitions.id, id),
              eq(schema.taxDefinitions.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!current) return c.json({ error: "not found" }, 404);

        try {
          Object.assign(
            patch,
            parseTaxDefinition({
              name: body.name ?? current.name,
              rateBp: body.rateBp ?? current.rateBp,
              categoryCode: body.categoryCode ?? current.categoryCode,
              description: body.description ?? current.description,
            }),
          );
        } catch (err) {
          if (err instanceof CatalogueError) {
            return c.json({ error: err.message }, 400);
          }
          throw err;
        }
      }
      if (typeof body.active === "boolean") patch.active = body.active;

      const [row] = await db
        .update(schema.taxDefinitions)
        .set(patch)
        .where(
          and(
            eq(schema.taxDefinitions.id, id),
            eq(schema.taxDefinitions.organizationId, orgId),
          ),
        )
        .returning();
      if (!row) return c.json({ error: "not found" }, 404);

      if (body.isDefault === true) await clearOtherDefaults(orgId, row.id);
      return c.json({ tax: row });
    },
  );

  /**
   * A rate is retired, never deleted.
   *
   * Documents copy the rate they were issued at, so removing the row would not
   * change any of them — but it would break the tax summary, which groups by
   * the definition to name each band. Marking it inactive takes it out of the
   * line editor and leaves the history readable.
   */
  ctx.app.delete(
    "/api/invoicing/taxes/:id",
    requireSession(),
    requirePermission({ invoicing: ["update"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const [row] = await db
        .update(schema.taxDefinitions)
        .set({ active: false, isDefault: false })
        .where(
          and(
            eq(schema.taxDefinitions.id, c.req.param("id")),
            eq(schema.taxDefinitions.organizationId, orgId),
          ),
        )
        .returning();
      if (!row) return c.json({ error: "not found" }, 404);
      return c.json({ retired: row.id });
    },
  );

  // ---------------------------------------------------------------------
  // Billable items
  // ---------------------------------------------------------------------

  ctx.app.get(
    "/api/invoicing/items",
    requireSession(),
    requirePermission({ invoicing: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const rows = await db
        .select()
        .from(schema.billableItems)
        .where(eq(schema.billableItems.organizationId, orgId))
        .orderBy(asc(schema.billableItems.name));
      return c.json({ items: rows });
    },
  );

  ctx.app.post(
    "/api/invoicing/items",
    requireSession(),
    requirePermission({ invoicing: ["update"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      const name = String(body.name ?? "").trim();
      if (!name) return c.json({ error: "a name is required" }, 400);

      const unitPriceCents = body.unitPriceCents ?? 0;
      if (!Number.isInteger(unitPriceCents) || (unitPriceCents as number) < 0) {
        return c.json(
          { error: "unitPriceCents must be a whole number of cents" },
          400,
        );
      }

      const [made] = await db
        .insert(schema.billableItems)
        .values({
          organizationId: orgId,
          name,
          description: String(body.description ?? "").trim() || null,
          sku: String(body.sku ?? "").trim() || null,
          unitPriceCents: unitPriceCents as number,
          unit: String(body.unit ?? "piece").trim() || "piece",
          kind: body.kind === "product" ? "product" : "service",
          taxDefinitionId:
            typeof body.taxDefinitionId === "string" && body.taxDefinitionId
              ? body.taxDefinitionId
              : null,
        })
        .returning();
      return c.json({ item: made }, 201);
    },
  );

  ctx.app.patch(
    "/api/invoicing/items/:id",
    requireSession(),
    requirePermission({ invoicing: ["update"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      const patch: Record<string, unknown> = {};
      if (typeof body.name === "string" && body.name.trim()) {
        patch.name = body.name.trim();
      }
      if (body.description !== undefined) {
        patch.description = String(body.description ?? "").trim() || null;
      }
      if (body.sku !== undefined) {
        patch.sku = String(body.sku ?? "").trim() || null;
      }
      if (body.unitPriceCents !== undefined) {
        if (
          !Number.isInteger(body.unitPriceCents) ||
          (body.unitPriceCents as number) < 0
        ) {
          return c.json(
            { error: "unitPriceCents must be a whole number of cents" },
            400,
          );
        }
        patch.unitPriceCents = body.unitPriceCents;
      }
      if (typeof body.unit === "string" && body.unit.trim()) {
        patch.unit = body.unit.trim();
      }
      if (body.kind === "product" || body.kind === "service") {
        patch.kind = body.kind;
      }
      if (body.taxDefinitionId !== undefined) {
        patch.taxDefinitionId = body.taxDefinitionId || null;
      }
      if (typeof body.active === "boolean") patch.active = body.active;

      const [row] = await db
        .update(schema.billableItems)
        .set(patch)
        .where(
          and(
            eq(schema.billableItems.id, c.req.param("id")),
            eq(schema.billableItems.organizationId, orgId),
          ),
        )
        .returning();
      if (!row) return c.json({ error: "not found" }, 404);
      return c.json({ item: row });
    },
  );

  /** Retired rather than deleted, for the same reason a tax rate is. */
  ctx.app.delete(
    "/api/invoicing/items/:id",
    requireSession(),
    requirePermission({ invoicing: ["update"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const [row] = await db
        .update(schema.billableItems)
        .set({ active: false })
        .where(
          and(
            eq(schema.billableItems.id, c.req.param("id")),
            eq(schema.billableItems.organizationId, orgId),
          ),
        )
        .returning();
      if (!row) return c.json({ error: "not found" }, 404);
      return c.json({ retired: row.id });
    },
  );
}

/**
 * When this business chases, and what being late costs.
 *
 * Separate from the two lists above because it is one row rather than many:
 * a business has a policy, not a catalogue of them.
 */
export function registerBillingRules(ctx: ModuleContext) {
  ctx.app.get(
    "/api/invoicing/settings",
    requireSession(),
    requirePermission({ invoicing: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const [row] = await db
        .select()
        .from(schema.invoicingSettings)
        .where(eq(schema.invoicingSettings.organizationId, orgId))
        .limit(1);

      const rules = await db
        .select()
        .from(schema.reminderRules)
        .where(eq(schema.reminderRules.organizationId, orgId))
        .orderBy(asc(schema.reminderRules.daysOffset));

      return c.json({
        settings: row ?? {
          defaultDueDays: 30,
          defaultPaymentTerms: null,
          paymentTermOptions: DEFAULT_PAYMENT_TERMS,
          units: DEFAULT_UNITS,
          lateFeeType: null,
          lateFeeValue: 0,
          lateFeeGraceDays: 7,
        },
        rules,
        usingDefaults: !row,
      });
    },
  );

  ctx.app.put(
    "/api/invoicing/settings",
    requireSession(),
    requirePermission({ invoicing: ["update"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      const defaultDueDays = Number.isInteger(body.defaultDueDays)
        ? Math.max(0, Math.min(365, body.defaultDueDays as number))
        : 30;

      const lateFeeType =
        body.lateFeeType === "percent" || body.lateFeeType === "amount"
          ? body.lateFeeType
          : null;
      const lateFeeValue = Number.isInteger(body.lateFeeValue)
        ? (body.lateFeeValue as number)
        : 0;
      if (lateFeeType && lateFeeValue <= 0) {
        return c.json(
          { error: "a late fee of nothing is not a late fee" },
          400,
        );
      }
      // A percentage over 100 is a typo, not a policy anybody wrote down.
      if (lateFeeType === "percent" && lateFeeValue > 100_00) {
        return c.json({ error: "that is not a percentage" }, 400);
      }

      const values = {
        defaultDueDays,
        defaultPaymentTerms:
          String(body.defaultPaymentTerms ?? "").trim() || null,
        paymentTermOptions: cleanTerms(body.paymentTermOptions),
        units: cleanUnits(body.units),
        lateFeeType,
        lateFeeValue: lateFeeType ? lateFeeValue : 0,
        lateFeeGraceDays: Number.isInteger(body.lateFeeGraceDays)
          ? Math.max(0, Math.min(180, body.lateFeeGraceDays as number))
          : 7,
        updatedAt: new Date(),
      };

      const [saved] = await db
        .insert(schema.invoicingSettings)
        .values({ organizationId: orgId, ...values })
        .onConflictDoUpdate({
          target: schema.invoicingSettings.organizationId,
          set: values,
        })
        .returning();

      return c.json({ settings: saved, usingDefaults: false });
    },
  );

  ctx.app.post(
    "/api/invoicing/reminders",
    requireSession(),
    requirePermission({ invoicing: ["update"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      const name = String(body.name ?? "").trim();
      const subject = String(body.subject ?? "").trim();
      const text = String(body.body ?? "").trim();
      if (!name || !subject || !text) {
        return c.json(
          { error: "a reminder needs a name, a subject and something to say" },
          400,
        );
      }
      if (!Number.isInteger(body.daysOffset)) {
        // Negative is before the due date, positive after. Zero is the day.
        return c.json(
          { error: "daysOffset must be a whole number of days" },
          400,
        );
      }

      const [made] = await db
        .insert(schema.reminderRules)
        .values({
          organizationId: orgId,
          name,
          daysOffset: body.daysOffset as number,
          subject,
          body: text,
          active: body.active === true,
        })
        .returning();
      return c.json({ rule: made }, 201);
    },
  );

  ctx.app.patch(
    "/api/invoicing/reminders/:id",
    requireSession(),
    requirePermission({ invoicing: ["update"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      const patch: Record<string, unknown> = {};
      if (typeof body.name === "string" && body.name.trim()) {
        patch.name = body.name.trim();
      }
      if (typeof body.subject === "string" && body.subject.trim()) {
        patch.subject = body.subject.trim();
      }
      if (typeof body.body === "string" && body.body.trim()) {
        patch.body = body.body.trim();
      }
      if (Number.isInteger(body.daysOffset)) {
        patch.daysOffset = body.daysOffset;
      }
      if (typeof body.active === "boolean") patch.active = body.active;

      const [row] = await db
        .update(schema.reminderRules)
        .set(patch)
        .where(
          and(
            eq(schema.reminderRules.id, c.req.param("id")),
            eq(schema.reminderRules.organizationId, orgId),
          ),
        )
        .returning();
      if (!row) return c.json({ error: "not found" }, 404);
      return c.json({ rule: row });
    },
  );

  /**
   * A rule can be deleted outright, unlike a tax rate.
   *
   * Nothing on a document points at it — the log keeps its own record of what
   * was sent, with the wording as it went out — so removing the rule changes
   * no history.
   */
  ctx.app.delete(
    "/api/invoicing/reminders/:id",
    requireSession(),
    requirePermission({ invoicing: ["update"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const [row] = await db
        .delete(schema.reminderRules)
        .where(
          and(
            eq(schema.reminderRules.id, c.req.param("id")),
            eq(schema.reminderRules.organizationId, orgId),
          ),
        )
        .returning();
      if (!row) return c.json({ error: "not found" }, 404);
      return c.json({ deleted: row.id });
    },
  );
}
