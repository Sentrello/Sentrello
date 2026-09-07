import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { dbSsl } from "./ssl";

/**
 * Applies one module's migrations, in its own tracking table.
 *
 * Keeping the table per module means a customer can buy a module a year after
 * installing, or drop one, without either action touching the history of
 * anything else. Migrations must be additive for the same reason.
 */
export async function runModuleMigrations(
  migrationsFolder: string,
  migrationsTable: string,
): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const ssl = dbSsl();
  const sql = postgres(url, { max: 1, ...(ssl ? { ssl } : {}) });
  try {
    await migrate(drizzle(sql), { migrationsFolder, migrationsTable });
  } finally {
    await sql.end();
  }
}
