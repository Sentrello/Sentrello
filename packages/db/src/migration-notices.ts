import type postgres from "postgres";

/**
 * postgres.js's default NOTICE handler is `console.log(theRawErrorObject)` —
 * on a migration re-run that means a multi-line JSON dump (file: "schemacmds.c"
 * and all) for every schema or table that already exists, which reads as a
 * crash to someone installing Sentrello for the first time. Those notices are
 * Postgres saying "skipping, already done" and are expected on any re-run.
 *
 * Anything else a notice says is surfaced in full — it might be the one
 * worth reading. This never touches error handling: a failed migration still
 * throws and still fails the process.
 */
export function logMigrationNotice(notice: postgres.Notice): void {
  if (/already exists, skipping/i.test(notice.message ?? "")) return;
  console.log(`[db] notice: ${notice.message}`);
}
