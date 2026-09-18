import { afterAll, expect, test } from "bun:test";
import type PgBoss from "pg-boss";
import {
  QUEUES,
  SCHEDULES,
  jitteredMinuteCron,
  startJobs,
  withoutSslMode,
} from "./index";
import { refreshLicenseToken } from "./license-refresh";

let boss: PgBoss | undefined;

afterAll(async () => {
  await boss?.stop({ graceful: false });
});

test("startJobs registers a cron schedule for all three queues", async () => {
  boss = await startJobs();
  const schedules = await boss.getSchedules();
  const byName = new Map(schedules.map((s) => [s.name, s.cron]));

  for (const queue of Object.values(QUEUES)) {
    expect(byName.get(queue)).toBe(SCHEDULES[queue]);
  }
});

/**
 * A schedule for work nothing does any more is withdrawn.
 *
 * A cron lives in the database, not in a file, so a job that is renamed or a
 * module that is removed leaves its schedule behind — putting a job on a queue
 * no worker is listening to, every hour, for ever. Nothing fails and nothing
 * says so; the table just grows.
 *
 * Job names carry the module (`accounting:bank-feeds`), so renaming a module
 * renames all of its jobs at once. That is the case this exists for.
 */
test("a schedule nothing works any more is stopped", async () => {
  boss = boss ?? (await startJobs());

  // A module that was here yesterday and is not here today.
  await boss.createQueue("departed:nightly");
  await boss.schedule("departed:nightly", "0 3 * * *");
  expect(
    (await boss.getSchedules()).some((s) => s.name === "departed:nightly"),
  ).toBe(true);

  // Booting again notices nothing works it.
  await boss.stop({ graceful: false });
  boss = await startJobs();

  const left = await boss.getSchedules();
  expect(left.some((s) => s.name === "departed:nightly")).toBe(false);

  // And every schedule that is still wanted survives, which is the half that
  // matters: a sweep that took the live ones with it would stop the business.
  const byName = new Map(left.map((s) => [s.name, s.cron]));
  for (const queue of Object.values(QUEUES)) {
    expect(byName.get(queue)).toBe(SCHEDULES[queue]);
  }
});

/**
 * The queue reporting a problem must not be the end of the process.
 *
 * `PgBoss extends EventEmitter` and emits `error` from the connection pool,
 * the maintenance pass, the cron timekeeper and a worker whose fetch fails —
 * none of which is a job's own handler throwing. Node throws an `error` event
 * with no listener as an uncaught exception, and the queue runs in the same
 * process that serves every screen, so an unlistened emit is the instance
 * going down.
 */
test("the queue has somebody listening when it reports an error", async () => {
  boss = boss ?? (await startJobs());
  expect(boss.listenerCount("error")).toBeGreaterThan(0);

  // And the emit itself is survivable: without a listener this line is an
  // uncaught exception rather than an assertion.
  expect(() =>
    boss?.emit("error", new Error("a maintenance pass failed")),
  ).not.toThrow();
});

/**
 * A job that stops says so.
 *
 * pg-boss marks a thrown handler for retry and, once the retries are spent,
 * leaves it `failed` — emitting nothing and logging nothing. Everything on
 * these queues charges, emails, posts or expires something, so a run that
 * dies quietly is the worst shape a failure can take here.
 */
test("a job that throws is reported before it is retried", async () => {
  // The shipped default looks for work every thirty seconds, which is right
  // for a queue of scheduled work and far longer than a test should wait.
  const wasPoll = process.env.SENTRELLO_JOBS_POLL_SECONDS;
  process.env.SENTRELLO_JOBS_POLL_SECONDS = "2";
  const failing = await startJobs([
    {
      name: "test:always-fails",
      handler: async () => {
        throw new Error("the handler gave up");
      },
    },
  ]);
  const said: string[] = [];
  const wasError = console.error;
  console.error = (...args: unknown[]) => {
    said.push(args.map(String).join(" "));
  };
  try {
    await failing.send("test:always-fails", {});
    const deadline = Date.now() + 20_000;
    while (
      !said.some((line) => line.includes("test:always-fails")) &&
      Date.now() < deadline
    ) {
      await Bun.sleep(250);
    }
  } finally {
    console.error = wasError;
    await failing.stop({ graceful: false });
    if (wasPoll === undefined) {
      process.env.SENTRELLO_JOBS_POLL_SECONDS = undefined;
    } else {
      process.env.SENTRELLO_JOBS_POLL_SECONDS = wasPoll;
    }
  }

  expect(said.some((line) => line.includes("test:always-fails failed"))).toBe(
    true,
  );
}, 30_000);

test("license-refresh no-ops cleanly on a Free instance", async () => {
  // no license key: a Free instance has nothing to refresh and must not call out
  expect(
    await refreshLicenseToken({
      serverUrl: "https://sentrello.com",
      tokenPath: "secrets/license_token.jwt",
    }),
  ).toEqual({ refreshed: false });
});

/**
 * A key that is set and unusable is not the same as no key.
 *
 * They were the same silent answer, and the terminal reported both as a server
 * that could not be reached — which sends somebody to check a firewall that was
 * never the problem. One of our own instances sat in exactly that state for four days: a key
 * written by hand with six groups instead of four, a nightly refresh that did
 * nothing, and a token that then expired into Free.
 */
test("a key that is set but malformed says so, rather than blaming the network", async () => {
  expect(
    await refreshLicenseToken({
      serverUrl: "https://sentrello.com",
      // What `licenseKey()` returns for a key that fails the shape check.
      licenseKey: undefined,
      keyConfigured: true,
      tokenPath: "secrets/should-never-be-written.jwt",
    }),
  ).toEqual({ refreshed: false, error: "malformed_key" });

  // And nothing left the machine to find that out.
  expect(await Bun.file("secrets/should-never-be-written.jwt").exists()).toBe(
    false,
  );
});

test("license-refresh survives an unreachable license server", async () => {
  expect(
    await refreshLicenseToken({
      // closed local port: refused immediately, no request leaves the machine
      serverUrl: "http://127.0.0.1:1",
      licenseKey: "lic_test",
      instanceId: "inst_test",
      tokenPath: "secrets/should-never-be-written.jwt",
    }),
  ).toEqual({ refreshed: false, error: "unreachable" });

  expect(await Bun.file("secrets/should-never-be-written.jwt").exists()).toBe(
    false,
  );
});

test("license-refresh keeps the old token when the server rejects the key", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("revoked", { status: 403 }),
  });
  try {
    expect(
      await refreshLicenseToken({
        serverUrl: `http://127.0.0.1:${server.port}`,
        licenseKey: "lic_revoked",
        instanceId: "inst_test",
        tokenPath: "secrets/should-never-be-written.jwt",
      }),
    ).toEqual({ refreshed: false });
    expect(await Bun.file("secrets/should-never-be-written.jwt").exists()).toBe(
      false,
    );
  } finally {
    server.stop(true);
  }
});

/**
 * `not_entitled` at 402 is the one answer the licence server gives that
 * means, in as many words, "this licence is not valid any more" (see
 * `control-plane/src/license-server.ts`). Everything else short of it — a
 * refused request for any other reason, an error string this job does not
 * recognise — must leave the token alone; getting this the wrong way round
 * drops a paying customer to Free over a network hiccup.
 */
test("license-refresh clears the token immediately on an explicit revocation", async () => {
  const tokenPath = "secrets/test-revoked-token.jwt";
  await Bun.write(tokenPath, "still-nominally-valid-token");
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({ error: "not_entitled", tier: "free" }, { status: 402 }),
  });
  try {
    expect(
      await refreshLicenseToken({
        serverUrl: `http://127.0.0.1:${server.port}`,
        licenseKey: "lic_cancelled",
        instanceId: "inst_test",
        tokenPath,
      }),
    ).toEqual({ refreshed: false, error: "not_entitled", revoked: true });
    // Cleared, not merely left alone: the next refresh must see no token,
    // not the one that technically still has hours left on it.
    expect(await Bun.file(tokenPath).text()).toBe("");
  } finally {
    server.stop(true);
    await Bun.file(tokenPath)
      .delete()
      .catch(() => {});
  }
});

test("an ambiguous or unrecognised refusal is treated as no answer, not a revocation", async () => {
  const tokenPath = "secrets/test-ambiguous-token.jwt";
  await Bun.write(tokenPath, "still-nominally-valid-token");
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json(
        { error: "instance_limit", reason: "too many installs" },
        { status: 409 },
      ),
  });
  try {
    expect(
      await refreshLicenseToken({
        serverUrl: `http://127.0.0.1:${server.port}`,
        licenseKey: "lic_busy",
        instanceId: "inst_test",
        tokenPath,
      }),
    ).toEqual({ refreshed: false, error: "instance_limit" });
    expect(await Bun.file(tokenPath).text()).toBe(
      "still-nominally-valid-token",
    );
  } finally {
    server.stop(true);
    await Bun.file(tokenPath)
      .delete()
      .catch(() => {});
  }
});

test("a 5xx from the license server leaves the token untouched", async () => {
  const tokenPath = "secrets/test-5xx-token.jwt";
  await Bun.write(tokenPath, "still-nominally-valid-token");
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("internal error", { status: 500 }),
  });
  try {
    expect(
      await refreshLicenseToken({
        serverUrl: `http://127.0.0.1:${server.port}`,
        licenseKey: "lic_test",
        instanceId: "inst_test",
        tokenPath,
      }),
    ).toEqual({ refreshed: false });
    expect(await Bun.file(tokenPath).text()).toBe(
      "still-nominally-valid-token",
    );
  } finally {
    server.stop(true);
    await Bun.file(tokenPath)
      .delete()
      .catch(() => {});
  }
});

test("license-refresh writes a fresh token when the server issues one", async () => {
  const tokenPath = "secrets/test-refreshed-token.jwt";
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ token: "fresh.token.value" }),
  });
  try {
    expect(
      await refreshLicenseToken({
        serverUrl: `http://127.0.0.1:${server.port}`,
        licenseKey: "lic_active",
        instanceId: "inst_test",
        tokenPath,
      }),
    ).toEqual({ refreshed: true });
    expect(await Bun.file(tokenPath).text()).toBe("fresh.token.value");
  } finally {
    server.stop(true);
    await Bun.file(tokenPath)
      .delete()
      .catch(() => {});
  }
});

/**
 * The licence refresh moved from once a day to once an hour, with a random
 * minute so every self-hosted instance does not hit the licence server on
 * the same second. `SCHEDULES[QUEUES.licenseRefresh]` is that jittered cron,
 * computed once when this module loads — these prove the generator itself,
 * separately from the "does startJobs actually register it" coverage above.
 */
test("the licence refresh cron is hourly, at a minute chosen once per process", () => {
  const cron = SCHEDULES[QUEUES.licenseRefresh];
  expect(cron).toMatch(/^([0-9]|[1-5][0-9]) \* \* \* \*$/);
  // Stable for the life of the process: nothing re-rolls it between reads.
  expect(SCHEDULES[QUEUES.licenseRefresh]).toBe(cron);
});

test("jitteredMinuteCron spreads across the hour rather than landing on it", () => {
  expect(jitteredMinuteCron(() => 0)).toBe("0 * * * *");
  // Math.random() is exclusive of 1, so the highest reachable minute is 59,
  // never a 60th minute that would make this an invalid cron field.
  expect(jitteredMinuteCron(() => 0.999999)).toBe("59 * * * *");
  expect(jitteredMinuteCron(() => 0.5)).toBe("30 * * * *");

  // Two instances booting at the same moment do not land on the same minute.
  const a = jitteredMinuteCron(() => 0.1);
  const b = jitteredMinuteCron(() => 0.9);
  expect(a).not.toBe(b);
});

test("sslmode is stripped so an explicit CA is not overridden by the URL", () => {
  expect(
    withoutSslMode(
      "postgresql://u:p@host.example:25060/db?sslmode=require&application_name=x",
    ),
  ).toBe("postgresql://u:p@host.example:25060/db?application_name=x");

  // nothing else is disturbed
  expect(withoutSslMode("postgresql://u:p@host/db")).toBe(
    "postgresql://u:p@host/db",
  );
  expect(withoutSslMode("not a url")).toBe("not a url");
});
