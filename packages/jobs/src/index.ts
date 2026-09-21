import { sweepAllRetention } from "@sentrello/db/retention";
import { dbSsl } from "@sentrello/db/ssl";
import PgBoss from "pg-boss";
import { refreshLicenseToken } from "./license-refresh";
import { sendOverdueReminders } from "./overdue";
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
  overdueReminders: "overdue-reminders",
  licenseRefresh: "license-refresh",
  telemetry: "telemetry",
  retention: "retention",
} as const;

/**
 * A random minute for the licence refresh, rolled once per process.
 *
 * Every self-hosted instance in the world runs the same schedule. On the
 * hour, exactly, every one of them would call the licence server in the same
 * second; a minute chosen here and re-rolled on every restart spreads them
 * across the hour instead, without anything to configure or agree on.
 */
export function jitteredMinuteCron(random: () => number = Math.random): string {
  const minute = Math.max(0, Math.min(59, Math.floor(random() * 60)));
  return `${minute} * * * *`;
}

/** cron schedules, UTC */
export const SCHEDULES: Record<string, string> = {
  [QUEUES.overdueReminders]: "0 8 * * *",
  /**
   * Hourly, not daily. What is bought is how long a cancelled customer keeps
   * a paid feature: `refreshLicenseState` (apps/server/src/license.ts)
   * re-reads whatever `refreshLicenseToken` just did or did not write, so
   * that ceiling is exactly this interval — daily meant a revoked licence
   * could still gate a feature open for most of a day, hourly caps it at an
   * hour. The cost is one more request per instance per hour, which James
   * accepted outright: "more calls to the server is fine. As we grow we can
   * scale the server." Below hourly buys little more revocation speed for a
   * cost that scales with every instance in the world; hourly is the first
   * round number that turns "within a day" into "within an hour."
   */
  [QUEUES.licenseRefresh]: jitteredMinuteCron(),
  // Once a day, at an hour nobody is working. It sends nothing at all unless
  // the instance was asked at install time and said yes.
  [QUEUES.telemetry]: "17 4 * * *",
  /**
   * Once a night, not once a minute.
   *
   * Nothing about retention is urgent to the hour, and a sweep that runs while
   * the office does is a sweep competing with the application for the same
   * rows. The trash purge is every minute because a restore screen has to be
   * right immediately; this has no such promise to keep. Off the hour and away
   * from the others, so the one long-running job of the night has the box to
   * itself.
   */
  [QUEUES.retention]: "23 3 * * *",
};

/** A job a module asked the host to run. */
export interface ModuleJob {
  name: string;
  cron?: string;
  /**
   * Run it once at startup as well as on its schedule.
   *
   * For work whose result is stale on a brand-new instance and whose schedule
   * is a whole day away — an instance installed at ten in the morning should
   * not wait until four tomorrow for the first run of something a new install
   * needs today.
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
  options: {
    tier?: "free" | "pro";
    modules?: string[];
    /**
     * Run after every licence-refresh attempt, success or failure, so the
     * host can re-read whatever is on disk now into its live entitlement
     * state. Optional: a caller that never calls `startJobs` with a licence
     * at all (a test, say) has nothing to refresh.
     */
    onLicenseRefresh?: () => Promise<void>;
  } = {},
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
     * is on a schedule — invoices at eight, reminders on the quarter hour,
     * licence checks hourly — and the longest any of them waits under this
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

  /**
   * Somebody listening when the queue itself goes wrong.
   *
   * `PgBoss extends EventEmitter` and emits `error` from four places that
   * have nothing to do with a job's own handler: the connection pool
   * (`src/db.js`), the maintenance and monitoring passes (`src/boss.js`), the
   * cron timekeeper (`src/timekeeper.js`), and a worker whose *fetch* fails
   * (`src/manager.js`). Node's rule for an `error` event with no listener is
   * to throw it as an uncaught exception — and the queue runs inside the same
   * process that serves every screen, so a database blip during a maintenance
   * pass took the whole instance down. Nothing in this repository was
   * listening.
   *
   * Logged rather than acted on, deliberately. pg-boss recovers from all four
   * on its own next pass; what was missing was a process that survives them
   * and a line saying what happened.
   */
  boss.on("error", (err) => {
    console.error("[jobs] the queue reported an error", err);
  });

  const all: ModuleJob[] = [
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
    {
      name: QUEUES.licenseRefresh,
      handler: async () => {
        await refreshLicenseToken();
        // Whether or not that reached the server: either a fresh token just
        // landed on disk, or the old one is still there and may since have
        // expired on its own. Both are reasons to re-read it.
        await options.onLicenseRefresh?.();
      },
    },
    {
      name: QUEUES.telemetry,
      handler: () =>
        sendTelemetry({ tier: options.tier, modules: options.modules }),
    },
    {
      /**
       * Every module's logs, brought back inside the windows they declared.
       *
       * One job for all of them rather than one each: the budget that stops a
       * first sweep running until breakfast has to be shared to mean anything,
       * and a module that forgets to register a job is a table nobody prunes.
       */
      name: QUEUES.retention,
      handler: () => sweepAllRetention(),
    },
    ...moduleJobs,
  ];

  /** Jobs that could not be set up at all, so nothing tries to tidy them. */
  const unusable = new Set<string>();
  for (const job of all) {
    /*
     * One module's bad job costs only that job.
     *
     * A cron is free text a module hands over — `registerJob({ cron })` — and
     * a module in another repository writing something cron-parser will not
     * have threw straight out of this loop. `startJobs` is awaited at module
     * scope in the server's boot and nothing catches it, so that was not one
     * job missing: it was every job registered after it, the licence refresh
     * and the retention sweep among them, and no instance at all.
     *
     * The same argument the loader settles for `register` and the migrations,
     * one process further on: a module that cannot start must not stop the
     * business invoicing today.
     */
    try {
      await setUpJob(boss, job);
    } catch (err) {
      unusable.add(job.name);
      console.error(
        `[jobs] ${job.name} could not be set up and will not run: ${(err as Error).message}`,
      );
    }
  }

  await forgetOrphanedSchedules(
    boss,
    new Set(all.filter((job) => !unusable.has(job.name)).map((j) => j.name)),
  );

  return boss;
}

/** One job's queue, worker and schedule. Throws if pg-boss will not have it. */
async function setUpJob(boss: PgBoss, job: ModuleJob): Promise<void> {
  // pg-boss 10 requires the queue to exist before work()/schedule() —
  // omitting this makes both silently no-op.
  await boss.createQueue(job.name);
  await boss.work(job.name, async () => {
    /**
     * A failure says so, then fails.
     *
     * pg-boss catches whatever a handler throws, marks the job for retry,
     * and after `retry_limit` attempts (two, by default) leaves it in the
     * `failed` state — without emitting anything and without writing a
     * line anywhere. So the licence refresh, the retention sweep and the
     * overdue chase could all stop for good and the only evidence would be
     * a row in a table nobody opens. Re-thrown after the log, because the
     * retry is the useful half of that behaviour; the silence was not.
     */
    try {
      await job.handler();
    } catch (err) {
      console.error(`[jobs] ${job.name} failed`, err);
      throw err;
    }
  });
  const cron = job.cron ?? SCHEDULES[job.name];
  if (cron) await boss.schedule(job.name, cron);
  if (job.runAtBoot) await boss.send(job.name, {});
}

/**
 * Schedules for work nothing does any more.
 *
 * A cron lives in the database, not in this file. So a job that is renamed, a
 * module that is removed, or a licence that lapses leaves its schedule behind —
 * and it keeps firing, putting a job on a queue no worker is listening to,
 * every hour, for ever. Nothing fails; the table just grows, and the first
 * anybody knows is a database bigger than the business that owns it.
 *
 * Job names are namespaced by module (`pro-accounting:recurring-bills`), so
 * renaming a module renames every one of its jobs at once. That is the case
 * this was written for.
 *
 * Only schedules are withdrawn, never queues or the jobs on them: an unworked
 * queue may be holding something somebody still wants, and deciding that is not
 * a thing to do at boot.
 */
async function forgetOrphanedSchedules(
  boss: PgBoss,
  wanted: Set<string>,
): Promise<void> {
  try {
    const scheduled = await boss.getSchedules();
    for (const schedule of scheduled) {
      if (wanted.has(schedule.name)) continue;
      await boss.unschedule(schedule.name);
      console.warn(
        `[jobs] stopped the schedule for ${schedule.name}: nothing works that queue any more`,
      );
    }
  } catch (err) {
    /*
     * Tidying is not worth failing a boot over. An instance that cannot read
     * its own schedules still has every job it registered a moment ago.
     */
    console.warn(`[jobs] could not check for stale schedules: ${err}`);
  }
}

export { sendOverdueReminders, refreshLicenseToken };
export { runReminders, daysPastDue, lateFeeFor, rulesDue } from "./reminders";
export {
  sendTelemetry,
  setTelemetryEnabled,
  telemetryEnabled,
  telemetryFixedInEnvironment,
  band,
} from "./telemetry";
