import { afterAll, beforeAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { createModuleApp } from "@sentrello/module-sdk";
import { serveWeb } from "./static";

const dist = `/tmp/sentrello-web-test-${crypto.randomUUID().slice(0, 8)}`;
const app = createModuleApp();

beforeAll(async () => {
  await Bun.write(`${dist}/index.html`, "<!doctype html><title>app</title>");
  await Bun.write(`${dist}/assets/app.js`, "console.log('hi')");
  await Bun.write("/tmp/sentrello-secret-probe.txt", "TOP SECRET");

  app.get("/api/contacts", (c) => c.json({ contacts: [] }));
  serveWeb(app, dist);
});

afterAll(async () => {
  await rm(dist, { recursive: true, force: true });
  await rm("/tmp/sentrello-secret-probe.txt", { force: true });
});

test("serves index.html at the root", async () => {
  const res = await app.request("http://localhost/");
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("<title>app</title>");
});

test("serves a real asset", async () => {
  const res = await app.request("http://localhost/assets/app.js");
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("console.log");
});

test("an unknown client route falls back to index.html", async () => {
  const res = await app.request("http://localhost/contacts/123");
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("<title>app</title>");
});

test("routes registered earlier still win", async () => {
  const res = await app.request("http://localhost/api/contacts");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ contacts: [] });
});

test("an unknown /api path stays a 404 and never returns HTML", async () => {
  const res = await app.request("http://localhost/api/nope");
  expect(res.status).toBe(404);
  expect(await res.text()).not.toContain("<title>");
});

test("path traversal cannot escape the dist directory", async () => {
  for (const attempt of [
    "/../sentrello-secret-probe.txt",
    "/../../tmp/sentrello-secret-probe.txt",
    "/assets/../../sentrello-secret-probe.txt",
    "/%2e%2e/sentrello-secret-probe.txt",
    "/..%2fsentrello-secret-probe.txt",
  ]) {
    const res = await app.request(`http://localhost${attempt}`);
    const body = await res.text();
    expect(body).not.toContain("TOP SECRET");
  }
});

/**
 * The one file the browser must never keep.
 *
 * The service worker decides what everything else is allowed to remember, so a
 * stale copy of it is an instance that cannot be updated by any means it knows
 * about — the old worker would keep answering with the old application for as
 * long as the browser felt like holding it.
 */
test("the service worker is served, and told not to be cached", async () => {
  await Bun.write(`${dist}/sw.js`, "self.addEventListener('fetch', () => {});");
  const res = await app.request("http://localhost/sw.js");

  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-cache");
});
