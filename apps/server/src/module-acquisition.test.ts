import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LicenseState } from "@sentrello/licensing-client";
import { pursueGainedModules } from "./module-acquisition";

/**
 * The automatic half of "Check for updates": a refresh that shows the
 * licence gained a bundle this instance does not have raises the same
 * `sync-requested` signal the button writes. These prove it fires on a
 * genuine gain, exactly once, and never on a refresh that changed nothing —
 * using the real files under `SENTRELLO_DATA_DIR`, the same seam
 * `updates.test.ts` in `@sentrello/module-settings` uses for the button
 * itself.
 */

let dir: string;
const savedDataDir = process.env.SENTRELLO_DATA_DIR;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sentrello-acquisition-"));
  process.env.SENTRELLO_DATA_DIR = dir;
});

afterEach(async () => {
  process.env.SENTRELLO_DATA_DIR = savedDataDir;
  await rm(dir, { recursive: true, force: true });
});

async function markAgentPresent(): Promise<void> {
  await writeFile(join(dir, "update-agent"), "1\n", "utf8");
}

async function syncRequested(): Promise<boolean> {
  return await Bun.file(join(dir, "sync-requested")).exists();
}

const pro = (modules: string[]): LicenseState => ({
  valid: true,
  claims: {
    license_id: "lic1",
    instance_id: "inst1",
    tier: "pro",
    modules,
    seats: 1,
    grace_until: null,
  },
});

const free: LicenseState = {
  claims: null,
  valid: false,
  reason: "no token (Free)",
};

test("a genuine gain, with an agent present, asks the host to sync", async () => {
  await markAgentPresent();
  await pursueGainedModules(pro([]), pro(["shop"]), ["dashboard"]);
  expect(await syncRequested()).toBe(true);
});

test("a refresh that changes nothing asks for nothing", async () => {
  await markAgentPresent();
  const state = pro(["shop"]);
  await pursueGainedModules(state, state, ["dashboard"]);
  expect(await syncRequested()).toBe(false);
});

test("a gap that was already missing before this refresh is not re-requested", async () => {
  await markAgentPresent();
  await pursueGainedModules(pro(["shop"]), pro(["shop"]), ["dashboard"]);
  expect(await syncRequested()).toBe(false);
});

test("losing an entitlement asks for nothing — there is nothing to unload or fetch", async () => {
  await markAgentPresent();
  await pursueGainedModules(pro(["shop"]), pro([]), ["dashboard"]);
  expect(await syncRequested()).toBe(false);
});

test("a gain that is already present on disk asks for nothing", async () => {
  await markAgentPresent();
  await pursueGainedModules(pro([]), pro(["shop"]), ["dashboard", "shop"]);
  expect(await syncRequested()).toBe(false);
});

test("with no update agent, the gain is reported and nothing is written to disk", async () => {
  // No `update-agent` marker: this instance has no host agent to ask.
  await pursueGainedModules(pro([]), pro(["shop"]), ["dashboard"]);
  expect(await syncRequested()).toBe(false);
});

test("a refresh that gains an absent entitlement raises the signal exactly once", async () => {
  await markAgentPresent();
  let before = pro([]);
  let after = pro(["shop"]);
  await pursueGainedModules(before, after, ["dashboard"]);
  expect(await syncRequested()).toBe(true);

  // Consumed the way the host agent would, by acting on it.
  await rm(join(dir, "sync-requested"));

  // Next refresh: the licence state carried forward unchanged (the fetch
  // failed, or nobody has restarted to load it yet) — this is the case the
  // task calls "must not loop forever". The signal must not fire again.
  before = after;
  after = pro(["shop"]);
  await pursueGainedModules(before, after, ["dashboard"]);
  expect(await syncRequested()).toBe(false);
});

test("Free instances never trigger this — nothing is entitled, so nothing is missing", async () => {
  await markAgentPresent();
  await pursueGainedModules(free, free, ["dashboard"]);
  expect(await syncRequested()).toBe(false);
});

test("never grants anything: only names already in `after`'s claims can appear", async () => {
  // A module this instance was never entitled to must not be requested just
  // because it is absent from `present`.
  await markAgentPresent();
  await pursueGainedModules(pro([]), pro([]), ["dashboard"]);
  expect(await syncRequested()).toBe(false);
});
