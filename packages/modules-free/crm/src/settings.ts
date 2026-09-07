/**
 * What a business calls its own pipeline.
 *
 * The deal stages lived in the browser as a five-item constant, which meant
 * every business ran the process a developer happened to pick. A roofer goes
 * quote → measured → scheduled → done; a consultancy looks nothing like that.
 *
 * Absent settings mean the defaults, so an instance that never opens this
 * screen behaves exactly as it did before the table existed.
 */
import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, schema } from "@sentrello/db";
import type { ModuleContext } from "@sentrello/module-sdk";
import { type CustomField, parseCustomFields } from "./custom-fields";

/** What a pipeline looks like before anybody has said otherwise. */
export const DEFAULT_STAGES = [
  { id: "opportunity", label: "Opportunity" },
  { id: "proposal", label: "Proposal" },
  { id: "negotiation", label: "Negotiation" },
  { id: "won", label: "Won" },
  { id: "lost", label: "Lost" },
];

export const DEFAULT_TASK_TYPES = ["call", "email", "meeting", "other"];

/**
 * How warm a contact is, coldest first.
 *
 * The order is the order the filter offers them in, so it is data rather than
 * a sort somebody has to reproduce. The colours are what makes a list of two
 * hundred contacts scannable — the status is read as a dot, not as a word.
 */
export const DEFAULT_CONTACT_STATUSES = [
  { id: "cold", label: "Cold", color: "#7dbde8" },
  { id: "warm", label: "Warm", color: "#e8cb7d" },
  { id: "hot", label: "Hot", color: "#e88b7d" },
  { id: "in-contract", label: "In contract", color: "#a4e87d" },
];

/**
 * What kind of work a deal is.
 *
 * Deliberately generic: this product sells to roofers and to consultancies,
 * and neither one's list of categories is any use to the other. A business
 * that never opens the settings screen gets these and can ignore them.
 */
export const DEFAULT_DEAL_CATEGORIES = [
  "New business",
  "Repeat business",
  "Maintenance",
  "Other",
];

/** The industries a company might be in. */
export const DEFAULT_COMPANY_SECTORS = [
  "Construction",
  "Education",
  "Financial services",
  "Health care",
  "Hospitality",
  "Manufacturing",
  "Professional services",
  "Property",
  "Retail",
  "Technology",
  "Transport",
  "Other",
];

/**
 * Which stages mean the deal came off, and which mean it did not.
 *
 * Derived from the default stage list rather than restated, so renaming a
 * default stage in one place cannot leave the dashboard counting a stage that
 * no longer exists.
 */
export const DEFAULT_WON_STAGES = ["won"];
export const DEFAULT_LOST_STAGES = ["lost"];

/**
 * Enough for any pipeline anybody actually runs.
 *
 * Worth enforcing rather than trusting the screen: this arrives as JSON from a
 * browser, and a board with four hundred columns is one PUT away.
 */
const MAX_STAGES = 12;
const MAX_TASK_TYPES = 12;

/**
 * The id is what deals store, so it has to survive a rename of the label.
 *
 * Derived from the label only when a stage is first created; after that the
 * browser sends the id back and it is kept. Renaming "Proposal" to "Quote sent"
 * must not orphan every deal sitting in it.
 */
export function stageId(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "stage"
  );
}

interface Stage {
  id: string;
  label: string;
}

/** Reads what the browser sent, and refuses anything a board could not draw. */
export function parseStages(input: unknown): Stage[] {
  if (!Array.isArray(input)) throw new RangeError("stages must be a list");
  if (input.length === 0) {
    throw new RangeError("a pipeline needs at least one stage");
  }
  if (input.length > MAX_STAGES) {
    throw new RangeError(`a pipeline can have at most ${MAX_STAGES} stages`);
  }

  const seen = new Set<string>();
  return input.map((raw) => {
    const label = String((raw as { label?: unknown })?.label ?? "")
      .trim()
      .slice(0, 40);
    if (!label) throw new RangeError("every stage needs a name");

    const given = String((raw as { id?: unknown })?.id ?? "").trim();
    const id = given ? given.slice(0, 40) : stageId(label);
    if (seen.has(id)) {
      throw new RangeError(`there are two stages called "${label}"`);
    }
    seen.add(id);
    return { id, label };
  });
}

export function parseTaskTypes(input: unknown): string[] {
  if (!Array.isArray(input)) throw new RangeError("task types must be a list");
  if (input.length > MAX_TASK_TYPES) {
    throw new RangeError(`at most ${MAX_TASK_TYPES} task types`);
  }
  const types = [
    ...new Set(
      input
        .map((raw) =>
          String(raw ?? "")
            .trim()
            .toLowerCase()
            .slice(0, 30),
        )
        .filter(Boolean),
    ),
  ];
  if (types.length === 0) throw new RangeError("keep at least one task type");
  return types;
}

interface ContactStatus {
  id: string;
  label: string;
  color: string;
}

/** A colour the browser sent, or nothing. Never interpolated into a style. */
function parseColor(raw: unknown, fallback: string): string {
  const value = String(raw ?? "").trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

export function parseContactStatuses(input: unknown): ContactStatus[] {
  if (!Array.isArray(input)) throw new RangeError("statuses must be a list");
  if (input.length === 0) throw new RangeError("keep at least one status");
  if (input.length > MAX_STAGES) {
    throw new RangeError(`at most ${MAX_STAGES} statuses`);
  }

  const seen = new Set<string>();
  return input.map((raw, i) => {
    const label = String((raw as { label?: unknown })?.label ?? "")
      .trim()
      .slice(0, 40);
    if (!label) throw new RangeError("every status needs a name");
    const given = String((raw as { id?: unknown })?.id ?? "").trim();
    const id = given ? given.slice(0, 40) : stageId(label);
    if (seen.has(id)) {
      throw new RangeError(`there are two statuses called "${label}"`);
    }
    seen.add(id);
    return {
      id,
      label,
      color: parseColor(
        (raw as { color?: unknown })?.color,
        DEFAULT_CONTACT_STATUSES[i % DEFAULT_CONTACT_STATUSES.length]?.color ??
          "#94a3b8",
      ),
    };
  });
}

/** A plain list of short labels: sectors, categories. */
export function parseLabels(input: unknown, what: string): string[] {
  if (!Array.isArray(input)) throw new RangeError(`${what} must be a list`);
  if (input.length > 40) throw new RangeError(`at most 40 ${what}`);
  return [
    ...new Set(
      input
        .map((raw) =>
          String(raw ?? "")
            .trim()
            .slice(0, 40),
        )
        .filter(Boolean),
    ),
  ];
}

/**
 * Which stage ids count as won or lost.
 *
 * Checked against the stages being saved in the same request, not against
 * what is in the database: saving a renamed pipeline and its outcome stages
 * together must not fail because the old names are gone.
 */
export function parseOutcomeStages(
  input: unknown,
  stages: Stage[],
  what: string,
): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new RangeError(`${what} must be a list`);
  const known = new Set(stages.map((stage) => stage.id));
  const chosen = [...new Set(input.map((raw) => String(raw ?? "").trim()))];
  for (const id of chosen) {
    if (!known.has(id)) {
      throw new RangeError(`"${id}" is not one of this pipeline's stages`);
    }
  }
  return chosen;
}

/** What is already stored, so an older client cannot clear it by omission. */
async function currentCustomFields(orgId: string): Promise<CustomField[]> {
  const [row] = await db
    .select({ customFields: schema.crmSettings.customFields })
    .from(schema.crmSettings)
    .where(eq(schema.crmSettings.organizationId, orgId))
    .limit(1);
  return row?.customFields ?? [];
}

/**
 * Whether two custom field lists say the same thing.
 *
 * Key order, deliberately ignored. These come back from Postgres as `jsonb`,
 * which stores keys in its own order and hands them back reordered — so
 * comparing `JSON.stringify` of each says "changed" for a list that was sent
 * back exactly as it arrived, and a Free instance saving its pipeline would be
 * refused for touching nothing.
 *
 * Order of the *list* is compared, because that is the order the fields appear
 * in on a record, and rearranging them is a change like any other.
 */
function sameFields(a: CustomField[], b: CustomField[]): boolean {
  const canonical = (fields: CustomField[]) =>
    JSON.stringify(
      fields.map((f) => [f.id, f.label, f.type, f.appliesTo, f.options ?? []]),
    );
  return canonical(a) === canonical(b);
}

export function registerCrmSettings(ctx: ModuleContext) {
  ctx.app.get(
    "/api/crm/settings",
    requireSession(),
    // Read, not update: the deals board needs the stages to draw itself, and
    // everybody who can see a deal can see the board.
    requirePermission({ crm: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const [row] = await db
        .select()
        .from(schema.crmSettings)
        .where(eq(schema.crmSettings.organizationId, orgId))
        .limit(1);

      return c.json({
        dealStages: row?.dealStages ?? DEFAULT_STAGES,
        taskTypes: row?.taskTypes ?? DEFAULT_TASK_TYPES,
        contactStatuses: row?.contactStatuses ?? DEFAULT_CONTACT_STATUSES,
        dealCategories: row?.dealCategories ?? DEFAULT_DEAL_CATEGORIES,
        companySectors: row?.companySectors ?? DEFAULT_COMPANY_SECTORS,
        wonStages: row?.wonStages ?? DEFAULT_WON_STAGES,
        lostStages: row?.lostStages ?? DEFAULT_LOST_STAGES,
        customFields: row?.customFields ?? [],
        /** So the screen can say "these are the defaults" rather than guess. */
        usingDefaults: !row,
      });
    },
  );

  ctx.app.put(
    "/api/crm/settings",
    requireSession(),
    requirePermission({ crm: ["update"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = await c.req.json().catch(() => ({}));

      let dealStages: Stage[];
      let taskTypes: string[];
      let contactStatuses: ContactStatus[];
      let dealCategories: string[];
      let companySectors: string[];
      let wonStages: string[];
      let lostStages: string[];
      let customFields: CustomField[];
      try {
        dealStages = parseStages(body.dealStages);
        taskTypes = parseTaskTypes(body.taskTypes);
        contactStatuses = parseContactStatuses(
          body.contactStatuses ?? DEFAULT_CONTACT_STATUSES,
        );
        dealCategories = parseLabels(
          body.dealCategories ?? DEFAULT_DEAL_CATEGORIES,
          "deal categories",
        );
        companySectors = parseLabels(
          body.companySectors ?? DEFAULT_COMPANY_SECTORS,
          "company sectors",
        );
        wonStages = parseOutcomeStages(
          body.wonStages ??
            DEFAULT_WON_STAGES.filter((id) =>
              (body.dealStages as Stage[] | undefined)?.some(
                (s) => s.id === id,
              ),
            ),
          dealStages,
          "won stages",
        );
        lostStages = parseOutcomeStages(
          body.lostStages ??
            DEFAULT_LOST_STAGES.filter((id) =>
              (body.dealStages as Stage[] | undefined)?.some(
                (s) => s.id === id,
              ),
            ),
          dealStages,
          "lost stages",
        );
        // Absent means unchanged rather than none: a settings screen from
        // before these existed must not delete every field a business added.
        customFields = parseCustomFields(
          body.customFields ?? (await currentCustomFields(orgId)),
        );

        /**
         * Custom fields are Pro, and this is the only route that writes them.
         *
         * Not a `proOnly` middleware, because this endpoint also carries the
         * deal stages, statuses, sectors and task types — all free, and all
         * saved in the same request. Refusing the whole route on Free would
         * take away six things to gate one.
         *
         * So it refuses only a request that would actually **change** them. A
         * Free instance saving its pipeline sends the custom fields back
         * unaltered along with everything else, and must go through; a Free
         * instance trying to add one is told why rather than having the write
         * silently dropped, which would read as "I saved it and it did not
         * save".
         *
         * Existing definitions are untouched and still returned by the GET
         * above, so a business whose licence lapsed keeps seeing what it
         * recorded. Nothing is deleted and nothing becomes unreadable — the
         * only thing withheld is defining more.
         */
        if (!ctx.entitled({ tier: "pro" })) {
          const stored = await currentCustomFields(orgId);
          if (sameFields(customFields, stored) === false) {
            return c.json(
              {
                error:
                  "Custom fields are part of Pro. What you have already defined is still here and still readable; adding or changing one needs a licence.",
                field: "customFields",
              },
              403,
            );
          }
        }
      } catch (err) {
        if (err instanceof RangeError)
          return c.json({ error: err.message }, 400);
        throw err;
      }

      /**
       * A stage cannot be removed while deals are standing in it.
       *
       * The alternative is a deal whose stage matches no column: invisible on
       * the board, still in the database, discovered when somebody asks where
       * the job went. Refusing and naming the count lets them move the deals
       * first, which is what they would have to do anyway.
       */
      const keeping = new Set(dealStages.map((stage) => stage.id));
      const orphans = await db
        .select({ stage: schema.deals.stage })
        .from(schema.deals)
        .where(eq(schema.deals.organizationId, orgId));

      const stranded = new Map<string, number>();
      for (const deal of orphans) {
        if (keeping.has(deal.stage)) continue;
        stranded.set(deal.stage, (stranded.get(deal.stage) ?? 0) + 1);
      }
      const worst = [...stranded.entries()][0];
      if (worst) {
        const [name, count] = worst;
        return c.json(
          {
            error: `${count} deal${count === 1 ? " is" : "s are"} still in "${name}". Move them to another stage before removing it.`,
            stranded: Object.fromEntries(stranded),
          },
          409,
        );
      }

      const values = {
        dealStages,
        taskTypes,
        contactStatuses,
        dealCategories,
        companySectors,
        wonStages,
        lostStages,
        customFields,
      };

      const [saved] = await db
        .insert(schema.crmSettings)
        .values({ organizationId: orgId, ...values })
        .onConflictDoUpdate({
          target: schema.crmSettings.organizationId,
          set: { ...values, updatedAt: new Date() },
        })
        .returning();

      return c.json({
        dealStages: saved?.dealStages ?? dealStages,
        taskTypes: saved?.taskTypes ?? taskTypes,
        contactStatuses: saved?.contactStatuses ?? contactStatuses,
        dealCategories: saved?.dealCategories ?? dealCategories,
        companySectors: saved?.companySectors ?? companySectors,
        wonStages: saved?.wonStages ?? wonStages,
        lostStages: saved?.lostStages ?? lostStages,
        usingDefaults: false,
      });
    },
  );

  /**
   * Deleting a tag, which the generic CRUD does not do safely.
   *
   * A tag is referenced by contacts, so removing the row alone leaves those
   * references pointing at nothing. This clears them in the same breath.
   */
  ctx.app.delete(
    "/api/crm/tags/:id",
    requireSession(),
    requirePermission({ crm: ["delete"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("id");

      const [tag] = await db
        .select()
        .from(schema.tags)
        .where(
          and(eq(schema.tags.id, id), eq(schema.tags.organizationId, orgId)),
        )
        .limit(1);
      if (!tag) return c.json({ error: "not found" }, 404);

      // Tags attach through `taggables`, so removing the tag row alone would
      // leave rows pointing at nothing — which reads as a contact carrying a
      // tag that cannot be drawn.
      const attached = await db
        .delete(schema.taggables)
        .where(eq(schema.taggables.tagId, id))
        .returning({ id: schema.taggables.id });

      await db
        .delete(schema.tags)
        .where(
          and(eq(schema.tags.id, id), eq(schema.tags.organizationId, orgId)),
        );

      return c.json({ deleted: id, removedFrom: attached.length });
    },
  );
}
