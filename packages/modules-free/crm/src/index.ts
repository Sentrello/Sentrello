import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, schema } from "@sentrello/db";
import { MOVED, UNUSABLE_CLAIM, versionClaim } from "@sentrello/db/concurrency";
import { recordConsent } from "@sentrello/db/consent";
import {
  type CRM_SUBJECTS,
  companyMarks,
  companyNames,
  crmValues,
} from "@sentrello/db/crm";
import { dayIn } from "@sentrello/db/day";
import {
  type ListSpec,
  UNPAGED_MAX,
  allConditions,
  capUnpaged,
  countExpression,
  inChunks,
  listParams,
  orderByWith,
  pageWindow,
  searchCondition,
} from "@sentrello/db/list-query";
import { organizationMember } from "@sentrello/db/membership";
import { sumCents } from "@sentrello/db/money";
import { recordChanged } from "@sentrello/db/record-events";
import { asText, checkedText, notText } from "@sentrello/db/text-columns";
import { timezoneFor } from "@sentrello/db/timezone";
import { dateFrom, dayFrom, demandDate } from "@sentrello/db/timezone";
import type {
  ModuleContext,
  SearchHit,
  SentrelloSession,
} from "@sentrello/module-sdk";
import {
  defineModule,
  publicBodyLimit,
  scoreFor,
  toCsv,
  withComputedColumns,
} from "@sentrello/module-sdk";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { registerAttachments } from "./attachments";
import { type TrailRemoved, removeCrmTrail } from "./cascade";
import { registerCrmDashboard } from "./dashboard";
import { CRM_ENTITY, type CrmResource } from "./entities";
import { MAX_UPLOAD_BODY_BYTES, registerForms } from "./forms";
import { registerCrmHistory } from "./history";
import { registerCrmImages } from "./images";
import { MAX_INBOUND_ATTACHMENT, registerInboundEmail } from "./inbound";
import { registerCrmManagers } from "./managers";
import { registerMerge } from "./merge";
import { registerCrmPersonalData } from "./personal-data";
import { registerCrmRetention } from "./retention";
import {
  DEFAULT_LOST_STAGES,
  DEFAULT_STAGES,
  DEFAULT_WON_STAGES,
  registerCrmSettings,
} from "./settings";
import { registerCrmSummary } from "./summary";
import { registerTaskActions } from "./tasks";
import { registerVies } from "./vies";
import { registerSavedViews } from "./views";
import { registerWebhooks } from "./webhooks";

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

/** Any of the tables the generic CRUD writes. */
type CrudTable = (typeof tables)[keyof typeof tables]["table"];

/**
 * Which of a table's own columns are moments, and which are plain days.
 *
 * Asked of the table rather than kept as a list. The list was missing
 * `createdAt`, `doneAt` and `doNotSellOn`, and a string sent to any of them
 * reached Drizzle's `value.toISOString()` — a TypeError, a 500 and "something
 * went wrong" on a field a client can perfectly well send.
 *
 * Which is the fault the list was written to fix, still happening on the
 * columns nobody had remembered to add to it. A hand-kept list of a table's
 * own columns is a second copy of the schema.
 */
function dateColumnsOf(table: CrudTable): {
  moments: Set<string>;
  days: Set<string>;
} {
  const moments = new Set<string>();
  const days = new Set<string>();
  for (const [name, column] of Object.entries(getTableColumns(table))) {
    const kind = (column as { columnType?: string }).columnType;
    if (kind === "PgTimestamp" || kind === "PgTimestampString")
      moments.add(name);
    if (kind === "PgDate" || kind === "PgDateString") days.add(name);
  }
  return { moments, days };
}

function withParsedDates(
  body: Record<string, unknown>,
  table?: CrudTable,
): { ok: true; value: Record<string, unknown> } | { ok: false; field: string } {
  const out: Record<string, unknown> = { ...body };
  const known = table ? dateColumnsOf(table) : null;
  for (const field of known?.moments ?? TIMESTAMP_FIELDS) {
    const raw = out[field];
    if (raw === undefined) continue;
    if (raw === null || raw === "") {
      out[field] = null;
      continue;
    }
    if (raw instanceof Date) continue;
    const parsed = dateFrom(String(raw));
    if (!parsed) return { ok: false, field };
    out[field] = parsed;
  }
  /*
   * A plain calendar column is left a string, and still has to be a real day.
   *
   * `expectedCloseOn` is a `date`, not a timestamp, so it goes to the driver
   * as the string it arrived as — and Postgres refuses "2026-02-30" with a
   * type error, which reaches the person as a 500 on ordinary typed input.
   * Refused here instead, where the answer can name the field.
   */
  for (const field of known?.days ?? DAY_FIELDS) {
    const raw = out[field];
    if (raw === undefined) continue;
    if (raw === null || raw === "") {
      out[field] = null;
      continue;
    }
    if (!dayFrom(String(raw))) return { ok: false, field };
    out[field] = String(raw);
  }
  return { ok: true, value: out };
}

/**
 * Columns that are a day rather than a moment.
 *
 * Kept as `YYYY-MM-DD` strings because that is what a `date` column is, and
 * turning one into a Date would move it by a timezone on the way back out.
 */
const DAY_FIELDS = new Set(["expectedCloseOn"]);

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
  if ("status" in body && asText(body.status, "status").trim() === "") {
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
const CUSTOM_SUBJECTS: Partial<
  Record<keyof typeof tables, (typeof CRM_SUBJECTS)[number]>
> = {
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
  value.customValues = await crmValues(orgId, subject, value.customValues);
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

/**
 * A write the database refused because of what the caller sent.
 *
 * The generic CRUD writes the body and the organization id and nothing else,
 * so a not-null, range or type violation here is the caller's mistake rather
 * than ours — which is what makes it safe to answer 400 in this one place
 * and not globally, where the same violation could be our own bug.
 *
 * It was a 500 and "something went wrong": `POST /api/tasks` with no title,
 * a deal with `amountCents: "lots"`, a deal worth nine quadrillion. None of
 * those is a crash and none of them said what was wrong.
 *
 * `null` for anything else, so a genuine failure keeps the behaviour it had
 * and still reaches the log.
 */
function refusedByTheDatabase(err: unknown): string | null {
  const e = err as { code?: unknown; column_name?: unknown; cause?: unknown };
  const at = (e.code ? e : (e.cause as typeof e)) ?? e;
  const field =
    typeof at?.column_name === "string" ? at.column_name : undefined;

  switch (at?.code) {
    case "23502":
      return `${field ?? "Something the record needs"} is required.`;
    case "22001":
      return `${field ?? "One of those values"} is too long.`;
    case "22003":
      return `${field ?? "One of those numbers"} is larger than this field holds.`;
    case "22P02":
      return `${field ?? "One of those values"} is not the right kind of value.`;
    case "42703":
      // A field that is not on this record at all. Only a change can produce
      // it: a create writes what the table has, and this writes what was sent.
      return "There is no such field on this record.";
    case "22007":
    case "22008":
      return `${field ?? "One of those values"} is not a date.`;
    default:
      return null;
  }
}

/**
 * The names behind `authorId`, attached to a page of notes.
 *
 * One query for the page rather than one per note, and a row whose author has
 * since been deleted still reads — "somebody who has left" is a true answer
 * and a blank space is not. Notes written before the column was set carry no
 * author at all, which is also true and is said as nothing rather than as a
 * guess.
 */
async function withAuthors<T extends { authorId: string | null }>(
  notes: T[],
): Promise<(T & { authorName: string | null })[]> {
  const ids = [...new Set(notes.map((n) => n.authorId).filter(Boolean))];
  if (ids.length === 0) {
    return notes.map((n) => ({ ...n, authorName: null }));
  }

  const people = await db
    .select({
      id: schema.user.id,
      name: schema.user.name,
      email: schema.user.email,
    })
    .from(schema.user)
    .where(inArray(schema.user.id, ids as string[]));
  const named = new Map(
    people.map((p) => [p.id, p.name || p.email || null] as const),
  );

  return notes.map((n) => ({
    ...n,
    authorName: n.authorId
      ? (named.get(n.authorId) ?? "somebody who has left")
      : null,
  }));
}

/** Thrown inside the write so nothing commits; answered as a 409 outside it. */
class RecordMoved extends Error {}
/** The same, for a claim that could not be read at all. Answered as a 400. */
class ClaimUnusable extends Error {}

function crud<T extends keyof typeof tables>(
  ctx: Parameters<Parameters<typeof defineModule>[0]["register"]>[0],
  resource: T,
) {
  const { table, path, permission } = tables[resource];
  const singular = CRM_ENTITY[resource];

  /**
   * Whether a save on this table can be checked against the version the
   * caller read. Every CRM table keeps `updated_at` except tags, which are a
   * name and a colour nobody collides over.
   */
  const keepsVersion = "updatedAt" in table;

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

      const enrich = (
        tables[resource] as {
          enrich?: (
            rows: Record<string, unknown>[],
            orgId: string,
          ) => Promise<Record<string, unknown>[]>;
        }
      ).enrich;

      /**
       * The rows as they go out: what the resource adds of its own, and then
       * whatever a module works out on top of them.
       *
       * Both take the whole page at once. A computed column reads values that
       * are already on the row, so the page costs no query at all — and a
       * provider handed the page rather than a record is a provider that
       * cannot quietly become one lookup per row.
       *
       * Nothing is registered on a Free instance, so `columns` is absent and
       * the rows are the same objects the list has always returned.
       */
      const decorate = async (rows: Record<string, unknown>[]) => {
        const enriched = (enrich ? await enrich(rows, orgId) : rows).map(
          withoutCredentials,
        );
        const computed = await withComputedColumns(singular, orgId, enriched);
        return {
          [path]: computed.rows,
          ...(computed.columns ? { computedColumns: computed.columns } : {}),
        };
      };

      // A resource with no list spec keeps the old behaviour exactly: every
      // row, unordered, unpaged. What is left on that path is tags, of which
      // a business has tens — activities and notes were on it too, and at
      // 150,084 rows that was a 40 MB response.
      if (!list) {
        const rows = await db
          .select()
          .from(table)
          .where(eq(table.organizationId, orgId));
        return c.json(await decorate(rows as Record<string, unknown>[]));
      }

      const params = listParams(query);
      const where = await listWhere(resource, orgId, query, c.get("session"));

      /**
       * Grouping rides beside paging rather than replacing it: the rows come
       * back exactly as before, and `groups` describes the *whole* filtered
       * set — a value, how many rows carry it, and whatever the resource
       * says is worth summing. Computed here rather than on the page in the
       * browser, because a page is a window and "how much is in each stage"
       * is a question about everything the filter matched.
       *
       * The field is an allow-list, like the sort fields and for the same
       * reason; a name not on it groups nothing rather than erroring, so an
       * old saved view survives a field being withdrawn.
       */
      const groupColumn = (
        tables[resource] as { groupable?: Record<string, PgColumn> }
      ).groupable?.[query.groupBy ?? ""];
      const aggregates = (
        tables[resource] as { groupAggregates?: Record<string, SQL<number>> }
      ).groupAggregates;
      const grouped = groupColumn
        ? await db
            .select({
              value: sql<string | number | null>`${groupColumn}`,
              count: countExpression,
              ...(aggregates ?? {}),
            })
            .from(table)
            .where(where)
            .groupBy(groupColumn)
            .orderBy(asc(groupColumn))
        : undefined;

      const window = pageWindow(params);
      if (!window) {
        /*
         * A caller that never mentioned paging still gets the list, but not
         * the whole book. Five screens fill a customer picker this way, and
         * at a hundred thousand contacts that request stopped working
         * outright — so it is capped, and says when it has been, rather than
         * handing a dropdown eight megabytes of JSON or nothing at all.
         */
        const all = await db
          .select()
          .from(table)
          .where(where)
          .orderBy(...orderByWith(list, params, table.id))
          .limit(UNPAGED_MAX + 1);
        const { rows, truncated } = capUnpaged(all);
        return c.json({
          ...(await decorate(rows as Record<string, unknown>[])),
          total: rows.length,
          ...(truncated ? { truncated: true } : {}),
          ...(grouped ? { groups: grouped } : {}),
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
          .orderBy(...orderByWith(list, params, table.id))
          .limit(window.limit)
          .offset(window.offset),
        db.select({ total: countExpression }).from(table).where(where),
      ]);

      return c.json({
        ...(await decorate(rows as Record<string, unknown>[])),
        total: counted?.total ?? 0,
        page: params.page,
        perPage: params.perPage,
        ...(grouped ? { groups: grouped } : {}),
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
      const parsed = withParsedDates(body, table);
      if (!parsed.ok) {
        return c.json({ error: `${parsed.field} is not a date` }, 400);
      }
      if (resource === "contacts") {
        const name = displayName(parsed.value);
        if (name) parsed.value.name = name;
        fillNameParts(parsed.value);
        normaliseStatus(parsed.value);
      }
      const shaped = checkedText(table, parsed.value);
      if (!shaped.ok) {
        return c.json({ error: notText(shaped.field) }, 400);
      }
      await withCustomValues(resource, orgId, parsed.value);
      if (resource === "deals") await withDecidedAt(orgId, parsed.value);
      const refError = await checkLinkedRecords(resource, orgId, parsed.value);
      if (refError) return c.json({ error: refError.error }, refError.status);
      /**
       * Who wrote it, on the one record that is somebody's words.
       *
       * `notes.author_id` has been a column since the CRM was written and
       * nothing ever set it, so a shared timeline showed four notes from
       * four people as four notes from nobody — and "who said we'd call them
       * back" is exactly the question a second person on the account asks.
       * Taken from the session rather than the body: the browser does not
       * get to say who wrote something.
       */
      if (resource === "notes") {
        parsed.value.authorId = c.get("session").user.id;
      }

      let row: Record<string, unknown> | undefined;
      try {
        [row] = await db
          .insert(table)
          .values({ ...parsed.value, organizationId: orgId })
          .returning();
      } catch (err) {
        const refused = refusedByTheDatabase(err);
        if (!refused) throw err;
        return c.json({ error: refused }, 400);
      }
      await announce(orgId, resource, row, "created", null, row);
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
      /*
       * `expectedUpdatedAt` is a question about the row, not a field of it, so
       * it comes off the body here — left in, it reaches the UPDATE as a column
       * that does not exist and the save is refused for the wrong reason.
       */
      // organizationId is never taken from the body — it comes from the
      // session — and neither is a credential: see `CREDENTIAL_FIELDS`.
      const {
        organizationId: _ignored,
        id: _id,
        expectedUpdatedAt: _claimed,
        ...withCredentials
      } = body;
      /*
       * And a caller that asks for a check this table cannot answer is told so.
       *
       * Ignoring it would be the quiet kind of wrong: the request looks
       * protected, the answer is 200, and the protection was never there.
       */
      if (!keepsVersion && typeof body.expectedUpdatedAt === "string") {
        return c.json(
          {
            error: `A ${singular} does not keep a modification time, so a save cannot be checked against one.`,
          },
          400,
        );
      }
      const rest = withoutCredentials(withCredentials);
      const parsed = withParsedDates(rest, table);
      if (!parsed.ok) {
        return c.json({ error: `${parsed.field} is not a date` }, 400);
      }
      if (resource === "contacts") {
        const name = displayName(parsed.value);
        if (name) parsed.value.name = name;
        normaliseStatus(parsed.value);
        /**
         * The date the request was received, stamped by the server.
         *
         * Not taken from the caller: the CCPA gives fifteen business days to
         * act on an opt-out and the evidence that matters is when it arrived,
         * which a browser is in no position to assert. Cleared when the choice
         * is reversed, so the field never describes a request that is no longer
         * in force.
         */
        if (parsed.value.doNotSell !== undefined) {
          // The day it arrived, where the business is. Stamped as an instant it
          // read as the day after in UTC for a business in California, which is
          // where this rule comes from and where the fifteen days are counted.
          parsed.value.doNotSellOn = parsed.value.doNotSell
            ? dayIn(new Date(), await timezoneFor(orgId))
            : null;
        }
      }
      const shaped = checkedText(table, parsed.value);
      if (!shaped.ok) {
        return c.json({ error: notText(shaped.field) }, 400);
      }
      await withCustomValues(resource, orgId, parsed.value);
      if (resource === "deals") await withDecidedAt(orgId, parsed.value);
      const refError = await checkLinkedRecords(
        resource,
        orgId,
        parsed.value,
        c.req.param("id"),
      );
      if (refError) return c.json({ error: refError.error }, refError.status);

      /**
       * Two of these fields are legal positions rather than preferences, and
       * a tick is not evidence of one.
       *
       * GDPR Article 7(1) puts the burden of demonstrating consent on the
       * business; the CCPA cares when an opt-out arrived. `hasNewsletter` had
       * no history at all, and `doNotSellOn` had a date and nothing about how
       * it happened. Both write a record now, in the same transaction as the
       * change, so the tick and its evidence cannot disagree — and the change
       * is refused rather than recorded unprovably if the record cannot be
       * written.
       *
       * Only when the value actually moves. Saving a contact's phone number
       * is not somebody consenting to anything, and a history full of
       * unchanged ticks is a history nobody reads.
       */
      const consentFields =
        resource === "contacts"
          ? ([
              ["hasNewsletter", "marketing.email"],
              ["doNotSell", "data.sale"],
            ] as const)
          : [];
      const watched = consentFields.filter(
        ([field]) => parsed.value[field] !== undefined,
      );

      /*
       * Read before writing, always.
       *
       * It used to be read only when a consent field was in the change, which
       * was enough for consent and not for anything else. An automation asks
       * "when the stage *becomes* won", and the difference between that and
       * "when the stage is won" is the row as it was a moment ago — without it
       * every rule on a busy record fires on every save.
       */
      /*
       * Something this record actually has, or there is nothing to do.
       *
       * Drizzle drops keys the table does not know, so a change made only of
       * fields that are not on this record built `update "tasks" set  where
       * …` — malformed SQL, a 500, and "something went wrong". A PATCH with
       * nothing the record recognises is the caller's mistake and reads as
       * one now.
       */
      const columns = Object.keys(getTableColumns(table));
      if (!Object.keys(parsed.value).some((key) => columns.includes(key))) {
        return c.json(
          { error: "There is nothing here that this record has to change." },
          400,
        );
      }

      const write = db.transaction(async (tx) => {
        const before = (
          await tx
            .select()
            .from(table)
            .where(
              and(
                eq(table.id, c.req.param("id")),
                eq(table.organizationId, orgId),
              ),
            )
            .limit(1)
        )[0];

        /*
         * Refused before anything is written, inside the transaction that read
         * the row, so the version checked is the version replaced.
         *
         * Thrown rather than returned because a `c.json` here would leave the
         * transaction to commit around it.
         */
        if (keepsVersion && before) {
          const claim = versionClaim(before as { updatedAt: Date }, body);
          if (claim === "moved") throw new RecordMoved();
          if (claim === "unusable") throw new ClaimUnusable();
        }

        /*
         * The display name is built from the record as it will be, not from
         * what this request happened to mention.
         *
         * It was built from the body alone, so a PATCH carrying only
         * `firstName` rewrote `name` to just that — leaving a contact called
         * "Ruth" with `lastName: "Adeyemi"` still sitting beside it, the record
         * disagreeing with itself and the surname gone from every list and
         * search that reads `name`. The screen sends both fields so nobody had
         * met it; anything talking to the API directly would have, and a
         * partial update is the whole point of a PATCH.
         */
        if (
          resource === "contacts" &&
          before &&
          (parsed.value.firstName !== undefined ||
            parsed.value.lastName !== undefined)
        ) {
          const merged = displayName({ ...before, ...parsed.value });
          if (merged) parsed.value.name = merged;
        }

        const updated = await tx
          .update(table)
          .set(parsed.value)
          .where(
            and(
              eq(table.id, c.req.param("id")),
              eq(table.organizationId, orgId),
            ),
          )
          .returning();

        const saved = updated[0] as Record<string, unknown> | undefined;
        if (saved && before) {
          const session = c.get("session");
          for (const [field, purpose] of watched) {
            const was = (before as Record<string, unknown>)[field] === true;
            const now = saved[field] === true;
            if (was === now) continue;
            await recordConsent(
              {
                organizationId: orgId,
                subject: {
                  kind: "contact",
                  id: String(saved.id),
                  label:
                    (saved.name as string | null) ??
                    (saved.email as string | null),
                },
                purpose,
                /*
                 * "Do not sell" reads backwards from every other consent here:
                 * ticking it is a refusal, so the record says consent was
                 * withdrawn rather than given.
                 */
                granted: purpose === "data.sale" ? !now : now,
                source: "staff",
                actor: {
                  id: session.user.id,
                  name: session.user.name ?? session.user.email,
                },
              },
              tx,
            );
          }
        }
        return [updated[0], before] as const;
      });

      /*
       * The same refusals the create answers, for the same reason.
       *
       * A change writes the caller's body and nothing else, so a field that
       * does not exist, a number too large for its column or a word where a
       * date belongs are all theirs. Every one of them was a 500 and
       * "something went wrong".
       */
      let written: Awaited<typeof write>;
      try {
        written = await write;
      } catch (err) {
        if (err instanceof RecordMoved) return c.json({ error: MOVED }, 409);
        if (err instanceof ClaimUnusable) {
          return c.json({ error: UNUSABLE_CLAIM }, 400);
        }
        const refused = refusedByTheDatabase(err);
        if (!refused) throw err;
        return c.json({ error: refused }, 400);
      }
      const [row, before] = written;

      if (!row) return c.json({ error: "not found" }, 404);
      await announce(orgId, resource, row, "updated", before, row);
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

      /*
       * The record and everything that was only ever about it, together.
       *
       * Nothing here has a foreign key, so the trail does not follow by
       * itself — and one row of that trail is a task, which carries a due
       * date and is read by a sweep that selects across every organization.
       * A task about a customer the CRM can no longer show is a reminder
       * somebody still gets. `removeCrmTrail` decides what goes; this decides
       * that it goes in the same commit as the record, so a failure half way
       * cannot leave the half that gets chased.
       */
      const trail = CRM_ENTITY[resource];
      let related: TrailRemoved | null = null;
      const [row] = await db.transaction(async (tx) => {
        const deleted = await tx
          .delete(table)
          .where(
            and(
              eq(table.id, c.req.param("id")),
              eq(table.organizationId, orgId),
            ),
          )
          .returning();
        if (
          deleted[0] &&
          (trail === "contact" || trail === "company" || trail === "deal")
        ) {
          related = await removeCrmTrail(
            orgId,
            trail,
            [String(deleted[0].id)],
            tx,
          );
        }
        return deleted;
      });
      if (!row) return c.json({ error: "not found" }, 404);
      /*
       * And what went with it, on the event rather than left to be looked up.
       *
       * The trail was deleted in the transaction above, so by the time anything
       * reads this feed there is nothing left to find. A restore built on
       * looking afterwards brings the record back bare — the notes, calls,
       * follow-ups and tags simply gone — and says nothing about it, which is
       * worse than not offering a restore at all.
       */
      await announce(orgId, resource, row, "deleted", row, null, related);
      return c.json({ deleted: row.id });
    },
  );
}

/**
 * Fields that are credentials, and never travel through a resource route.
 *
 * `portalToken` is the whole of a customer's portal login: anyone holding it
 * reads that customer's invoices at `/account/:token` with no session at
 * all. It sat on `contacts`, and `contacts` is served by the generic factory
 * below, which selects the row and returns it — so every list answered to
 * anybody with `crm:read` carried one per customer, including a contractor
 * with no invoicing permission at all. Worse on the way in: `PATCH` spread
 * the body into the update, so `crm:update` could *choose* a token, which is
 * a guessable door that outlives whoever made it.
 *
 * The field was already understood to be a credential in two places out of
 * three — the webhook payload strips it and the CSV export omits it — which
 * is exactly how this survived: every place somebody thought about it was
 * handled, and the generic path nobody had to think about was not.
 *
 * Stripped in both directions, in the factory, so a resource added later
 * inherits it. A portal link is minted by `POST /api/contacts/:id/portal-link`
 * and comes back as a URL; nothing legitimate needs the raw token from a
 * list.
 */
const CREDENTIAL_FIELDS = ["portalToken"] as const;

function withoutCredentials<T extends Record<string, unknown>>(row: T): T {
  let copy: Record<string, unknown> | null = null;
  for (const field of CREDENTIAL_FIELDS) {
    if (field in row) {
      copy ??= { ...row };
      delete copy[field];
    }
  }
  return (copy ?? row) as T;
}

/**
 * Say that one of these records changed.
 *
 * In the factory rather than at each route, which is the point: contacts,
 * companies, deals and everything else this builds all announce themselves
 * because there is one place that writes them. The history screen was built the
 * other way round — derived from the records rather than written to a log — on
 * the reasoning that a second write path starts lying the first time somebody
 * forgets one. That reasoning is right, and this is how to keep it: do not have
 * a second path, have one.
 *
 * The entity name comes from `CRM_ENTITY` — written down per resource, never
 * worked out from the path — so an automation says "deal" and "company" rather
 * than "deals" and "companie". It is the word somebody would use out loud, and
 * it is the same word the subscriber picks from, read out of the same map.
 */
async function announce(
  orgId: string,
  resource: CrmResource,
  row: Record<string, unknown> | undefined,
  action: "created" | "updated" | "deleted",
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  /** The rows a delete took with it. See `removeCrmTrail`. */
  related: TrailRemoved | null = null,
): Promise<void> {
  if (!row?.id) return;
  await recordChanged({
    organizationId: orgId,
    entity: CRM_ENTITY[resource],
    entityId: String(row.id),
    action,
    before: before ?? null,
    after: after ?? null,
    related,
  });
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

/**
 * Every id in the body that points at another record, confirmed to be this
 * organisation's before anything is written.
 *
 * An unverified id here is how one business's record ends up naming
 * another's — and an id that is not a uuid at all would otherwise surface as
 * a database error rather than the 404 it is.
 */
/**
 * What a refusal is, and which answer it deserves.
 *
 * A linked record that cannot be found is 404, as it always was. A person who
 * does not work here is 400: the id is not a record this caller was trying to
 * reach, it is a value in a field they filled in wrongly, and the difference
 * is what tells a browser whether to show "not found" or to put the cursor
 * back in the box.
 */
interface LinkRefusal {
  error: string;
  status: 400 | 404;
}

async function checkLinkedRecords(
  resource: string,
  orgId: string,
  value: Record<string, unknown>,
  recordId?: string,
): Promise<LinkRefusal | null> {
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const owned = async (
    table:
      | typeof schema.companies
      | typeof schema.contacts
      | typeof schema.deals,
    id: unknown,
  ): Promise<boolean> => {
    if (typeof id !== "string" || !uuid.test(id)) return false;
    const [row] = await db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.id, id), eq(table.organizationId, orgId)))
      .limit(1);
    return Boolean(row);
  };

  /** Whether this record already stores this person in this field. */
  const alreadyOn = async (
    id: string,
    field: "ownerId" | "assigneeId",
    who: unknown,
  ): Promise<boolean> => {
    if (!uuid.test(id)) return false;
    const own = tables[resource as keyof typeof tables]?.table;
    if (!own) return false;
    const column = (
      own as unknown as Record<string, typeof schema.contacts.id | undefined>
    )[field];
    if (!column) return false;
    const [row] = await db
      .select({ who: column })
      .from(own)
      .where(and(eq(own.id, id), eq(own.organizationId, orgId)))
      .limit(1);
    return row?.who === who;
  };

  const links: [
    unknown,
    typeof schema.companies | typeof schema.contacts | typeof schema.deals,
    string,
  ][] = [];
  if (resource === "contacts" || resource === "deals" || resource === "tasks") {
    if (value.companyId) {
      links.push([value.companyId, schema.companies, "no such company"]);
    }
  }
  if (resource === "tasks" || resource === "activities") {
    if (value.contactId) {
      links.push([value.contactId, schema.contacts, "no such contact"]);
    }
    if (value.dealId) links.push([value.dealId, schema.deals, "no such deal"]);
  }
  if (
    resource === "notes" &&
    (value.entityId !== undefined || value.entityType !== undefined)
  ) {
    // A note names the record it hangs from with a free pair of fields, and
    // an unverified pair is a note attached to another organisation's record
    // — which its detail screen would then show to strangers.
    const table = {
      contact: schema.contacts,
      company: schema.companies,
      deal: schema.deals,
    }[String(value.entityType)];
    if (!table) {
      return {
        error: "a note attaches to a contact, company or deal",
        status: 404,
      };
    }
    if (!(await owned(table, value.entityId))) {
      return { error: "no such record", status: 404 };
    }
  }
  if (resource === "deals" && Array.isArray(value.contactIds)) {
    // Filtered rather than refused: a deal being re-saved may still carry the
    // id of a contact deleted since, and losing that one id is right where
    // failing the whole save is not. What can never survive is an id from
    // another organisation.
    const kept: string[] = [];
    for (const id of value.contactIds) {
      if (await owned(schema.contacts, id)) kept.push(String(id));
    }
    value.contactIds = kept;
  }
  for (const [id, table, message] of links) {
    if (!(await owned(table, id))) return { error: message, status: 404 };
  }

  /**
   * And the person the record belongs to.
   *
   * `ownerId` on a contact, a company or a deal and `assigneeId` on a task are
   * platform user ids, and every one of them used to be written exactly as it
   * arrived. The `user` table has no `organization_id` — it cannot have one,
   * the same person may work at two businesses — so a stranger's id stored
   * here is a name from another business waiting to be printed on this one's
   * screen by whatever resolves it. The check has to happen on the way in.
   *
   * Refused, not quietly emptied. A missing letterhead has a correct default
   * and an owner does not: nobody means "give it to the person we do not
   * employ", so there is nothing to fall back to — and dropping it in silence
   * tells whoever pressed Save that the record was assigned when it was not.
   *
   * `null` is allowed through, because unassigning is a real thing to do.
   */
  for (const field of ["ownerId", "assigneeId"] as const) {
    const who = value[field];
    if (who === undefined || who === null || who === "") continue;
    if (await organizationMember(orgId, who)) continue;
    /*
     * Unless it is who the record already says.
     *
     * Somebody leaves, their membership goes, and every record they owned still
     * names them — which is right: a business that loses who ran an account when
     * that person leaves has lost its own history. But the check refused the id
     * on the way back in, so saving a phone number on one of those records
     * failed with "the owner is not a member of this organization" and the only
     * way to edit it at all was to give it away.
     *
     * Read from the row rather than taken from the body, so an id that is *new*
     * to this record — a stranger's, which is what this check exists for — is
     * still refused. Accepting one the row already carries changes nothing about
     * what is stored, and resolving it into a name is separately guarded: the
     * managers list is the only place a user id becomes a person here.
     */
    if (recordId && (await alreadyOn(recordId, field, who))) continue;
    return {
      error: `${field === "ownerId" ? "the owner" : "the assignee"} is not a member of this organization`,
      status: 400,
    };
  }
  return null;
}

const tables = {
  contacts: {
    table: schema.contacts,
    path: "contacts",
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
    /** What the list can be grouped by — the fields with a handful of values. */
    groupable: {
      status: schema.contacts.status,
      kind: schema.contacts.kind,
    },
    /**
     * A customer with financial history is not deletable.
     *
     * Their invoices would keep working but stop naming anyone, and the ledger
     * would still carry the money — the business would be left with revenue it
     * cannot attribute. Refusing is recoverable; deleting is not.
     *
     * **Every table that carries a `contactId`, not the two that were thought
     * of first.** This asked about invoices and quotes until 2026-09-28, while
     * `merge.ts` — the other end of the same problem — knew about nine. None of
     * those columns is a foreign key, so nothing in the database refused
     * either: a contact with a live subscription deleted cleanly and left the
     * scheduler raising invoices every month for a customer that no longer
     * exists. Bookkeeping entries, a payee and a contractor's 1099 details went
     * the same way, the last of them a record the IRS asks for by name.
     *
     * The four that are *not* here are deliberate: tasks, activities, form
     * submissions and notes are a record of dealing with somebody rather than
     * of money, and a business tidying up its contacts should not be stopped by
     * a note it wrote in March.
     */
    async blocksDelete(orgId: string, id: string) {
      /** This organization's rows of one table, pointing at this contact. */
      const mine = (
        table:
          | typeof schema.invoices
          | typeof schema.quotes
          | typeof schema.recurringProfiles
          | typeof schema.transactions
          | typeof schema.payees
          | typeof schema.contractorTaxDetails,
      ) => and(eq(table.organizationId, orgId), eq(table.contactId, id));

      const [invoices, quotes, recurring, entries, payees, taxDetails] =
        await Promise.all([
          db
            .select({ id: schema.invoices.id })
            .from(schema.invoices)
            .where(mine(schema.invoices)),
          db
            .select({ id: schema.quotes.id })
            .from(schema.quotes)
            .where(mine(schema.quotes)),
          // Read by kind: "2 subscriptions" and "2 recurring invoices" are
          // different things to the business, and the same row holds both.
          db
            .select({ kind: schema.recurringProfiles.kind })
            .from(schema.recurringProfiles)
            .where(mine(schema.recurringProfiles)),
          db
            .select({ id: schema.transactions.id })
            .from(schema.transactions)
            .where(mine(schema.transactions)),
          db
            .select({ id: schema.payees.id })
            .from(schema.payees)
            .where(mine(schema.payees)),
          db
            .select({ id: schema.contractorTaxDetails.id })
            .from(schema.contractorTaxDetails)
            .where(mine(schema.contractorTaxDetails)),
        ]);

      const subscriptions = recurring.filter(
        (r) => r.kind === "subscription",
      ).length;
      const schedules = recurring.length - subscriptions;

      /** "3 invoices", "1 quote" — the count and its noun agreeing. */
      const some = (n: number, one: string, many = `${one}s`) =>
        n ? `${n} ${n === 1 ? one : many}` : null;

      const parts = [
        some(invoices.length, "invoice"),
        some(quotes.length, "quote"),
        some(subscriptions, "subscription"),
        some(schedules, "recurring invoice"),
        some(entries.length, "bookkeeping entry", "bookkeeping entries"),
        some(payees.length, "payee record"),
        some(
          taxDetails.length,
          "set of contractor tax details",
          "sets of contractor tax details",
        ),
      ].filter((part): part is string => part !== null);

      if (!parts.length) return null;

      // "1 invoice … would leave those without a customer" is the plural
      // agreeing with nothing. One document is "it"; two or more, or one of
      // each kind, are "those".
      const total =
        invoices.length +
        quotes.length +
        recurring.length +
        entries.length +
        payees.length +
        taxDetails.length;
      const listed =
        parts.length > 1
          ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
          : parts[0];
      return `This customer has ${listed}. Deleting them would leave ${total > 1 ? "those" : "it"} without a customer.`;
    },
    /**
     * What the list row needs beyond the contact's own columns: its tags, and
     * how much is outstanding on it. The reference shows both on every row, and both
     * are the reason somebody picks one contact out of a page of them.
     */
    async enrich(rows: Record<string, unknown>[], orgId: string) {
      const ids = rows.map((row) => String(row.id));
      const [tags, tasks, employers] = await Promise.all([
        tagsFor(orgId, "contact", ids),
        openTaskCounts(orgId, ids),
        // Where they work, as a name. The list screen used to build this
        // lookup by fetching every company into the browser, which stops
        // being the whole table at a thousand rows and says so in a flag
        // nothing read — so past that, rows lost their company silently.
        companyNames(
          orgId,
          rows.map((row) => (row.companyId as string | null) ?? null),
        ),
      ]);
      return rows.map((row) => ({
        ...row,
        tags: tags.get(String(row.id)) ?? [],
        openTasks: tasks.get(String(row.id)) ?? 0,
        companyName: row.companyId
          ? (employers.get(String(row.companyId)) ?? null)
          : null,
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
        // Refused rather than ignored. An unreadable value used to reach the
        // driver as an Invalid Date, and an impossible day — 30 February —
        // moved the boundary two days without the list saying anything.
        query.lastSeenAfter
          ? gte(schema.contacts.lastSeenAt, demandDate(query.lastSeenAfter))
          : undefined,
        query.lastSeenBefore
          ? lte(schema.contacts.lastSeenAt, demandDate(query.lastSeenBefore))
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
    permission: "crm",
    /**
     * A company with people or deals on it is not deletable.
     *
     * The same rule contacts already follow, for the same reason: a contact
     * and a deal are records in their own right, nothing gives them back the
     * company they pointed at, and the detachment is silent. It is not only
     * cosmetic — the economic-nexus figures read a sale's buyer through the
     * contact's company, so a detached contact quietly takes its invoices out
     * of a tax threshold calculation.
     *
     * Refusing is recoverable: move the people, or delete them first.
     */
    async blocksDelete(orgId: string, id: string) {
      const [people, deals] = await Promise.all([
        db
          .select({ id: schema.contacts.id })
          .from(schema.contacts)
          .where(
            and(
              eq(schema.contacts.organizationId, orgId),
              eq(schema.contacts.companyId, id),
            ),
          ),
        db
          .select({ id: schema.deals.id })
          .from(schema.deals)
          .where(
            and(
              eq(schema.deals.organizationId, orgId),
              eq(schema.deals.companyId, id),
            ),
          ),
      ]);
      const parts: string[] = [];
      if (people.length) {
        parts.push(`${people.length} contact${people.length > 1 ? "s" : ""}`);
      }
      if (deals.length) {
        parts.push(`${deals.length} deal${deals.length > 1 ? "s" : ""}`);
      }
      return parts.length
        ? `This company has ${parts.join(" and ")} on it. Move or delete those first.`
        : null;
    },
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
    groupable: {
      sector: schema.companies.sector,
      city: schema.companies.city,
      size: schema.companies.size,
    },
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
    permission: "crm",
    /**
     * A page, newest first, because there is no other order to read what
     * happened in.
     *
     * It had no list spec at all, which in this route means every row: at
     * 150,084 activities that was a 40 MB response and three quarters of a
     * gigabyte of process memory to draw a panel that shows a handful. A
     * caller that still asks for no page now gets the most recent thousand
     * and is told it was cut, which is the shared behaviour every other list
     * here already has.
     */
    list: {
      search: [schema.activities.body],
      sortable: {
        occurredAt: schema.activities.occurredAt,
        type: schema.activities.type,
      },
      defaultSort: { field: "occurredAt", order: "desc" },
    } satisfies ListSpec,
    /**
     * Whose activity it is, asked of the database.
     *
     * An activity has one subject, and the panels that show "what happened
     * with this person" had no way to say so — so they either took the whole
     * table or took a page of somebody else's rows and sifted in the browser.
     */
    narrow(query: Record<string, string | undefined>) {
      return [
        query.contactId
          ? eq(schema.activities.contactId, query.contactId)
          : undefined,
        query.dealId ? eq(schema.activities.dealId, query.dealId) : undefined,
        query.type ? eq(schema.activities.type, query.type) : undefined,
      ];
    },
  },
  tasks: {
    table: schema.tasks,
    path: "tasks",
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
    permission: "crm",
  },
  deals: {
    table: schema.deals,
    path: "deals",
    permission: "crm",
    /**
     * Who the job is for. The board drew this from a lookup table it built by
     * fetching every company, which is capped at a thousand rows — so at a
     * larger business a card lost both its customer's name and the initials
     * on its avatar, which is the only thing on a card that says whose it is.
     */
    async enrich(rows: Record<string, unknown>[], orgId: string) {
      const customers = await companyMarks(
        orgId,
        rows.map((row) => (row.companyId as string | null) ?? null),
      );
      return rows.map((row) => {
        const customer = row.companyId
          ? customers.get(String(row.companyId))
          : undefined;
        return {
          ...row,
          companyName: customer?.name ?? null,
          // Whether to ask for the mark at all. Without it the board asked
          // for an image per card and took a 404 for every company that has
          // none, which is most of them.
          companyLogo: Boolean(customer?.logoPath),
        };
      });
    },
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
    groupable: {
      stage: schema.deals.stage,
      category: schema.deals.category,
    },
    /**
     * What each group is worth as well as how many it holds — the sum the
     * board prints at the top of every column. Coalesced because a group
     * with no rows never reaches SQL, but sum over an empty window is null,
     * not zero, and null cents is not a figure.
     */
    groupAggregates: {
      amountCents: sumCents(schema.deals.amountCents),
    },
    async narrow(
      query: Record<string, string | undefined>,
      session: SentrelloSession,
    ) {
      const orgId = activeOrganizationId(session);
      return [
        query.stage ? eq(schema.deals.stage, query.stage) : undefined,
        query.category ? eq(schema.deals.category, query.category) : undefined,
        // "Worth at least this much" — the half of "my open deals over five
        // thousand" that no other filter could say. In cents, like every
        // amount everywhere.
        query.minAmountCents && Number.isFinite(Number(query.minAmountCents))
          ? gte(schema.deals.amountCents, Number(query.minAmountCents))
          : undefined,
        // Archived deals are the history, and the board is about now. They
        // come back only when asked for by name.
        query.archived === "1"
          ? isNotNull(schema.deals.archivedAt)
          : query.archived === "any"
            ? undefined
            : isNull(schema.deals.archivedAt),
        /*
         * "The ones whose close date has gone", which the CRM dashboard counts
         * and nothing could list.
         *
         * That panel says "four deals past the date they were meant to close"
         * and its button opened the whole board, leaving somebody to find those
         * four by reading every card. A figure with no way to the rows behind it
         * is this product's most reliable bug, and this is the most actionable
         * figure on that screen.
         *
         * Compared as days, in the business's own timezone, exactly as the
         * dashboard does it: an instant comparison marks a deal expected to
         * close today as late from one second past midnight.
         */
        query.overdue === "1"
          ? and(
              isNotNull(schema.deals.expectedCloseOn),
              /*
               * Compared as a date string, because that is what the column is.
               * `expectedCloseOn` is a `date` and holds `2026-09-30`, so the
               * day the business is having has to be written the same way —
               * handing it a `Date` compares a date with an instant, which is
               * the one thing this product has a guard against.
               */
              lt(
                schema.deals.expectedCloseOn,
                dayIn(new Date(), await timezoneFor(orgId))
                  .toISOString()
                  .slice(0, 10),
              ),
            )
          : undefined,
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
    permission: "crm",
    /**
     * The same, for the same reason. Notes were never measured because
     * nothing in the browser reads this route directly — the timeline asks
     * for a contact's, in one query, with a limit — but the route is there,
     * it is reachable, and it had the same "every row, unordered" behaviour
     * the activities list did.
     */
    list: {
      search: [schema.notes.text],
      sortable: { createdAt: schema.notes.createdAt },
      defaultSort: { field: "createdAt", order: "desc" },
    } satisfies ListSpec,
    narrow(query: Record<string, string | undefined>) {
      return [
        query.entityType
          ? eq(schema.notes.entityType, query.entityType)
          : undefined,
        query.entityId ? eq(schema.notes.entityId, query.entityId) : undefined,
      ];
    },
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

  // In chunks, because this binds one parameter per id and the wire protocol
  // counts them in a signed 16-bit field. It is the query that killed the
  // unpaged contact list, and it failed before the database saw it.
  const rows = await inChunks(ids, (chunk) =>
    db
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
          inArray(schema.taggables.entityId, chunk),
        ),
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

  const rows = await inChunks(contactIds, (chunk) =>
    db
      .select({ contactId: schema.tasks.contactId, total: countExpression })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.organizationId, orgId),
          eq(schema.tasks.done, false),
          inArray(schema.tasks.contactId, chunk),
        ),
      )
      .groupBy(schema.tasks.contactId),
  );

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
  /**
   * Carried into the file, because the file is where the obligation gets lost.
   *
   * A contact export is the moment a customer list becomes something a person
   * can hand to somebody else — an agency, a mailing tool, a spreadsheet that
   * ends up somewhere. Somebody who has asked not to have their information
   * sold or shared has to be identifiable *in that file*, or the choice was
   * recorded and then quietly dropped at the one point it mattered.
   *
   * Marked rather than removed. Silently dropping rows from an export makes a
   * business believe it has a complete list when it does not, and they need
   * the row for their own purposes — it is the *sharing* the person objected
   * to, not the business knowing who they are.
   */
  "Do not sell or share",
  /**
   * And when they said so.
   *
   * The flag alone answers "may we share this row"; the date answers "since
   * when", which is the question a regulator asks and the one a business
   * cannot reconstruct from a spreadsheet. It is recorded the moment the
   * choice is made and was then dropped at the one point the record leaves
   * the product — the published page has said it is carried into every
   * contact export since before it was.
   */
  "Do not sell recorded on",
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

  const parts = asText(body.name, "name").trim().split(/\s+/).filter(Boolean);
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

      /*
       * Every cell read as text rather than trusted to be text.
       *
       * The type above says `Record<string, string>`, which is a claim about
       * what a caller sends and not a check on it. A cell of `{}` met `.trim()`
       * and threw: a 500 and "something went wrong" for a spreadsheet with one
       * odd cell in it, where the honest answer names the column.
       */
      for (const [index, raw] of rows.entries()) {
        const firstName = asText(raw.firstName, "firstName").trim();
        const lastName = asText(raw.lastName, "lastName").trim();
        const name = [firstName, lastName].filter(Boolean).join(" ");
        if (!name) {
          // Nameless rows are the blank lines at the bottom of every
          // spreadsheet. Reported rather than silently dropped.
          skipped.push({ row: index + 2, why: "no name" });
          continue;
        }

        let companyId: string | null = null;
        const companyName = asText(raw.company, "company").trim();
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

        /*
         * An opt-out carried in, because losing one is not a tidy failure.
         *
         * `doNotSell` is a CCPA opt-out, and the export writes it along with the
         * day it was made. The importer had no field for either, so a business
         * moving its contacts between instances — a self-host changing servers,
         * or a business splitting in two — brought every record across with
         * nobody opted out, and then sold or shared their data. `merge.ts` is
         * careful about exactly this and keeps the stricter of two records; the
         * asymmetry between the two paths is what gave it away.
         *
         * Only ever restricting. An import can set an opt-out and can never
         * clear one, which is why no `false` is honoured here: a blank cell is a
         * spreadsheet nobody filled in, not consent.
         */
        const optOut = /^(1|y|yes|true|do not sell)/i.test(
          asText(raw.doNotSell, "doNotSell").trim(),
        );
        /*
         * And the day it was made, which is a day. `doNotSellOn` stands for a
         * whole date and is stored at midnight UTC, so it comes through
         * `dayFrom` rather than `new Date` — and falls back to today, because an
         * opt-out with no date is still an opt-out.
         */
        const optOutOn = optOut
          ? (dayFrom(asText(raw.doNotSellOn, "doNotSellOn").trim()) ??
            dayIn(new Date(), await timezoneFor(orgId)))
          : null;

        await db.insert(schema.contacts).values({
          organizationId: orgId,
          name,
          firstName: firstName || null,
          lastName: lastName || null,
          title: asText(raw.title, "title").trim() || null,
          email: asText(raw.email, "email").trim() || null,
          phone: asText(raw.phone, "phone").trim() || null,
          linkedinUrl: asText(raw.linkedinUrl, "linkedinUrl").trim() || null,
          companyId,
          ...(optOut ? { doNotSell: true, doNotSellOn: optOutOn } : {}),
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
          // Words rather than a boolean: this row is read by a person deciding
          // what to do with the file, and "true" in a column is easy to miss.
          r.doNotSell ? "DO NOT SELL OR SHARE" : "",
          // The day, not the instant. A spreadsheet column of timestamps to
          // the millisecond is a column nobody reads, and the obligation is
          // dated in days.
          r.doNotSellOn ? r.doNotSellOn.toISOString().slice(0, 10) : "",
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

      /*
       * And it has to be a stage this business actually has.
       *
       * This validated the name against nothing. A deal moved into a stage
       * that is not on the board disappears from it — the card is drawn per
       * stage — while the row sits in the database in a stage nobody can
       * see or move it out of. The settings route already guards the
       * opposite direction and refuses to delete a stage holding deals, so
       * this was the one way round an existing rule.
       *
       * Found on 2026-09-27 behind the record page, which offered the five
       * stages we ship with rather than the business's own.
       */
      if (stage) {
        const [settings] = await db
          .select({ dealStages: schema.crmSettings.dealStages })
          .from(schema.crmSettings)
          .where(eq(schema.crmSettings.organizationId, orgId))
          .limit(1);
        const allowed = (settings?.dealStages ?? DEFAULT_STAGES) as {
          id: string;
        }[];
        if (!allowed.some((s) => s.id === stage)) {
          return c.json(
            {
              error: `there is no stage called "${stage}" on this board — it is one of ${allowed.map((s) => s.id).join(", ")}`,
            },
            400,
          );
        }
      }

      /*
       * What it was, so a rule can ask about the change rather than the state.
       * "When the stage becomes won" is a different question from "when the
       * stage is won", which is true every time anything else is edited after.
       */
      const [before] = await db
        .select()
        .from(schema.deals)
        .where(
          and(
            eq(schema.deals.id, c.req.param("id")),
            eq(schema.deals.organizationId, orgId),
          ),
        )
        .limit(1);

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
      /*
       * The canonical automation trigger, and the one route that writes a deal
       * without going through the factory: dragging a card is a stage change,
       * and "when a deal is won" is the first rule anybody writes.
       */
      await announce(orgId, "deals", row, "updated", before, row);
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
        notes: await withAuthors(notes),
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

      return c.json({
        company,
        contacts: people,
        deals,
        notes: await withAuthors(notes),
        tasks,
      });
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
        notes: await withAuthors(notes),
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

/**
 * What the CRM can find, for the box that searches everything.
 *
 * Contacts, companies and deals — the three things somebody half-remembers the
 * name of. Deals are searched by the company and the contact as well as by
 * their own name, because a deal's own name is the least memorable thing about
 * it: people say "the Henderson job", meaning whoever it is for.
 */
function registerCrmSearch(ctx: ModuleContext) {
  ctx.registerSearch({
    requires: { crm: ["read"] },
    find: async ({ organizationId, q, limit }) => {
      const term = `%${q.replace(/[\\%_]/g, (ch: string) => `\\${ch}`)}%`;
      const hits: SearchHit[] = [];

      const people = await db
        .select()
        .from(schema.contacts)
        .where(
          and(
            eq(schema.contacts.organizationId, organizationId),
            or(
              ilike(schema.contacts.name, term),
              ilike(schema.contacts.email, term),
              ilike(schema.contacts.phone, term),
            ),
          ),
        )
        .limit(limit);
      for (const person of people) {
        hits.push({
          kind: "Contact",
          title: person.name ?? person.email ?? "Somebody",
          subtitle: person.email ?? person.phone,
          opens: { moduleId: "contacts", recordId: person.id },
          score: scoreFor(q, person.name ?? person.email ?? ""),
        });
      }

      const firms = await db
        .select()
        .from(schema.companies)
        .where(
          and(
            eq(schema.companies.organizationId, organizationId),
            ilike(schema.companies.name, term),
          ),
        )
        .limit(limit);
      for (const firm of firms) {
        hits.push({
          kind: "Company",
          title: firm.name,
          subtitle: firm.website ?? null,
          opens: { moduleId: "companies", recordId: firm.id },
          score: scoreFor(q, firm.name),
        });
      }

      const where = await dealSearch(organizationId, q);
      if (where) {
        const deals = await db
          .select()
          .from(schema.deals)
          .where(and(eq(schema.deals.organizationId, organizationId), where))
          .limit(limit);
        for (const deal of deals) {
          hits.push({
            kind: "Deal",
            title: deal.name,
            subtitle: deal.stage,
            opens: { moduleId: "deals", recordId: deal.id },
            score: scoreFor(q, deal.name),
          });
        }
      }

      return hits;
    },
  });
}

export default defineModule({
  id: "crm",
  tier: "free",
  register(ctx) {
    /*
     * How much a stranger may post, on the two doors this module opens.
     *
     * The form checked `content-length` and nothing else, which is a claim by
     * the sender and absent altogether on a chunked request — so the one public
     * endpoint here that *had* a limit could be walked straight past by not
     * declaring a length. This counts the stream when there is no length to
     * read, and the number is the module's own: one attachment plus the fields
     * around it.
     *
     * Inbound mail is the other, and it is a different size by nature: a
     * provider posts the whole message, attachments included.
     */
    ctx.app.use("/api/embed/forms/*", publicBodyLimit(MAX_UPLOAD_BODY_BYTES));
    ctx.app.use(
      "/api/crm/inbound-email/*",
      publicBodyLimit(MAX_INBOUND_ATTACHMENT + 1024 * 1024),
    );

    registerCrmPersonalData(ctx);
    // How long the change feed is kept, and what is left of it. Beside the
    // erasure above because the two empty the same two columns and must not
    // drift.
    registerCrmRetention(ctx);
    registerCrmSearch(ctx);
    registerVies(ctx);

    /**
     * The CRM, as one thing with five pages under it.
     *
     * It used to register three siblings straight into the section, which put
     * Contacts, Companies and Deals at the same level as Invoices and the Shop
     * — five equal items saying nothing about which belong together. The
     * parent is not a screen: opening it opens its dashboard.
     */
    /**
     * What has to exist before the CRM is doing anything for you.
     *
     * A CRM arrives empty and every screen in it works perfectly on nothing,
     * which is the worst possible first impression: a pipeline board with no
     * cards looks like a product that does not do much. These are the three
     * things that turn it into the book of customers, in the order somebody
     * would do them.
     *
     * Contacts are deliberately not a step. The invoicing guide already asks
     * for one — its second step is "add somebody to invoice" — and two
     * checklists on the same dashboard asking for the same row is a list
     * people stop reading.
     *
     * Each step asks the data, so a business importing a spreadsheet on day
     * one sees all three done before it has read them.
     */
    ctx.registerOnboarding({
      id: "crm",
      label: "Your customers",
      icon: "contact-round",
      requires: { crm: ["read"] },
      steps: [
        {
          id: "first-company",
          label: "Add the business you sell to",
          detail:
            "People move between companies and the work stays with the company. Putting one in first is what keeps a history when somebody leaves.",
          opens: "companies",
          done: async (orgId) => {
            const [row] = await db
              .select({ id: schema.companies.id })
              .from(schema.companies)
              .where(eq(schema.companies.organizationId, orgId))
              .limit(1);
            return Boolean(row);
          },
        },
        {
          id: "first-deal",
          label: "Put a deal on the board",
          detail:
            "What you are hoping to win, and what stage it is at. A quote raised against it carries straight through to an invoice.",
          opens: "deals",
          done: async (orgId) => {
            const [row] = await db
              .select({ id: schema.deals.id })
              .from(schema.deals)
              .where(eq(schema.deals.organizationId, orgId))
              .limit(1);
            return Boolean(row);
          },
        },
        {
          id: "first-form",
          label: "Let a form fill it in for you",
          detail:
            "One tag on your own website, and an enquiry arrives as a contact rather than as an email somebody has to retype.",
          opens: "forms",
          done: async (orgId) => {
            const [row] = await db
              .select({ id: schema.forms.id })
              .from(schema.forms)
              .where(eq(schema.forms.organizationId, orgId))
              .limit(1);
            return Boolean(row);
          },
        },
      ],
    });

    registerCrmSummary(ctx);

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
      section: "Records",
      icon: "user",
      requires: { crm: ["read"] },
    });
    ctx.registerNav({
      id: "companies",
      label: "Companies",
      order: 3,
      parent: "crm",
      section: "Records",
      icon: "building",
      requires: { crm: ["read"] },
    });
    // The pipeline. Named Deals as the reference has it.
    ctx.registerNav({
      id: "deals",
      label: "Deals",
      order: 4,
      parent: "crm",
      section: "Records",
      icon: "trending-up",
      requires: { crm: ["read"] },
    });
    ctx.registerNav({
      id: "crm-settings",
      label: "Settings",
      /*
       * Last, under its own heading.
       *
       * It was 5, which put it between the deals and the Pro half's notes,
       * mailbox and automations — in the middle of the module, above things a
       * person uses every day. Settings are settings: they go at the bottom.
       */
      order: 9,
      parent: "crm",
      section: "Settings",
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
    registerWebhooks(ctx);
    registerSavedViews(ctx);
    registerMerge(ctx);
  },
});
