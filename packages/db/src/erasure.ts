import type { DataSubject } from "@sentrello/module-sdk";
import { type SQL, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { db } from "./client";

/**
 * Taking a person out of the logs a business has to keep.
 *
 * Erasing somebody is easy where their record is the only copy. The hard half
 * is everywhere the platform wrote a *copy* of that record down in passing: the
 * change feed, the webhook delivery log, a merge's record of what was folded
 * in, and — the one that started this — the workflow run logs, which keep the
 * record a run was working on so "why did this customer get that email in
 * March" can be answered in March's terms.
 *
 * Those logs cannot simply be deleted. A business needs to know *that* a run
 * happened, that a delivery was attempted six times and abandoned, that two
 * contacts were merged on a Tuesday. So the row stays and the shape stays; only
 * the person comes out, and what is left is a legible operational record with
 * nothing in it that is about anybody.
 *
 * **It is one function on purpose.** The alternative was each module writing
 * its own jsonb-poking SQL, which is how two stores end up erasing to two
 * different standards and the privacy screen reports both as done. A module
 * outside this repository — the workflow engine above all — calls this rather
 * than writing its own, so every log in the product forgets a person the same
 * way.
 */

/**
 * A payload to take somebody out of.
 *
 * A bare column is emptied whole: `null`, or `{}` where the column may not be
 * null, so the row and its shape survive. A column with `keys` keeps everything
 * except those keys, which are set to `null` — the key stays visible and empty,
 * which reads as "there was something here and it is gone" rather than as a log
 * that never had it.
 */
export type Payload = PgColumn | { column: PgColumn; keys: string[] };

/**
 * Does this payload mention the person anywhere inside it?
 *
 * Every string at any depth, compared against the ways a business knows them.
 * Not the key names — the values. A run's context nests the record under
 * `record`, a change feed row keys it `before`, an activity names the person as
 * `contactId` and a note as `entityId`, and a rule written against key names
 * would have to know all four and would be wrong about the fifth.
 *
 * It errs wide: a log that merely *refers* to the erased person by id is
 * redacted too. That is the right direction to be wrong in — the reference is
 * to them — and it never leaves the organization, because the caller's
 * `organizationId` is on the same `where`.
 *
 * Exported because a caller sometimes has to read the matching rows *before*
 * emptying them: the CRM answers an erasure for somebody it deleted last week
 * by taking their internal id back off the change feed, and a second hand-
 * written version of this test is how two stores come to disagree about whose
 * row is whose. The one written here is the one that runs.
 */
export function mentionsSubject(
  columns: PgColumn[],
  subject: DataSubject,
): SQL | undefined {
  const values = [subject.id, subject.email, subject.phone, subject.address]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  if (!values.length || !columns.length) return undefined;

  const tests = columns.flatMap((column) =>
    values.map(
      (value) =>
        sql`exists (
          select 1
          from jsonb_path_query(coalesce(${sql.identifier(column.name)}, '{}'::jsonb), '$.**'::jsonpath) as node
          where jsonb_typeof(node) = 'string'
            and lower(node #>> '{}') = lower(${value})
        )`,
    ),
  );
  return sql`(${sql.join(tests, sql` or `)})`;
}

/**
 * What one column looks like once the person is out of it.
 *
 * Exported because the retention sweep writes exactly this, by calling this.
 * Two functions spelling out what an empty payload is would agree for a
 * fortnight, and the night they drifted the sweep would either re-empty every
 * erased row for ever or put a person back.
 */
export function emptied(payload: Payload): SQL {
  const column = "column" in payload ? payload.column : payload;
  const name = sql.identifier(column.name);
  if (!("column" in payload)) {
    return column.notNull ? sql`'{}'::jsonb` : sql`null`;
  }
  let expression: SQL = sql`${name}`;
  for (const key of payload.keys) {
    // `false` for create_missing: a key the payload never had is not invented,
    // so a log that carried nothing about anybody comes out byte for byte.
    expression = sql`jsonb_set(${expression}, ${`{${key}}`}, 'null'::jsonb, false)`;
  }
  return expression;
}

/**
 * Empty a person out of one table's payloads, leaving the rows standing.
 *
 * Returns how many rows were changed, which is what a module reports back to
 * the privacy screen: "nothing was found" and "four run logs were cleared" are
 * different answers and a data subject is entitled to the real one.
 *
 * The table must carry `organizationId` — a type error rather than a review
 * comment, because an erasure that reached another organization's rows would
 * be the worst bug this file could have.
 */
export async function redactPayloads(request: {
  table: PgTable & { organizationId: PgColumn };
  organizationId: string;
  subject: DataSubject;
  payloads: Payload[];
}): Promise<number> {
  const { table, organizationId, subject, payloads } = request;
  const columns = payloads.map((p) => ("column" in p ? p.column : p));
  const match = mentionsSubject(columns, subject);
  // Nothing to go on is not an erasure of everything. A caller that knows
  // nothing about the person changes nothing.
  if (!match) return 0;

  const sets = payloads.map((payload) => {
    const column = "column" in payload ? payload.column : payload;
    return sql`${sql.identifier(column.name)} = ${emptied(payload)}`;
  });

  const rows = await db.execute(sql`
    update ${table}
    set ${sql.join(sets, sql`, `)}
    where ${sql.identifier(table.organizationId.name)} = ${organizationId}
      and ${match}
    returning 1
  `);
  return rows.length;
}
