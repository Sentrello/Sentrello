import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { dbSsl } from "./ssl";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const ssl = dbSsl();
const sql = postgres(url, { max: 1, ...(ssl ? { ssl } : {}) });
// resolved against this file, not the cwd, so `bun run db:migrate` works from
// the repo root (where .env lives) as well as from packages/db
await migrate(drizzle(sql), {
  migrationsFolder: `${import.meta.dir}/../drizzle`,
});
await sql.end();
console.log("migrations applied");
