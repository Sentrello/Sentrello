import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, schema } from "@sentrello/db";
import {
  type ListSpec,
  allConditions,
  countExpression,
  listParams,
  orderBy,
  pageWindow,
  searchCondition,
} from "@sentrello/db/list-query";
import type { SentrelloSession } from "@sentrello/module-sdk";
import { defineModule, toCsv } from "@sentrello/module-sdk";
import {
  and,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { registerAttachments } from "./attachments";
import {
  type FieldSubject,
  coerceCustomValues,
  customFieldsFor,
} from "./custom-fields";
import { registerCrmDashboard } from "./dashboard";
import { registerForms } from "./forms";
import { registerCrmHistory } from "./history";
import { registerCrmImages } from "./images";
import { registerInboundEmail } from "./inbound";
import { registerCrmManagers } from "./managers";
import {
  DEFAULT_LOST_STAGES,
  DEFAULT_WON_STAGES,
  registerCrmSettings,
} from "./settings";
import { registerTaskActions } from "./tasks";

/**
 * Org-scoped CRUD for one table. Every query carries the organizationId filter
 * — a business query without it is a cross-tenant leak, so the filter lives
 * here once rather than in each route.
 */
/**
 * Dates arrive as strings, because JSON has no date type.
 *
 * Drizzle hands a timestamp column straight to the driver, which calls
 * `.toISOString()` on it — so a perfectly ordinary ISO string became
 * `value.toISOString is not a function` and a 500. Every client sending a date
 * hit this, since there is no other way to send one.
 *
 * Converted where the column is a timestamp, and refused with a 400 when it is
 * not a date at all. Anything else is left alone.
 */
const TIMESTAMP_FIELDS = new Set([
  "occurredAt",
  "dueAt",
  "decidedAt",
  // A business importing its book brings the dates with it: when somebody
  // became a client, and when they were last dealt with. Without these the
  // whole imported book claims to have arrived this afternoon.
  "firstSeenAt",
  "lastSeenAt",
  "completedAt",
  "startsAt",
  "endsAt",
]);

function withParsedDates(
  body: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false; field: string } {
  const out: Record<string, unknown> = { ...body };
  for (const field of TIMESTAMP_FIELDS) {
    const raw = out[field];
    if (raw === undefined) continue;
    if (raw === null || raw === "") {
      out[field] = null;
      continue;
    }
    if (raw instanceof Date) continue;
    const parsed = new Date(String(raw));
    if (Number.isNaN(parsed.getTime())) return { ok: false, field };
    out[field] = parsed;
  }
  return { ok: true, value: out };
}

/**
 * An empty status is no status, and the column's default is what that means.
 *
 * `status` is NOT NULL DEFAULT 'cold', which protects against the field being
 * absent and not against it being present and blank — and a blank one is what
 * an unfilled select sends. The result renders as "—" and matches none of the
 * status filters, so the contact is invisible to every one of them while
 * looking perfectly normal in the list.
 */
export function normaliseStatus(body: Record<string, unknown>): void {
  if ("status" in body && String(body.status ?? "").trim() === "") {
    // `undefined` rather than removing the key: Drizzle skips undefined
    // values, so the column default applies on insert and the column is left
    // alone on update — which is what "they did not say" should mean.
    body.status = undefined;
  }
}

/**
 * Which records carry the fields a business added for itself.
 *
 * Written once and applied on both the create and the update path, because a
 * value that is checked on the way in and not on the way through is a value
 * that arrives by the second route.
 */
const CUSTOM_SUBJECTS: Partial<Record<keyof typeof tables, FieldSubject>> = {
  contacts: "contact",
  companies: "company",
  deals: "deal",
};

async function withCustomValues(
  resource: keyof typeof tables,
  orgId: string,
  value: Record<string, unknown>,
): Promise<void> {
  const subject = CUSTOM_SUBJECTS[resource];
  if (!subject) return;
  // Absent means "leave what is there" — a form that does not know about
  // custom fields must not wipe them.
  if (!("customValues" in value)) return;
  value.customValues = coerceCustomValues(
    await customFieldsFor(orgId),
    subject,
    value.customValues,
  );
}

/**
 * When a deal was won or lost, kept as its own fact.
 *
 * Called on every write that carries a stage. `updatedAt` used to stand in for
 * this and it is not the same thing: it moves whenever anybody touches the
 * record, so adding a note to a deal won in June moved it into the current
 * month and the six-month chart quietly rewrote its own history.
 *
 * Cleared when a deal moves back out of a decided stage — a deal reopened is a
 * deal that has not been decided yet, and leaving the old date on it would
 * count it twice.
 *
 * A caller may supply its own date, which is how a business loading its back
 * catalogue records a deal it won before it had Sentrello.
 */
async function withDecidedAt(
  orgId: string,
  value: Record<string, unknown>,
): Promise<void> {
  if (typeof value.stage !== "string") return;
  if (value.decidedAt !== undefined) return; // the caller said, so believe them

  const [settings] = await db
    .select({
      wonStages: schema.crmSettings.wonStages,
      lostStages: schema.crmSettings.lostStages,
    })
    .from(schema.crmSettings)
    .where(eq(schema.crmSettings.organizationId, orgId))
    .limit(1);

  const decided = new Set([
    ...(settings?.wonStages ?? DEFAULT_WON_STAGES),
    ...(settings?.lostStages ?? DEFAULT_LOST_STAGES),
  ]);
  value.decidedAt = decided.has(value.stage) ? new Date() : null;
}

function crud<T extends keyof typeof tables>(
  ctx: Parameters<Parameters<typeof defineModule>[0]["register"]>[0],
  resource: T,
) {
  const { table, path, singular, permission } = tables[resource];

  const list = (tables[resource] as { list?: ListSpec }).list;
  const narrow = (
    tables[resource] as {
      narrow?: (
        query: Record<string, string | undefined>,
        session: SentrelloSession,
      ) => Promise<(SQL | undefined)[]> | (SQL | undefined)[];
    }
  ).narrow;

  ctx.app.get(
    `/api/${path}`,
    requireSession(),
    requirePermission({ [permission]: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const query = c.req.query();

      // A resource with no list spec keeps the old behaviour exactly: every
      // row, unordered, unpaged. Tags and activities are read whole by the
      // screens that use them and gain nothing from a page.
      if (!list) {
        const rows = await db
          .select()
          .from(table)
          .where(eq(table.organizationId, orgId));
        return c.json({ [path]: rows });
      }

      const params = listParams(query);
      const where = await listWhere(resource, orgId, query, c.get("session"));

      const enrich = (
        tables[resource] as {
          enrich?: (
            rows: Record<string, unknown>[],
            orgId: string,
          ) => Promise<Record<string, unknown>[]>;
        }
      ).enrich;

      const window = pageWindow(params);
      if (!window) {
        const rows = await db
          .select()
          .from(table)
          .where(where)
          .orderBy(orderBy(list, params));
        return c.json({
          [path]: enrich
            ? await enrich(rows as Record<string, unknown>[], orgId)
            : rows,
          total: rows.length,
        });
      }

      // Two queries rather than a window function: the count has to ignore
      // the page, and a `count(*) over ()` returns nothing at all when the
      // page is past the end — which is exactly when the browser most needs
      // to be told how many there really are.
      const [rows, [counted]] = await Promise.all([
        db
          .select()
          .from(table)
          .where(where)
          .orderBy(orderBy(list, params))
          .limit(window.limit)
          .offset(window.offset),
        db.select({ total: countExpression }).from(table).where(where),
      ]);

      return c.json({
        [path]: enrich
          ? await enrich(rows as Record<string, unknown>[], orgId)
          : rows,
        total: counted?.total ?? 0,
        page: params.page,
        perPage: params.perPage,
      });
    },
  );

  ctx.app.post(
    `/api/${path}`,
    requireSession(),
    requirePermission({ [permission]: ["create"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = await c.req.json();
      const parsed = withParsedDates(body);
      if (!parsed.ok) {
        return c.json({ error: `${parsed.field} is not a date` }, 400);
      }
      if (resource === "contacts") {
        const name = displayName(parsed.value);
        if (name) parsed.value.name = name;
        fillNameParts(parsed.value);
        normaliseStatus(parsed.value);
      }
      await withCustomValues(resource, orgId, parsed.value);
      if (resource === "deals") await withDecidedAt(orgId, parsed.value);
      const [row] = await db
        .insert(table)
        .values({ ...parsed.value, organizationId: orgId })
        .returning();
      return c.json({ [singular]: row }, 201);
    },
  );

  ctx.app.patch(
    `/api/${path}/:id`,
    requireSession(),
    requirePermission({ [permission]: ["update"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = await c.req.json();
      // organizationId is never taken from the body — it comes from the session
      const { organizationId: _ignored, id: _id, ...rest } = body;
      const parsed = withParsedDates(rest);
      if (!parsed.ok) {
        return c.json({ error: `${parsed.field} is not a date` }, 400);
      }
      if (resource === "contacts") {
        const name = displayName(parsed.value);
        if (name) parsed.value.name = name;
        normaliseStatus(parsed.value);
      }
      await withCustomValues(resource, orgId, parsed.value);
      if (resource === "deals") await withDecidedAt(orgId, parsed.value);
      const [row] = await db
        .update(table)
        .set(parsed.value)
        .where(
          and(eq(table.id, c.req.param("id")), eq(table.organizationId, orgId)),
        )
        .returning();
      if (!row) return c.json({ error: "not found" }, 404);
      return c.json({ [singular]: row });
    },
  );

  const blocksDelete = (
    tables[resource] as {
      blocksDelete?: (orgId: string, id: string) => Promise<string | null>;
    }
  ).blocksDelete;

  ctx.app.delete(
    `/api/${path}/:id`,
    requireSession(),
    requirePermission({ [permission]: ["delete"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));

      // Nothing here is protected by a foreign key, so a delete that should be
      // refused would instead succeed and quietly orphan the rows pointing at
      // it — an invoice with no customer, a portal link that stops working.
      if (blocksDelete) {
        const reason = await blocksDelete(orgId, c.req.param("id"));
        if (reason) return c.json({ error: reason }, 409);
      }

      const [row] = await db
        .delete(table)
        .where(
          and(eq(table.id, c.req.param("id")), eq(table.organizationId, orgId)),
        )
        .returning();
      if (!row) return c.json({ error: "not found" }, 404);
      return c.json({ deleted: row.id });
    },
  );
}

/**
 * Finding a deal by anything a person would actually remember about it.
 *
 * A deal's own name is the least memorable thing about it — people say "the
 * Henderson job" or "that hospital one", meaning the contact or the company.
 * So this matches the deal's own text, the company it belongs to, and any
 * contact attached to it.
 *
 * The contact arm is an EXISTS over the jsonb array rather than a list of
 * matching ids folded into an IN: the id list grows with the number of
 * contacts matching the word, and a business with four hundred Smiths would
 * build a four-hundred-term query out of one search box.
 */
async function dealSearch(
  orgId: string,
  q: string | undefined,
): Promise<SQL | undefined> {
  const trimmed = (q ?? "").trim();
  if (!trimmed) return undefined;
  const term = `%${trimmed.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

  return or(
    ilike(schema.deals.name, term),
    ilike(schema.deals.description, term),
    inArray(
      schema.deals.companyId,
      db
        .select({ id: schema.companies.id })
        .from(schema.companies)
        .where(
          and(
            eq(schema.companies.organizationId, orgId),
            ilike(schema.companies.name, term),
          ),
        ),
    ),
    sql`exists (
      select 1
      from jsonb_array_elements_text(coalesce(${schema.deals.contactIds}, '[]'::jsonb)) as linked(contact_id)
      join ${schema.contacts} on ${schema.contacts.id}::text = linked.contact_id
      where ${schema.contacts.organizationId} = ${orgId}
        and (${schema.contacts.name} ilike ${term} or ${schema.contacts.email} ilike ${term})
    )`,
  );
}

const tables = {
  contacts: {
    table: schema.contacts,
    path: "contacts",
    singular: "contact",
    permission: "crm",
    /**
     * Background is searched too. It is where "met at the trade show, knows
     * Priya" ends up, and that sentence is often the only thing somebody can
     * remember about a contact they are trying to find again.
     */
    list: {
      search: [
        schema.contacts.name,
        schema.contacts.email,
        schema.contacts.phone,
        schema.contacts.title,
        schema.contacts.background,
      ],
      sortable: {
        firstName: schema.contacts.firstName,
        lastName: schema.contacts.lastName,
        name: schema.contacts.name,
        lastSeenAt: schema.contacts.lastSeenAt,
        firstSeenAt: schema.contacts.firstSeenAt,
        createdAt: schema.contacts.createdAt,
      },
      defaultSort: { field: "lastSeenAt", order: "desc" },
    } satisfies ListSpec,
    /**
     * A customer with financial history is not deletable.
     *
     * Their invoices would keep working but stop naming anyone, and the ledger
     * would still carry the money — the business would be left with revenue it
     * cannot attribute. Refusing is recoverable; deleting is not.
     */
    async blocksDelete(orgId: string, id: string) {
      const [invoices, quotes] = await Promise.all([
        db
          .select({ id: schema.invoices.id })
          .from(schema.invoices)
          .where(
            and(
              eq(schema.invoices.organizationId, orgId),
              eq(schema.invoices.contactId, id),
            ),
          ),
        db
          .select({ id: schema.quotes.id })
          .from(schema.quotes)
          .where(
            and(
              eq(schema.quotes.organizationId, orgId),
              eq(schema.quotes.contactId, id),
            ),
          ),
      ]);

      const parts: string[] = [];
      if (invoices.length) {
        parts.push(
          `${invoices.length} invoice${invoices.length > 1 ? "s" : ""}`,
        );
      }
      if (quotes.length) {
        parts.push(`${quotes.length} quote${quotes.length > 1 ? "s" : ""}`);
      }
      return parts.length
        ? `This customer has ${parts.join(" and ")}. Deleting them would leave those without a customer.`
        : null;
    },
    /**
     * What the list row needs beyond the contact's own columns: its tags, and
     * how much is outstanding on it. Atomic shows both on every row, and both
     * are the reason somebody picks one contact out of a page of them.
     */
    async enrich(rows: Record<string, unknown>[], orgId: string) {
      const ids = rows.map((row) => String(row.id));
      const [tags, tasks] = await Promise.all([
        tagsFor(orgId, "contact", ids),
        openTaskCounts(orgId, ids),
      ]);
      return rows.map((row) => ({
        ...row,
        tags: tags.get(String(row.id)) ?? [],
        openTasks: tasks.get(String(row.id)) ?? 0,
      }));
    },
    narrow(
      query: Record<string, string | undefined>,
      session: SentrelloSession,
    ) {
      const orgId = activeOrganizationId(session);
      return [
        query.status ? eq(schema.contacts.status, query.status) : undefined,
        // "Last seen" is five buttons in the sidebar, all of which resolve to
        // one end of a range — so one pair of parameters serves all of them
        // rather than five named filters the server has to know the meaning of.
        query.lastSeenAfter
          ? gte(schema.contacts.lastSeenAt, new Date(query.lastSeenAfter))
          : undefined,
        query.lastSeenBefore
          ? lte(schema.contacts.lastSeenAt, new Date(query.lastSeenBefore))
          : undefined,
        query.ownerId ? eq(schema.contacts.ownerId, query.ownerId) : undefined,
        query.companyId
          ? eq(schema.contacts.companyId, query.companyId)
          : undefined,
        query.hasNewsletter === "1"
          ? eq(schema.contacts.hasNewsletter, true)
          : undefined,
        // A tag lives in its own table, so this is the set of contacts
        // carrying it rather than a column comparison.
        query.tagId
          ? inArray(
              schema.contacts.id,
              db
                .select({ id: schema.taggables.entityId })
                .from(schema.taggables)
                .where(
                  and(
                    eq(schema.taggables.tagId, query.tagId),
                    eq(schema.taggables.entityType, "contact"),
                  ),
                ),
            )
          : undefined,
        // "Has something still to do." Done tasks do not count, or every
        // contact anybody ever rang stays in the filter for ever.
        query.withPendingTasks === "1"
          ? inArray(
              schema.contacts.id,
              db
                .select({ id: schema.tasks.contactId })
                .from(schema.tasks)
                .where(
                  and(
                    eq(schema.tasks.organizationId, orgId),
                    eq(schema.tasks.done, false),
                    isNotNull(schema.tasks.contactId),
                  ),
                ),
            )
          : undefined,
      ];
    },
  },
  companies: {
    table: schema.companies,
    path: "companies",
    singular: "company",
    permission: "crm",
    /**
     * What the card shows besides the company's own fields: who works there
     * and how much is in play. Both are counted for the page in one query
     * each, rather than each card asking for itself.
     */
    async enrich(rows: Record<string, unknown>[], orgId: string) {
      const ids = rows.map((row) => String(row.id));
      if (ids.length === 0) return rows;

      const [people, deals] = await Promise.all([
        db
          .select({
            id: schema.contacts.id,
            companyId: schema.contacts.companyId,
            name: schema.contacts.name,
            avatarPath: schema.contacts.avatarPath,
          })
          .from(schema.contacts)
          .where(
            and(
              eq(schema.contacts.organizationId, orgId),
              inArray(schema.contacts.companyId, ids),
            ),
          ),
        db
          .select({ companyId: schema.deals.companyId, total: countExpression })
          .from(schema.deals)
          .where(
            and(
              eq(schema.deals.organizationId, orgId),
              isNull(schema.deals.archivedAt),
              inArray(schema.deals.companyId, ids),
            ),
          )
          .groupBy(schema.deals.companyId),
      ]);

      const byCompany = new Map<string, typeof people>();
      for (const person of people) {
        if (!person.companyId) continue;
        const list = byCompany.get(person.companyId) ?? [];
        list.push(person);
        byCompany.set(person.companyId, list);
      }
      const dealCounts = new Map(
        deals
          .filter((d) => d.companyId)
          .map((d) => [String(d.companyId), d.total]),
      );

      return rows.map((row) => {
        const staff = byCompany.get(String(row.id)) ?? [];
        return {
          ...row,
          // Only the few the card can draw. Sending four hundred contacts so
          // three avatars can be shown is the sort of thing that makes a
          // list screen slow for reasons nobody can see.
          contacts: staff.slice(0, 4).map((p) => ({
            id: p.id,
            name: p.name,
            avatarPath: p.avatarPath,
          })),
          contactCount: staff.length,
          dealCount: dealCounts.get(String(row.id)) ?? 0,
        };
      });
    },
    list: {
      search: [
        schema.companies.name,
        schema.companies.sector,
        schema.companies.city,
        schema.companies.website,
        schema.companies.description,
      ],
      sortable: {
        name: schema.companies.name,
        createdAt: schema.companies.createdAt,
        sector: schema.companies.sector,
        size: schema.companies.size,
        city: schema.companies.city,
      },
      defaultSort: { field: "name", order: "asc" },
    } satisfies ListSpec,
    narrow(query: Record<string, string | undefined>) {
      return [
        query.sector ? eq(schema.companies.sector, query.sector) : undefined,
        query.size ? eq(schema.companies.size, Number(query.size)) : undefined,
        query.ownerId ? eq(schema.companies.ownerId, query.ownerId) : undefined,
      ];
    },
  },
  activities: {
    table: schema.activities,
    path: "activities",
    singular: "activity",
    permission: "crm",
  },
  tasks: {
    table: schema.tasks,
    path: "tasks",
    singular: "task",
    permission: "crm",
    list: {
      sortable: {
        title: schema.tasks.title,
        dueAt: schema.tasks.dueAt,
        doneAt: schema.tasks.doneAt,
      },
      // What is due soonest, because that is the only order a list of things
      // to do is ever read in.
      defaultSort: { field: "dueAt", order: "asc" },
    } satisfies ListSpec,
    /**
     * A task has one subject, so the list filters on whichever one was asked
     * for. Without this every screen that shows "the tasks for this record"
     * had to fetch all of them and sift in the browser, which is fine at
     * fifty tasks and wrong at five thousand.
     */
    narrow(query: Record<string, string | undefined>) {
      return [
        query.contactId
          ? eq(schema.tasks.contactId, query.contactId)
          : undefined,
        query.companyId
          ? eq(schema.tasks.companyId, query.companyId)
          : undefined,
        query.dealId ? eq(schema.tasks.dealId, query.dealId) : undefined,
        // Absent means everything, because a screen that lists finished tasks
        // is a real screen. "0" is the one the panels ask for.
        query.done === "0"
          ? eq(schema.tasks.done, false)
          : query.done === "1"
            ? eq(schema.tasks.done, true)
            : undefined,
      ];
    },
  },
  tags: {
    table: schema.tags,
    path: "tags",
    singular: "tag",
    permission: "crm",
  },
  deals: {
    table: schema.deals,
    path: "deals",
    singular: "deal",
    permission: "crm",
    list: {
      // The board is ordered by hand, so `position` is the default rather
      // than a date: a column somebody arranged has to come back arranged.
      sortable: {
        name: schema.deals.name,
        amountCents: schema.deals.amountCents,
        expectedCloseOn: schema.deals.expectedCloseOn,
        createdAt: schema.deals.createdAt,
        updatedAt: schema.deals.updatedAt,
        position: schema.deals.position,
      },
      defaultSort: { field: "position", order: "asc" },
    } satisfies ListSpec,
    async narrow(
      query: Record<string, string | undefined>,
      session: SentrelloSession,
    ) {
      const orgId = activeOrganizationId(session);
      return [
        query.stage ? eq(schema.deals.stage, query.stage) : undefined,
        query.category ? eq(schema.deals.category, query.category) : undefined,
        // Archived deals are the history, and the board is about now. They
        // come back only when asked for by name.
        query.archived === "1"
          ? isNotNull(schema.deals.archivedAt)
          : query.archived === "any"
            ? undefined
            : isNull(schema.deals.archivedAt),
        query.ownerId ? eq(schema.deals.ownerId, query.ownerId) : undefined,
        query.companyId
          ? eq(schema.deals.companyId, query.companyId)
          : undefined,
        query.tagId
          ? inArray(
              schema.deals.id,
              db
                .select({ id: schema.taggables.entityId })
                .from(schema.taggables)
                .where(
                  and(
                    eq(schema.taggables.tagId, query.tagId),
                    eq(schema.taggables.entityType, "deal"),
                  ),
                ),
            )
          : undefined,
        // Searching a deal means searching the people and the company on it,
        // not only its own title — "the Henderson job" is as likely to be
        // remembered by the customer's name as by what somebody typed here.
        await dealSearch(orgId, query.q),
      ];
    },
  },
  notes: {
    table: schema.notes,
    path: "notes",
    singular: "note",
    permission: "crm",
  },
} as const;

/**
 * The tags on a set of records, keyed by record.
 *
 * One query for the whole page rather than one per row: a list of a hundred
 * contacts each fetching its own tags is a hundred round trips to draw one
 * screen, and it is the most common way a list screen becomes slow.
 */
async function tagsFor(
  orgId: string,
  entityType: "contact" | "deal",
  ids: string[],
): Promise<Map<string, { id: string; name: string; color: string }[]>> {
  const byRecord = new Map<
    string,
    { id: string; name: string; color: string }[]
  >();
  if (ids.length === 0) return byRecord;

  const rows = await db
    .select({
      entityId: schema.taggables.entityId,
      id: schema.tags.id,
      name: schema.tags.name,
      color: schema.tags.color,
    })
    .from(schema.taggables)
    .innerJoin(schema.tags, eq(schema.tags.id, schema.taggables.tagId))
    // `taggables` carries no organizationId of its own, so the tag's is what
    // scopes this — the same rule the write side follows.
    .where(
      and(
        eq(schema.tags.organizationId, orgId),
        eq(schema.taggables.entityType, entityType),
        inArray(schema.taggables.entityId, ids),
      ),
    );

  for (const row of rows) {
    const list = byRecord.get(row.entityId) ?? [];
    list.push({ id: row.id, name: row.name, color: row.color });
    byRecord.set(row.entityId, list);
  }
  return byRecord;
}

/**
 * How many things are still to be done for each contact on the page.
 *
 * Open tasks only. Counting the done ones would leave every contact anybody
 * ever rang showing a number for ever, which tells nobody anything.
 */
async function openTaskCounts(
  orgId: string,
  contactIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (contactIds.length === 0) return counts;

  const rows = await db
    .select({ contactId: schema.tasks.contactId, total: countExpression })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.organizationId, orgId),
        eq(schema.tasks.done, false),
        inArray(schema.tasks.contactId, contactIds),
      ),
    )
    .groupBy(schema.tasks.contactId);

  for (const row of rows) {
    if (row.contactId) counts.set(row.contactId, row.total);
  }
  return counts;
}

/**
 * Everything a request asked to narrow a list by, as one condition.
 *
 * Shared by the list routes and the CSV exports. They were written
 * separately, which meant an export ran against the whole table however the
 * screen was filtered — somebody filtering to nine hot leads and clicking
 * Export got two thousand rows and no indication anything had been ignored.
 */
async function listWhere<T extends keyof typeof tables>(
  resource: T,
  orgId: string,
  query: Record<string, string | undefined>,
  session: SentrelloSession,
): Promise<SQL | undefined> {
  const entry = tables[resource] as {
    table: (typeof tables)[T]["table"];
    list?: ListSpec;
    narrow?: (
      query: Record<string, string | undefined>,
      session: SentrelloSession,
    ) => Promise<(SQL | undefined)[]> | (SQL | undefined)[];
  };

  return allConditions([
    eq(entry.table.organizationId, orgId),
    entry.list ? searchCondition(entry.list, listParams(query).q) : undefined,
    ...(entry.narrow ? await entry.narrow(query, session) : []),
  ]);
}

/**
 * A contact's display name, always first + last.
 *
 * Written on every save rather than computed on read, because invoices,
 * quotes and the customer portal select `name` directly — and an invoice
 * addressed to an empty string because somebody edited a surname is not a
 * failure anyone would connect back to the CRM.
 */
/**
 * The columns an exported contacts file carries.
 *
 * Named rather than written inline because the import screen has to recognise
 * them: export, edit in a spreadsheet, import back is the loop people actually
 * use, and the two lists live in different packages with nothing but a test
 * between them.
 */
export const EXPORT_COLUMNS = [
  "First name",
  "Last name",
  "Job title",
  "Company",
  "Email",
  "Phone",
  "Other emails",
  "Other phones",
  "LinkedIn",
] as const;

export function displayName(body: Record<string, unknown>): string | undefined {
  const first = typeof body.firstName === "string" ? body.firstName.trim() : "";
  const last = typeof body.lastName === "string" ? body.lastName.trim() : "";
  const joined = [first, last].filter(Boolean).join(" ");
  if (joined) return joined;
  // Neither name given: leave whatever `name` was sent alone, so a contact
  // recorded as a single string — which is most of them, historically — is not
  // wiped by an edit that never mentioned it.
  return typeof body.name === "string" ? body.name : undefined;
}

/**
 * The parts of a name, filled in from the whole when only the whole was given.
 *
 * A contact can arrive carrying nothing but `name` — from an import, from the
 * API, from a seed. The edit form is built from the two parts and its Save is
 * guarded on one of them being present, so a contact stored that way could be
 * opened and never saved: six of the eighteen on the demo were in that state.
 *
 * Filling them in on the way in means the record is coherent from the start,
 * rather than every reader having to know to fall back. Only when both are
 * absent — a caller who sent one part deliberately has said something, and
 * this must not talk over it.
 */
export function fillNameParts(body: Record<string, unknown>): void {
  const has = (v: unknown) => typeof v === "string" && v.trim() !== "";
  if (has(body.firstName) || has(body.lastName)) return;
  if (!has(body.name)) return;

  const parts = String(body.name).trim().split(/\s+/).filter(Boolean);
  const [first, ...rest] = parts;
  body.firstName = first ?? null;
  body.lastName = rest.length > 0 ? rest.join(" ") : null;
}

/**
 * The kanban, and everything a contact is attached to.
 *
 * Registered by hand rather than through `crud` because neither is a row
 * operation: one reorders a column, the other answers a question that spans
 * five tables.
 */
function registerCrmScreens(
  ctx: Parameters<Parameters<typeof defineModule>[0]["register"]>[0],
) {
  /**
   * Bring a spreadsheet of contacts in.
   *
   * The rows arrive already mapped to our field names — the mapping happens on
   * the screen, where somebody can see their own column headings. This end
   * only has to be careful about what it writes.
   *
   * Companies are matched by name and created when missing, because a
   * spreadsheet says "Ellesmere Dental", not a uuid, and asking somebody to
   * create thirty companies before importing their contacts is the reason the
   * import never happens.
   */
  ctx.app.post(
    "/api/contacts/import",
    requireSession(),
    requirePermission({ crm: ["create"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as {
        rows?: Record<string, string>[];
      };
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (rows.length === 0) return c.json({ error: "nothing to import" }, 400);
      // A cap, because this runs in one request and a hundred thousand rows
      // would hold a connection open long enough to look like a hang.
      if (rows.length > 5000) {
        return c.json({ error: "too many rows; split the file" }, 413);
      }

      const existingCompanies = await db
        .select()
        .from(schema.companies)
        .where(eq(schema.companies.organizationId, orgId));
      const byName = new Map(
        existingCompanies.map((co) => [co.name.trim().toLowerCase(), co.id]),
      );

      let imported = 0;
      let companiesCreated = 0;
      const skipped: { row: number; why: string }[] = [];

      for (const [index, raw] of rows.entries()) {
        const firstName = (raw.firstName ?? "").trim();
        const lastName = (raw.lastName ?? "").trim();
        const name = [firstName, lastName].filter(Boolean).join(" ");
        if (!name) {
          // Nameless rows are the blank lines at the bottom of every
          // spreadsheet. Reported rather than silently dropped.
          skipped.push({ row: index + 2, why: "no name" });
          continue;
        }

        let companyId: string | null = null;
        const companyName = (raw.company ?? "").trim();
        if (companyName) {
          const key = companyName.toLowerCase();
          const found = byName.get(key);
          if (found) {
            companyId = found;
          } else {
            const [made] = await db
              .insert(schema.companies)
              .values({ organizationId: orgId, name: companyName })
              .returning();
            if (made) {
              companyId = made.id;
              byName.set(key, made.id);
              companiesCreated += 1;
            }
          }
        }

        await db.insert(schema.contacts).values({
          organizationId: orgId,
          name,
          firstName: firstName || null,
          lastName: lastName || null,
          title: (raw.title ?? "").trim() || null,
          email: (raw.email ?? "").trim() || null,
          phone: (raw.phone ?? "").trim() || null,
          linkedinUrl: (raw.linkedinUrl ?? "").trim() || null,
          companyId,
        });
        imported += 1;
      }

      return c.json({ imported, companiesCreated, skipped });
    },
  );

  /**
   * Contacts and companies, as a spreadsheet.
   *
   * A trial that begins with an empty CRM and a re-typing job is a trial that
   * ends — so getting data out matters as much as getting it in, and it is
   * also how somebody checks an import went the way they expected.
   */
  ctx.app.get(
    "/api/contacts/export.csv",
    requireSession(),
    requirePermission({ crm: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      // The same filters the screen is showing. An export that quietly
      // ignored them handed somebody the whole table when they had asked for
      // nine rows, with nothing on screen to say so.
      const where = await listWhere(
        "contacts",
        orgId,
        c.req.query(),
        c.get("session"),
      );
      const [rows, allCompanies] = await Promise.all([
        db.select().from(schema.contacts).where(where),
        db
          .select()
          .from(schema.companies)
          .where(eq(schema.companies.organizationId, orgId)),
      ]);
      const companyName = new Map(allCompanies.map((co) => [co.id, co.name]));

      const csv = toCsv(
        [...EXPORT_COLUMNS],
        rows.map((r) => [
          r.firstName ?? "",
          r.lastName ?? "",
          r.title ?? "",
          // The company's name, not its id. A spreadsheet full of uuids is not
          // something anybody can read, edit or import elsewhere.
          r.companyId ? (companyName.get(r.companyId) ?? "") : "",
          r.email ?? "",
          r.phone ?? "",
          (r.emails ?? []).map((e) => `${e.label}: ${e.value}`).join("; "),
          (r.phones ?? []).map((e) => `${e.label}: ${e.value}`).join("; "),
          r.linkedinUrl ?? "",
        ]),
      );

      return c.body(csv, 200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="contacts.csv"',
      });
    },
  );

  ctx.app.get(
    "/api/companies/export.csv",
    requireSession(),
    requirePermission({ crm: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const rows = await db
        .select()
        .from(schema.companies)
        .where(
          await listWhere("companies", orgId, c.req.query(), c.get("session")),
        );

      const csv = toCsv(
        [
          "Name",
          "Sector",
          "People",
          "Phone",
          "Website",
          "Address",
          "City",
          "Country",
          "Description",
        ],
        rows.map((r) => [
          r.name,
          r.sector ?? "",
          r.size ?? "",
          r.phone ?? "",
          r.website ?? "",
          r.address ?? "",
          r.city ?? "",
          r.country ?? "",
          r.description ?? "",
        ]),
      );

      return c.body(csv, 200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="companies.csv"',
      });
    },
  );

  /**
   * The board, as a spreadsheet.
   *
   * Filtered exactly as the screen is filtered — the point of exporting a
   * pipeline is almost always to send somebody one slice of it, and an export
   * that ignored the filter would be the wrong slice every time.
   *
   * Money is written as a decimal string here and nowhere else: this file is
   * going into a spreadsheet, and cents would be read as whole currency
   * units by every one of them.
   */
  ctx.app.get(
    "/api/deals/export.csv",
    requireSession(),
    requirePermission({ crm: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const [rows, allCompanies, allContacts] = await Promise.all([
        db
          .select()
          .from(schema.deals)
          .where(
            await listWhere("deals", orgId, c.req.query(), c.get("session")),
          )
          .orderBy(schema.deals.stage, schema.deals.position),
        db
          .select()
          .from(schema.companies)
          .where(eq(schema.companies.organizationId, orgId)),
        db
          .select()
          .from(schema.contacts)
          .where(eq(schema.contacts.organizationId, orgId)),
      ]);

      const companyName = new Map(allCompanies.map((co) => [co.id, co.name]));
      const contactName = new Map(allContacts.map((ct) => [ct.id, ct.name]));

      const csv = toCsv(
        [
          "Name",
          "Company",
          "Contacts",
          "Stage",
          "Category",
          "Amount",
          "Expected close",
          "Archived",
          "Description",
        ],
        rows.map((r) => [
          r.name,
          r.companyId ? (companyName.get(r.companyId) ?? "") : "",
          (r.contactIds ?? [])
            .map((id) => contactName.get(id) ?? "")
            .filter(Boolean)
            .join("; "),
          r.stage,
          r.category ?? "",
          (r.amountCents / 100).toFixed(2),
          r.expectedCloseOn ?? "",
          r.archivedAt ? "yes" : "",
          r.description ?? "",
        ]),
      );

      return c.body(csv, 200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="deals.csv"',
      });
    },
  );

  /**
   * Move a deal: which column, and where in it.
   *
   * Position and stage together in one call, because dragging a card is one
   * action to the person doing it. Two calls would leave a card that had
   * changed column but not order if the second failed.
   */
  ctx.app.patch(
    "/api/deals/:id/move",
    requireSession(),
    requirePermission({ crm: ["update"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as {
        stage?: string;
        position?: number;
      };

      const stage = typeof body.stage === "string" ? body.stage : undefined;
      const position =
        typeof body.position === "number" && Number.isFinite(body.position)
          ? Math.max(0, Math.trunc(body.position))
          : undefined;
      if (!stage && position === undefined) {
        return c.json({ error: "a stage or a position is required" }, 400);
      }

      const [row] = await db
        .update(schema.deals)
        .set({
          ...(stage ? { stage } : {}),
          ...(position === undefined ? {} : { position }),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.deals.id, c.req.param("id")),
            eq(schema.deals.organizationId, orgId),
          ),
        )
        .returning();
      if (!row) return c.json({ error: "not found" }, 404);
      return c.json({ deal: row });
    },
  );

  /**
   * Put a tag on something, or take it off.
   *
   * `taggables` carries no organizationId of its own — it is scoped through
   * the tag it points at. So the tag is checked against the session's
   * organisation before anything is written, or one business could label
   * another's records by guessing an id.
   */
  // Registered per entity rather than with one clever pattern. The pattern was
  // `:entityType{contact|company|deal}s`, which is not valid Hono and took the
  // whole router down with it — every route in the module 500'd, not just
  // these. Three plain paths cost nothing and cannot do that.
  for (const [plural, entityType] of [
    ["contacts", "contact"],
    ["companies", "company"],
    ["deals", "deal"],
  ] as const) {
    ctx.app.post(
      `/api/${plural}/:id/tags`,
      requireSession(),
      requirePermission({ crm: ["update"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const entityId = c.req.param("id");
        const body = (await c.req.json().catch(() => ({}))) as {
          tagId?: string;
        };
        if (!body.tagId) return c.json({ error: "a tagId is required" }, 400);

        const [tag] = await db
          .select()
          .from(schema.tags)
          .where(
            and(
              eq(schema.tags.id, body.tagId),
              eq(schema.tags.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!tag) return c.json({ error: "no such tag" }, 404);

        // Tagging something twice is not an error — somebody clicked twice, and
        // a duplicate row would show the same label on the record twice.
        const [existing] = await db
          .select()
          .from(schema.taggables)
          .where(
            and(
              eq(schema.taggables.tagId, tag.id),
              eq(schema.taggables.entityType, entityType),
              eq(schema.taggables.entityId, entityId),
            ),
          )
          .limit(1);
        if (existing) return c.json({ tag });

        await db
          .insert(schema.taggables)
          .values({ tagId: tag.id, entityType, entityId });
        return c.json({ tag }, 201);
      },
    );

    ctx.app.delete(
      `/api/${plural}/:id/tags/:tagId`,
      requireSession(),
      requirePermission({ crm: ["update"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));

        // Same check on the way out: without it, a guessed tag id would detach
        // a label from another business's record.
        const [tag] = await db
          .select()
          .from(schema.tags)
          .where(
            and(
              eq(schema.tags.id, c.req.param("tagId")),
              eq(schema.tags.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!tag) return c.json({ error: "no such tag" }, 404);

        await db
          .delete(schema.taggables)
          .where(
            and(
              eq(schema.taggables.tagId, tag.id),
              eq(schema.taggables.entityType, entityType),
              eq(schema.taggables.entityId, c.req.param("id")),
            ),
          );
        return c.body(null, 204);
      },
    );
  }

  /**
   * One deal, and who it involves.
   *
   * The board links here, so without it every card is a dead end — the same
   * problem a contact's company link had before companies got a screen.
   */
  ctx.app.get(
    "/api/deals/:id/related",
    requireSession(),
    requirePermission({ crm: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("id");

      const [deal] = await db
        .select()
        .from(schema.deals)
        .where(
          and(eq(schema.deals.id, id), eq(schema.deals.organizationId, orgId)),
        )
        .limit(1);
      if (!deal) return c.json({ error: "not found" }, 404);

      const [company, everyone, notes] = await Promise.all([
        deal.companyId
          ? db
              .select()
              .from(schema.companies)
              .where(
                and(
                  eq(schema.companies.id, deal.companyId),
                  eq(schema.companies.organizationId, orgId),
                ),
              )
              .limit(1)
          : Promise.resolve([]),
        // The deal names its contacts in a jsonb array, so they are gathered
        // here rather than joined. Same trade as the contact screen, same
        // reason: a business under twenty staff will never notice.
        db
          .select()
          .from(schema.contacts)
          .where(eq(schema.contacts.organizationId, orgId)),
        db
          .select()
          .from(schema.notes)
          .where(
            and(
              eq(schema.notes.organizationId, orgId),
              eq(schema.notes.entityType, "deal"),
              eq(schema.notes.entityId, id),
            ),
          )
          .orderBy(desc(schema.notes.createdAt)),
      ]);

      const on = new Set(deal.contactIds ?? []);
      return c.json({
        deal,
        company: company[0] ?? null,
        contacts: everyone.filter((p) => on.has(p.id)),
        notes,
      });
    },
  );

  /**
   * One company, and who and what belongs to it.
   *
   * The other half of the same idea. A contact's company link is only worth
   * following if there is something on the other side — the people who work
   * there and the deals in flight, which is the view a business actually wants
   * before a meeting.
   */
  ctx.app.get(
    "/api/companies/:id/related",
    requireSession(),
    requirePermission({ crm: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("id");

      const [company] = await db
        .select()
        .from(schema.companies)
        .where(
          and(
            eq(schema.companies.id, id),
            eq(schema.companies.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!company) return c.json({ error: "not found" }, 404);

      const [people, deals, notes, tasks] = await Promise.all([
        db
          .select()
          .from(schema.contacts)
          .where(
            and(
              eq(schema.contacts.organizationId, orgId),
              eq(schema.contacts.companyId, id),
            ),
          ),
        db
          .select()
          .from(schema.deals)
          .where(
            and(
              eq(schema.deals.organizationId, orgId),
              eq(schema.deals.companyId, id),
            ),
          ),
        db
          .select()
          .from(schema.notes)
          .where(
            and(
              eq(schema.notes.organizationId, orgId),
              eq(schema.notes.entityType, "company"),
              eq(schema.notes.entityId, id),
            ),
          )
          .orderBy(desc(schema.notes.createdAt)),
        /**
         * The account's own tasks, not its people's.
         *
         * Rolling up every contact's tasks would put somebody else's follow-up
         * on this screen with a tick box beside it, and ticking it there would
         * finish work the person who owns it never saw.
         */
        db
          .select()
          .from(schema.tasks)
          .where(
            and(
              eq(schema.tasks.organizationId, orgId),
              eq(schema.tasks.companyId, id),
            ),
          ),
      ]);

      return c.json({ company, contacts: people, deals, notes, tasks });
    },
  );

  /**
   * One contact, and everything it connects to.
   *
   * The whole point of the rework: a contact that cannot show its deals, notes
   * and tasks is a row in a table, and the application reads as unrelated
   * parts because that is what it serves.
   */
  ctx.app.get(
    "/api/contacts/:id/related",
    requireSession(),
    requirePermission({ crm: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("id");

      const [contact] = await db
        .select()
        .from(schema.contacts)
        .where(
          and(
            eq(schema.contacts.id, id),
            eq(schema.contacts.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!contact) return c.json({ error: "not found" }, 404);

      const [company, notes, tasks, tagRows, allDeals] = await Promise.all([
        contact.companyId
          ? db
              .select()
              .from(schema.companies)
              .where(
                and(
                  eq(schema.companies.id, contact.companyId),
                  eq(schema.companies.organizationId, orgId),
                ),
              )
              .limit(1)
          : Promise.resolve([]),
        db
          .select()
          .from(schema.notes)
          .where(
            and(
              eq(schema.notes.organizationId, orgId),
              eq(schema.notes.entityType, "contact"),
              eq(schema.notes.entityId, id),
            ),
          )
          .orderBy(desc(schema.notes.createdAt)),
        db
          .select()
          .from(schema.tasks)
          .where(
            and(
              eq(schema.tasks.organizationId, orgId),
              eq(schema.tasks.contactId, id),
            ),
          ),
        db
          .select({ tag: schema.tags })
          .from(schema.taggables)
          .innerJoin(schema.tags, eq(schema.taggables.tagId, schema.tags.id))
          .where(
            and(
              eq(schema.taggables.entityType, "contact"),
              eq(schema.taggables.entityId, id),
              eq(schema.tags.organizationId, orgId),
            ),
          ),
        // Deals hold their contacts in a jsonb array, so the filter happens
        // here rather than in SQL. Fine at the scale this product targets —
        // under twenty staff — and honest about it rather than pretending a
        // clever query exists.
        // ponytail: scan-and-filter; move to a join table if a business ever
        // has enough deals for this to show.
        db
          .select()
          .from(schema.deals)
          .where(eq(schema.deals.organizationId, orgId)),
      ]);

      return c.json({
        contact,
        company: company[0] ?? null,
        deals: allDeals.filter((d) => (d.contactIds ?? []).includes(id)),
        notes,
        tasks,
        tags: tagRows.map((r) => r.tag),
      });
    },
  );
}

/**
 * One CSV field.
 *
 * Quoted whenever it contains a comma, a quote or a newline, with inner quotes
 * doubled — the rules every spreadsheet expects. A note reading `Called, no
 * answer` becomes two columns without this, and the whole file shifts by one
 * from that row down.
 */
/** Re-exported so the tests and callers here keep their import. */
export { toCsv };

export default defineModule({
  id: "crm",
  tier: "free",
  register(ctx) {
    /**
     * The CRM, as one thing with five pages under it.
     *
     * It used to register three siblings straight into the section, which put
     * Contacts, Companies and Deals at the same level as Invoices and the Shop
     * — five equal items saying nothing about which belong together. The
     * parent is not a screen: opening it opens its dashboard.
     */
    ctx.registerNav({
      id: "crm",
      label: "CRM",
      order: 10,
      group: "Sales",
      icon: "contact-round",
      // The book of customers is not everybody's to open.
      requires: { crm: ["read"] },
    });
    ctx.registerNav({
      id: "crm-dashboard",
      label: "Dashboard",
      order: 1,
      parent: "crm",
      icon: "gauge",
      requires: { crm: ["read"] },
    });
    ctx.registerNav({
      id: "contacts",
      label: "Contacts",
      order: 2,
      parent: "crm",
      icon: "user",
      requires: { crm: ["read"] },
    });
    ctx.registerNav({
      id: "companies",
      label: "Companies",
      order: 3,
      parent: "crm",
      icon: "building",
      requires: { crm: ["read"] },
    });
    // The pipeline. Named Deals as the reference has it.
    ctx.registerNav({
      id: "deals",
      label: "Deals",
      order: 4,
      parent: "crm",
      icon: "trending-up",
      requires: { crm: ["read"] },
    });
    ctx.registerNav({
      id: "crm-settings",
      label: "Settings",
      order: 5,
      parent: "crm",
      icon: "settings",
      // Stages, tags and the labels this business uses: configuration of the
      // CRM itself, which is not the same authority as reading it.
      requires: { crm: ["update"] },
    });

    for (const p of ["read", "create", "update", "delete"]) {
      ctx.registerPermission(`crm:${p}`);
    }

    registerCrmDashboard(ctx);
    registerCrmImages(ctx);
    registerCrmManagers(ctx);
    registerCrmSettings(ctx);
    for (const resource of Object.keys(tables) as (keyof typeof tables)[]) {
      crud(ctx, resource);
    }
    registerTaskActions(ctx);
    registerForms(ctx);
    registerCrmScreens(ctx);
    registerAttachments(ctx);
    registerInboundEmail(ctx);
    registerCrmHistory(ctx);
  },
});
