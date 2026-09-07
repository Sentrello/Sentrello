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
const sql = postgres(url, { max: poolSize(), ...(ssl ? { ssl } : {}) });
export const db = drizzle(sql, { schema });
export { schema };
