import { dbSsl } from "@sentrello/db/ssl";
import PgBoss from "pg-boss";
import { refreshLicenseToken } from "./license-refresh";
import { sendOverdueReminders } from "./overdue";
import { runRecurringInvoices } from "./recurring";
import { runReminders } from "./reminders";
import { sendTelemetry } from "./telemetry";

/** Drops `sslmode` from a connection string, leaving everything else intact. */
export function withoutSslMode(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("sslmode");
    return parsed.toString();
  } catch {
    return url; // not a URL we can parse; hand it back untouched
  }
}

export const QUEUES = {
  recurringInvoices: "recurring-invoices",
  overdueReminders: "overdue-reminders",
  licenseRefresh: "license-refresh",
  telemetry: "telemetry",
} as const;

/** cron schedules, UTC */
export const SCHEDULES: Record<string, string> = {
  [QUEUES.recurringInvoices]: "0 2 * * *",
  [QUEUES.overdueReminders]: "0 8 * * *",
  [QUEUES.licenseRefresh]: "0 3 * * *",
  // Once a day, at an hour nobody is working. It sends nothing at all unless
  // the instance was asked at install time and said yes.
  [QUEUES.telemetry]: "17 4 * * *",
};

/** A job a module asked the host to run. */
export interface ModuleJob {
  name: string;
  cron?: string;
  /**
   * Run it once at startup as well as on its schedule.
   *
   * For work whose result is stale on a brand-new instance and whose schedule
   * is a whole day away — the promo document is the case: without this, a new
   * install shows the built-in copy until the small hours of tomorrow.
   *
   * Sent to the queue rather than called, so it runs where every other job
   * runs: off the boot path, with pg-boss's retries, and with a failure that
   * cannot take the instance down with it.
   */
  runAtBoot?: boolean;
  handler: () => Promise<unknown>;
}

/**
 * Starts the core queues, plus any a loaded module registered.
 *
 * Module jobs are namespaced so two modules cannot collide on a queue name,
 * and so a job left behind by a module the licence no longer loads is obvious
 * in the pg-boss tables.
 */
export async function startJobs(
  moduleJobs: ModuleJob[] = [],
  /**
   * What this instance is licensed for. Only the overdue chase needs it, to
   * decide whether the mail it sends credits Sentrello or goes out under the
   * business's own name — and a job has no request to read it from.
   */
  options: { tier?: "free" | "pro"; modules?: string[] } = {},
) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  // pg-boss uses node-postgres, which verifies TLS strictly. A managed
  // provider's private CA has to be supplied explicitly or the connection is
  // refused with SELF_SIGNED_CERT_IN_CHAIN.
  //
  // `sslmode` in the connection string is parsed by pg-connection-string and
  // wins over an explicit `ssl` option, so it has to come out of the URL for
  // the CA to take effect.
  const ssl = dbSsl();
  /**
   * A small pool, deliberately.
   *
   * pg-boss defaults to ten connections and holds them open for the life of
   * the process. This instance runs a handful of jobs a day — invoices at
   * eight, reminders on the quarter hour, a promo fetch — and none of them
   * runs alongside another for long.
   *
   * Ten idle connections is most of a managed database's allowance spent on
   * work that is not happening: sentrello.com's own is capped at 25, and eight
   * of them were pg-boss sitting still. The application pool, the platform's
   * own agent and a scheduler take the rest, which leaves an outage one
   * restart away.
   *
   * `SENTRELLO_JOBS_POOL` for a host that genuinely runs more.
   */
  const jobsPool = Math.max(
    2,
    Math.trunc(Number(process.env.SENTRELLO_JOBS_POOL ?? 3)) || 3,
  );
  const boss = new PgBoss({
    connectionString: ssl ? withoutSslMode(url) : url,
    max: jobsPool,
    /**
     * How often it looks for work.
     *
     * Two seconds is the default, and it is the right one for a queue that
     * takes work as it arrives. Nothing here does. Every job in this product
     * is on a schedule — invoices at eight, reminders on the quarter hour, the
     * promo document hourly — and the longest any of them waits under this
     * setting is thirty seconds.
     *
     * Measured on sentrello.com before changing it: pg-boss had run 92,654
     * sequential scans against a 123-row table, which was more database work
     * than the entire business generated. A managed instance is billed for
     * that and a small one feels it.
     */
    pollingIntervalSeconds: Math.max(
      2,
      Math.trunc(Number(process.env.SENTRELLO_JOBS_POLL_SECONDS ?? 30)) || 30,
    ),
    /**
     * And what it keeps.
     *
     * Completed jobs move to the archive after an hour and leave after a week.
     * The default keeps them far longer, which on an instance that runs a
     * handful of jobs a day is a table that only grows and is never read —
     * every row of it backed up nightly and restored on every rehearsal.
     */
    archiveCompletedAfterSeconds: 3600,
    deleteAfterDays: 7,
    ...(ssl ? { ssl } : {}),
  });
  await boss.start();

  const all: ModuleJob[] = [
    {
      name: QUEUES.recurringInvoices,
      /**
       * Pro. Hiding the screen would not be a gate — the job is the feature,
       * and one that kept raising invoices on a Free instance would be doing
       * the paid work with the door merely closed.
       *
       * Nothing is deleted when a licence lapses: the profiles stay, this
       * stops, and the day a licence comes back it picks them up again.
       *
       * `options.tier` is read once at start-up, which is as live as this
       * process gets — the licence is resolved at boot and a refreshed token
       * is not seen until a restart. Same fidelity as the chasing job below;
       * worth knowing rather than assuming otherwise.
       */
      handler: () =>
        options.tier === "pro"
          ? runRecurringInvoices(new Date())
          : Promise.resolve({ issued: 0, sent: 0, ended: 0, skipped: [] }),
    },
    {
      name: QUEUES.overdueReminders,
      /**
       * The rule-driven chase, which falls back to the built-in weekly one
       * for a business that has configured nothing.
       */
      handler: () =>
        runReminders(new Date(), {
          sentrelloCredit: options.tier !== "pro",
        }),
    },
    { name: QUEUES.licenseRefresh, handler: () => refreshLicenseToken() },
    {
      name: QUEUES.telemetry,
      handler: () =>
        sendTelemetry({ tier: options.tier, modules: options.modules }),
    },
    ...moduleJobs,
  ];

  for (const job of all) {
    // pg-boss 10 requires the queue to exist before work()/schedule() —
    // omitting this makes both silently no-op.
    await boss.createQueue(job.name);
    await boss.work(job.name, async () => {
      await job.handler();
    });
    const cron = job.cron ?? SCHEDULES[job.name];
    if (cron) await boss.schedule(job.name, cron);
    if (job.runAtBoot) await boss.send(job.name, {});
  }

  return boss;
}

export { runRecurringInvoices, sendOverdueReminders, refreshLicenseToken };
export { runReminders, daysPastDue, lateFeeFor, rulesDue } from "./reminders";
export {
  sendTelemetry,
  setTelemetryEnabled,
  telemetryEnabled,
  telemetryFixedInEnvironment,
  band,
} from "./telemetry";
