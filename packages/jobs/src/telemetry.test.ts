import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  band,
  sendTelemetry,
  setTelemetryEnabled,
  telemetryEnabled,
} from "./telemetry";

/**
 * The property worth defending: nothing leaves the machine unless somebody
 * said yes. A self-hosted product that reports on its owner without asking is
 * one nobody should trust with their books.
 */

const saved = {
  dataDir: process.env.SENTRELLO_DATA_DIR,
  telemetry: process.env.SENTRELLO_TELEMETRY,
  instance: process.env.SENTRELLO_INSTANCE_ID,
  url: process.env.SENTRELLO_TELEMETRY_URL,
};

afterEach(() => {
  process.env.SENTRELLO_DATA_DIR = saved.dataDir;
  process.env.SENTRELLO_TELEMETRY = saved.telemetry;
  process.env.SENTRELLO_INSTANCE_ID = saved.instance;
  process.env.SENTRELLO_TELEMETRY_URL = saved.url;
});

test("silence is the default", async () => {
  process.env.SENTRELLO_TELEMETRY = undefined;
  process.env.SENTRELLO_DATA_DIR = "/nonexistent-data-dir-for-test";
  expect(await telemetryEnabled()).toBe(false);

  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("{}");
  }) as unknown as typeof fetch;

  const result = await sendTelemetry({ endpoint: "http://localhost:1/nope" });
  globalThis.fetch = original;

  expect(result.sent).toBe(false);
  expect(called).toBe(false);
});

test("an instance nobody asked stays quiet even when the flag is on", async () => {
  // No instance id means the installer never wrote one, which means the
  // question was never put to anybody.
  process.env.SENTRELLO_TELEMETRY = "on";
  process.env.SENTRELLO_INSTANCE_ID = undefined;

  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("{}");
  }) as unknown as typeof fetch;

  const result = await sendTelemetry({ endpoint: "http://localhost:1/nope" });
  globalThis.fetch = original;

  expect(result.sent).toBe(false);
  expect(called).toBe(false);
});

test("what is sent is a count, not a customer", async () => {
  process.env.SENTRELLO_TELEMETRY = "on";
  process.env.SENTRELLO_INSTANCE_ID = "instance-under-test";

  let body: Record<string, unknown> = {};
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? "{}"));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const result = await sendTelemetry({
    tier: "pro",
    modules: ["crm", "invoicing"],
    endpoint: "http://localhost/telemetry",
  });
  globalThis.fetch = original;

  expect(result.sent).toBe(true);
  expect(Object.keys(body).sort()).toEqual([
    "instanceId",
    "modules",
    "tier",
    "users",
    "version",
  ]);
  // Banded, so the number sizes the product rather than identifying a business.
  expect(typeof body.users).toBe("string");
});

test("user counts are banded", () => {
  expect(band(0)).toBe("1");
  expect(band(1)).toBe("1");
  expect(band(4)).toBe("2-5");
  expect(band(11)).toBe("11-20");
  expect(band(400)).toBe("21+");
});

test("the choice saves even where the data directory does not exist yet", async () => {
  // Found by using it: on a checkout there is no /data, and the toggle in
  // Settings answered with a 500 and a stack trace. The directory exists on
  // any real install, so no test that assumed one would ever have caught it.
  const dir = `${tmpdir()}/sentrello-telemetry-${crypto.randomUUID()}/nested`;
  process.env.SENTRELLO_DATA_DIR = dir;
  process.env.SENTRELLO_TELEMETRY = undefined;

  await setTelemetryEnabled(true);
  expect(await telemetryEnabled()).toBe(true);

  await setTelemetryEnabled(false);
  expect(await telemetryEnabled()).toBe(false);

  await rm(dir, { recursive: true, force: true });
});
