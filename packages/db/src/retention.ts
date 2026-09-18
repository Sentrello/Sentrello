import type {
  RegisteredRetention,
  RetentionPayload,
  RetentionWindow,
} from "@sentrello/module-sdk";
import {
  declareClassification,
  retentionPolicies,
  retentionTableName,
} from "@sentrello/module-sdk";
import { type SQL, inArray, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { db } from "./client";
import { type Payload, emptied } from "./erasure";
import * as schema from "./schema";

/**
 * The sweep behind `ctx.registerRetention`.
 *
 * Everything a module would otherwise write for itself and get subtly wrong:
 * batching so a first sweep on a two-year-old instance does not lock the table
 * it is housekeeping, a wall-clock budget so a backlog of millions clears over
 * a night or two instead of in one enormous statement, the loop over every
 * organisation, isolation so one module's bad policy cannot cost another its
 * night, the count of what is still owed, and saying so out loud.
 *
 * **No cursor, anywhere.** Every predicate here is the complement of what the
 * sweep writes: a row it has already done no longer matches, and a row it has
 * not still does. Interrupted by a power cut half way through a batch, the
 * next run carries on from exactly where it stopped, repeating nothing and
 * missing nothing.
 *
 * **It empties with the same function the erasure empties with.** A sweep that
 * wrote a *slightly* different empty would either put an erased person back —
 * a privacy incident — or re-empty every already-erased row nightly for ever
 * and report work it did not do. `emptied` lives in `erasure.ts` and both call
 * it, so there is nothing to drift.
 */

/**
 * Every other table in this schema, looked at once and found not to be
 * evidence of money.
 *
 * The pair of this and `STATUTORY_TABLES` has to cover the schema, and the
 * ratchet beside it fails when a table is in neither. That is the whole
 * point: a column-name test cannot tell a record of a sale from a settings
 * row — four tables recording what customers bought slipped past one, because
 * none of them carries an amount — so the decision is made by a person, and
 * the thing that is now impossible is making it by accident. A new table
 * fails the suite until somebody says which half it belongs to.
 *
 * Being here is not permission to sweep anything. Most of these are live
 * business records that no retention policy has any business touching either;
 * it says only that losing one would not stop a business answering an
 * auditor. The logs among them — `record_events`, `security_events`,
 * `crm_webhook_deliveries`, `reminder_log`, `payment_webhook_events`,
 * `archive_runs` — are the ones a policy is actually written against.
 *
 * Core's schema only. A module in another repository keeps its own list
 * against its own schema; what protects the shared names across the boundary
 * is `STATUTORY_TABLES`, which matches by name.
 */
export const NON_STATUTORY_TABLES = [
  "account",
  "activities",
  "archive_runs",
  "bank_connections",
  "bank_provider_accounts",
  "companies",
  "compliance_settings",
  "consent_records",
  "contact_duplicate_dismissals",
  "contact_merges",
  "contacts",
  "crm_settings",
  "crm_webhook_deliveries",
  "crm_webhooks",
  "dimensions",
  "document_templates",
  "form_submissions",
  "forms",
  "invitation",
  "invoicing_settings",
  "ledger_settings",
  "license_cache",
  "member",
  "module_state",
  "mtd_connections",
  "notes",
  "onboarding_dismissals",
  "organization_preferences",
  "organization_role",
  "organizations",
  "payees",
  "payment_accounts",
  "payment_webhook_events",
  "record_events",
  "reminder_log",
  "reminder_rules",
  "saved_views",
  "security_events",
  "security_policy",
  "session",
  "sso_provider",
  "taggables",
  "tags",
  "tasks",
  "two_factor",
  "user",
  "user_group_members",
  "user_groups",
  "user_preferences",
  "verification",
] as const;

/**
 * Core's half of the ratchet, declared when the schema loads rather than when
 * a test runs.
 *
 * `classifySchema` only ever held where somebody remembered to call it, which
 * made the guarantee "protected where we remembered". Declaring it here makes
 * it a property of the running instance: every table in this schema is placed
 * before any module registers a retention policy, and `addRetention` refuses a
 * policy pointed at a table nobody has placed. Core's suite still asserts the
 * gaps are empty — the declaration returns them — but a repository that skips
 * the declaration entirely no longer looks the same as one that passed it.
 *
 * `Pro` and `Modules` each need one line like this beside their own schema.
 */
declareClassification(schema, NON_STATUTORY_TABLES);

/**
 * Rows touched by one statement.
 *
 * One `delete` over two years of a busy log takes a row lock on every row and
 * holds it for the length of the transaction, which on a small box is the
 * application blocking behind the job that was supposed to be housekeeping.
 * Five hundred is the number the trash purge already uses.
 */
const BATCH = 500;

/**
 * How long one night's sweep may spend before leaving the rest for tomorrow.
 *
 * A batch without a budget is a backlog that never clears; a budget without a
 * batch is one enormous statement. Both, and a backlog of millions comes down
 * over a night or two in bounded steps while a healthy instance finds nothing
 * and stops in milliseconds. Shared across every organisation and every
 * policy rather than given to each, so a hundred organisations cannot turn a
 * one-minute job into a one-hour one.
 */
const BUDGET_MS = 60_000;

const DAY_MS = 24 * 60 * 60 * 1000;

const cutoff = (days: number) => new Date(Date.now() - days * DAY_MS);

/** The SDK's structural types are these, at the only place it matters. */
const asPayload = (payload: RetentionPayload): Payload =>
  payload as unknown as Payload;
const asColumn = (payload: Payload): PgColumn =>
  "column" in payload ? payload.column : payload;

/**
 * Old enough to act on, finished, and not one of the few a policy spares.
 *
 * `clock is not null` is what keeps live state out of reach: a run still
 * waiting on an approval, an event nothing has dispatched yet. Deleting live
 * state to save disk is a worse failure than the disk. A log whose clock is
 * never null — a plain `at` on something that already happened — simply has
 * every row eligible once it is old enough, which is the right reading.
 */
function due(
  policy: RegisteredRetention,
  organizationId: string,
  before: Date,
): SQL {
  const clock = sql.identifier(policy.clock.name);
  const org = sql.identifier(policy.table.organizationId.name);
  const spared = policy.keep
    ? sql` and not (${policy.keep as unknown as SQL})`
    : sql``;
  return sql`${org} = ${organizationId}
    and ${clock} is not null
    and ${clock} < ${before.toISOString()}::timestamp${spared}`;
}

/**
 * Does this row still hold a payload?
 *
 * The complement of what `emptied` writes, column by column, which is what
 * makes the emptying half resumable and idempotent. The keyed form tests
 * `jsonb_typeof(value) <> 'null'` rather than `is not null`: a key an erasure
 * has already emptied holds JSON null, which is a value, and `is not null`
 * would call it full — re-emptying every erased row every night for ever and
 * reporting work it did not do.
 */
function holdsPayload(payloads: RetentionPayload[]): SQL {
  const tests = payloads.map((raw) => {
    const payload = asPayload(raw);
    const name = sql.identifier(asColumn(payload).name);
    if (!("column" in payload)) {
      return asColumn(payload).notNull
        ? sql`${name} <> '{}'::jsonb`
        : sql`${name} is not null`;
    }
    return sql`exists (
      select 1 from jsonb_each(coalesce(${name}, '{}'::jsonb)) as pair(key, value)
      where pair.key in (${sql.join(
        payload.keys.map((key) => sql`${key}`),
        sql`, `,
      )})
        and jsonb_typeof(pair.value) <> 'null'
    )`;
  });
  return sql`(${sql.join(tests, sql` or `)})`;
}

/** The ids of one batch to work on, oldest first. */
async function nextBatch(
  policy: RegisteredRetention,
  where: SQL,
  batch: number,
): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    select ${sql.identifier(policy.table.id.name)} as id
    from ${policy.table as unknown as PgTable}
    where ${where}
    order by ${sql.identifier(policy.clock.name)} asc
    limit ${batch}
  `);
  return rows.map((row) => row.id);
}

export interface SweepResult {
  /** Rows whose payloads came out, the row itself left standing. */
  emptied: number;
  /** Rows removed entirely. */
  removed: number;
  /** Rows a policy's `cascade` dealt with alongside. */
  cascaded: number;
  /** Still outside the window when this sweep gave up its budget. */
  backlog: number;
}

const nothing = (): SweepResult => ({
  emptied: 0,
  removed: 0,
  cascaded: 0,
  backlog: 0,
});

/**
 * One policy, one organisation, brought within what that organisation keeps.
 *
 * Scoped on every statement, never on the loop that calls it: retention
 * reaching another organisation's rows is the worst thing in this file, and it
 * is guarded where the rows are rather than where the list of organisations
 * is.
 *
 * Removing before emptying, so a row past both horizons is one delete rather
 * than an update and then a delete of what was just updated.
 */
export async function sweepRetention(
  policy: RegisteredRetention,
  organizationId: string,
  options: {
    /** When this sweep must stop, whatever is left. */
    deadline?: number;
    /**
     * Rows per statement. The default is the whole point of the facility and
     * is not a knob any caller should turn; it is here so a test can prove
     * what happens across batch boundaries without writing five hundred rows.
     */
    batch?: number;
  } = {},
): Promise<SweepResult> {
  const deadline = options.deadline ?? Date.now() + BUDGET_MS;
  const batch = options.batch ?? BATCH;
  const window = await policy.window(organizationId);
  const result = nothing();
  const table = policy.table as unknown as PgTable;
  const id = policy.table.id as unknown as PgColumn;
  const org = sql.identifier(policy.table.organizationId.name);

  // Zero, or absent, is off: an instance under a legal hold is entitled to
  // keep everything for ever, and so is one that simply never asked.
  if (window.removeAfterDays) {
    const before = cutoff(window.removeAfterDays);
    while (Date.now() < deadline) {
      const ids = await nextBatch(
        policy,
        due(policy, organizationId, before),
        batch,
      );
      if (!ids.length) break;
      if (policy.cascade) {
        result.cascaded += await policy.cascade(ids, organizationId, "remove");
      }
      const gone = await db.execute(sql`
        delete from ${table}
        where ${org} = ${organizationId} and ${inArray(id, ids)}
        returning 1
      `);
      result.removed += gone.length;
    }
  }

  const payloads = policy.payloads ?? [];
  if (window.emptyAfterDays && payloads.length) {
    const before = cutoff(window.emptyAfterDays);
    const holds = holdsPayload(payloads);
    while (Date.now() < deadline) {
      const ids = await nextBatch(
        policy,
        sql`${due(policy, organizationId, before)} and ${holds}`,
        batch,
      );
      if (!ids.length) break;
      if (policy.cascade) {
        result.cascaded += await policy.cascade(ids, organizationId, "empty");
      }
      const sets = payloads.map((raw) => {
        const payload = asPayload(raw);
        return sql`${sql.identifier(asColumn(payload).name)} = ${emptied(payload)}`;
      });
      const done = await db.execute(sql`
        update ${table} set ${sql.join(sets, sql`, `)}
        where ${org} = ${organizationId} and ${inArray(id, ids)}
        returning 1
      `);
      result.emptied += done.length;
    }
  }

  result.backlog = await retentionBacklog(policy, organizationId, window);
  return result;
}

/**
 * What is still outside the window.
 *
 * Zero is the healthy answer. A number that falls over a night or two is a
 * window somebody shortened; a number that sits there is the job not running,
 * and that is the difference worth being able to see.
 */
export async function retentionBacklog(
  policy: RegisteredRetention,
  organizationId: string,
  window?: RetentionWindow,
): Promise<number> {
  const keep = window ?? (await policy.window(organizationId));
  const payloads = policy.payloads ?? [];
  const tests = [
    keep.removeAfterDays
      ? sql`(${due(policy, organizationId, cutoff(keep.removeAfterDays))})`
      : null,
    keep.emptyAfterDays && payloads.length
      ? sql`(${due(policy, organizationId, cutoff(keep.emptyAfterDays))} and ${holdsPayload(payloads)})`
      : null,
  ].filter((test): test is SQL => test !== null);
  if (!tests.length) return 0;

  const [row] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n
    from ${policy.table as unknown as PgTable}
    where (${sql.join(tests, sql` or `)})
  `);
  return row?.n ?? 0;
}

export interface RetentionReport extends SweepResult {
  /** When this sweep ran, so a job that has stopped is visible as a stale one. */
  at: string;
  /** Per policy, for a screen or a log line that has to name one. */
  policies: (SweepResult & { id: string; label: string; table: string })[];
  /** What threw, and where. Never empty silently. */
  failed: { policy: string; organizationId: string; error: string }[];
}

let last: RetentionReport | null = null;

/** The last sweep this process ran, for `/healthz`. Null until one has. */
export function lastRetentionSweep(): RetentionReport | null {
  return last;
}

/** For tests, which boot and sweep more than once in a process. */
export function forgetRetentionSweep(): void {
  last = null;
}

/**
 * Every registered policy, over every organisation on this instance.
 *
 * Isolated per policy per organisation. pg-boss marks a whole job failed on a
 * throw and waits for tomorrow, so one module's bad policy escaping here is
 * every other module's table quietly never being swept again — which is the
 * exact failure this facility exists to prevent.
 */
export async function sweepAllRetention(
  policies: RegisteredRetention[] = retentionPolicies(),
): Promise<RetentionReport> {
  const deadline = Date.now() + BUDGET_MS;
  const report: RetentionReport = {
    ...nothing(),
    at: new Date().toISOString(),
    policies: [],
    failed: [],
  };
  if (!policies.length) {
    last = report;
    return report;
  }

  const orgs = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations);

  for (const policy of policies) {
    const totals = {
      ...nothing(),
      id: policy.id,
      label: policy.label,
      table: retentionTableName(policy.table),
    };
    for (const org of orgs) {
      try {
        const one = await sweepRetention(policy, org.id, { deadline });
        totals.emptied += one.emptied;
        totals.removed += one.removed;
        totals.cascaded += one.cascaded;
        totals.backlog += one.backlog;
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        report.failed.push({
          policy: policy.id,
          organizationId: org.id,
          error: why,
        });
        console.error(
          `[retention] ${policy.id} could not sweep ${totals.table} for ${org.id}`,
          error,
        );
      }
    }
    report.policies.push(totals);
    report.emptied += totals.emptied;
    report.removed += totals.removed;
    report.cascaded += totals.cascaded;
    report.backlog += totals.backlog;
  }

  /*
   * Said out loud, because a sweep that has stopped is invisible everywhere
   * else until the disk is full. A backlog on the night a business shortens a
   * window is expected and clears; one still there a week later is the job not
   * running, and that is the sentence somebody needs to have seen.
   */
  if (report.backlog) {
    console.error(
      `[retention] ${report.backlog} rows are past their retention window and are still here: ${report.policies
        .filter((p) => p.backlog)
        .map((p) => `${p.table} ${p.backlog}`)
        .join(", ")}`,
    );
  }
  last = report;
  return report;
}
