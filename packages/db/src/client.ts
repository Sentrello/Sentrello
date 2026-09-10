import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { dbSsl } from "./ssl";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

/**
 * How many connections this instance may hold.
 *
 * Ten suits a business with its own database and nothing else on it, which is
 * what a self-hosted instance is. It does not suit several instances sharing
 * one small managed cluster — three of them at ten apiece is thirty against a
 * ceiling of twenty-five, and the symptom is not a slow query but
 * `remaining connection slots are reserved`: the site stays up on the pool it
 * already holds while every *new* connection is refused, so backups and
 * migrations fail and nothing on the dashboard says why.
 *
 * Two is the floor because one connection plus a transaction is a deadlock
 * waiting for itself.
 *
 * **The arithmetic to do before changing it.** The application pool is not the
 * only thing holding connections: the job runner keeps its own
 * (`SENTRELLO_JOBS_POOL`), a managed platform runs an agent and a scheduler on
 * one or two more, and a backup or a migration needs a free slot at the moment
 * it runs. On sentrello.com, with a ceiling of 25, that came to 23 already in
 * use with nobody doing anything — measured, not guessed. Leave a third of the
 * ceiling free, or the first thing to fail is the backup nobody was watching.
 */
export function poolSize(): number {
  const asked = Number(process.env.SENTRELLO_DB_POOL ?? 10);
  return Number.isFinite(asked) ? Math.max(2, Math.trunc(asked)) : 10;
}

const ssl = dbSsl();

/**
 * One pool per process, even when the module is evaluated more than once.
 *
 * `bun --hot` re-evaluates this file on every save, and a plain top-level
 * `postgres(...)` builds a fresh pool each time while the previous one keeps
 * its sockets. A morning's editing therefore ends with fifteen pools per
 * server and every connection the database allows already spoken for — which
 * is what happened here: two dev servers held 300 of 300, and the tests could
 * not open a single one.
 *
 * This has been paid for twice. The database's ceiling was raised from 100 to
 * 300 to make it go away, which treated the symptom and bought a few more
 * hours before the same wall.
 *
 * Stashed on `globalThis` because that is the one thing a reload does not
 * replace. In production the module is evaluated once and this is an ordinary
 * assignment. Keyed on the settings that shape the pool, so changing the URL
 * or the size still gets a new one — and closes the old one rather than
 * leaking it in a different way.
 */
const POOL = Symbol.for("sentrello.db.pool");
const poolKey = JSON.stringify([url, poolSize(), Boolean(ssl)]);
type Held = { key: string; sql: ReturnType<typeof postgres> };
const holder = globalThis as unknown as Record<symbol, Held | undefined>;

let held = holder[POOL];
if (held && held.key !== poolKey) {
  void held.sql.end({ timeout: 5 }).catch(() => {});
  held = undefined;
}
if (!held) {
  held = {
    key: poolKey,
    sql: postgres(url, { max: poolSize(), ...(ssl ? { ssl } : {}) }),
  };
  holder[POOL] = held;
}

const sql = held.sql;

/**
 * A seam for watching the SQL this process runs.
 *
 * Nothing sets `onQuery` in production, where this costs one undefined check
 * per query. It exists for the one property no response body can be made to
 * show: that a business read *names the business*. A missing
 * `organizationId` filter is invisible to any assertion about what came back,
 * because a test database with one business in it returns the same rows
 * either way — so the test reads the query rather than the answer.
 */
export const watchQueries: { onQuery?: (query: string) => void } = {};

export const db = drizzle(sql, {
  schema,
  logger: { logQuery: (query) => watchQueries.onQuery?.(query) },
});
export { schema };
