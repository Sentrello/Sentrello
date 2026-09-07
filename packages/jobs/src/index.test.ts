import { afterAll, expect, test } from "bun:test";
import type PgBoss from "pg-boss";
import { QUEUES, SCHEDULES, startJobs, withoutSslMode } from "./index";
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
 * never the problem. prodemo sat in exactly that state for four days: a key
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
