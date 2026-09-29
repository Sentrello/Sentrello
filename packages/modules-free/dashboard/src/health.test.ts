import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHealth } from "./health";

/**
 * What the nightly backup last did, read from the one channel there is.
 *
 * The backups themselves are not reachable from here: `backups/` sits beside the
 * instance on the host and only `./data` is mounted into the container. So the
 * CLI writes a small JSON file and this reads it — the same channel the update
 * agent already uses.
 *
 * The promise is in the published documentation, a backup every night and
 * fourteen kept, and until 2026-09-29 nothing in the product could say whether
 * it was being kept. The failure is silent by nature: the timer is on the host,
 * its output goes to the journal, and the owner of a self-hosted instance has no
 * IT department and is not reading journals.
 *
 * Which makes the unreadable cases the ones worth testing. A dashboard that
 * throws because a status file was half-written while the host replaced it is a
 * worse outcome than one that says nothing about backups.
 */
let dir: string;
const was = process.env.SENTRELLO_DATA_DIR;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sentrello-health-"));
  process.env.SENTRELLO_DATA_DIR = dir;
});

afterEach(async () => {
  // Assigned rather than deleted, which is what the lint rule asks and what the
  // rest of this repository does: `dataDir()` falls back on an empty value the
  // same way it falls back on an unset one.
  process.env.SENTRELLO_DATA_DIR = was;
  await rm(dir, { recursive: true, force: true });
});

const write = (body: string) =>
  writeFile(join(dir, "backup-status.json"), body, "utf8");

test("a backup the host reported comes back with its count", async () => {
  const at = new Date().toISOString();
  await write(`{"state":"ok","detail":"","kept":14,"at":"${at}"}`);
  const health = await readHealth();
  expect(health.backup).toEqual({ state: "ok", detail: "", kept: 14, at });
});

test("a failure comes back as one, with its reason", async () => {
  await write(
    `{"state":"failed","detail":"the dump could not be taken","kept":13,"at":"${new Date().toISOString()}"}`,
  );
  const backup = (await readHealth()).backup;
  expect(backup?.state).toBe("failed");
  // The reason too: "failed" alone sends somebody to the journal the panel
  // exists to save them from reading.
  expect(backup?.detail).toBe("the dump could not be taken");
});

test("no file at all is null rather than a throw", async () => {
  expect((await readHealth()).backup).toBeNull();
});

test("a half-written file is null rather than a throw", async () => {
  // What a reader sees if it arrives mid-replace, which is a real moment: the
  // CLI writes to a temporary name and moves it, and a dashboard load can land
  // anywhere.
  await write('{"state":"ok","detail":"","kept":1');
  expect((await readHealth()).backup).toBeNull();
});

test("a file with no timestamp is null — a backup with no date is no answer", async () => {
  await write('{"state":"ok","detail":"","kept":14}');
  expect((await readHealth()).backup).toBeNull();
});
