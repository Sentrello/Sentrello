import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The preload that decides which database a test run may write to.
 *
 * It is the earliest thing in a run and the only thing standing between a
 * suite and the wrong database, so it is worth its own tests: a guard whose
 * refusal silently stopped refusing would look exactly like a clean run.
 *
 * Each case starts a fresh `bun` with `DATABASE_URL` set, because what is being
 * tested is a module whose whole job is to run once and call `process.exit` —
 * importing it here would end this file.
 */
const SCRIPT = join(import.meta.dir, "test-database.ts");
const ADDRESS = join(import.meta.dir, "test-database");

/** Run the preload in its own process and report what it did. */
async function attempt(url?: string) {
  /*
   * Built without the key rather than by removing it afterwards.
   *
   * `delete` is what the linter objects to, and its suggested fix —
   * `env.DATABASE_URL = undefined` — is a different test: the child would be
   * handed the key present and empty, which the preload treats as a set address
   * rather than an unset one. Absent has to mean absent.
   */
  const env = Object.fromEntries([
    ...Object.entries(process.env).filter(([k]) => k !== "DATABASE_URL"),
    ...(url === undefined ? [] : [["DATABASE_URL", url]]),
  ]) as Record<string, string>;

  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      // Printed after the import, so a refusal never reaches this line.
      `await import(${JSON.stringify(SCRIPT)}); console.log(process.env.DATABASE_URL ?? "")`,
    ],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, chose: stdout.trim(), said: stdout + stderr };
}

test("the address lives in one file, and this repository has one", () => {
  expect(existsSync(ADDRESS)).toBe(true);
  const line = readFileSync(ADDRESS, "utf8").trim();
  // Local, and named for a repository rather than shared between them.
  expect(line).toMatch(/^postgres:\/\/[^@]+@(localhost|127\.0\.0\.1):\d+\//);
  expect(line).toMatch(/\/sentrello_t_[a-z]+$/);
});

/**
 * Nothing set has to do the right thing.
 *
 * This is the half that matters most. A guard that only refuses leaves
 * everybody typing an address by hand, and an address typed by hand is the
 * thing that went wrong in the first place.
 */
test("nothing set picks this repository's own database", async () => {
  const { exitCode, chose } = await attempt(undefined);
  expect(exitCode).toBe(0);
  expect(chose).toBe(readFileSync(ADDRESS, "utf8").trim());
});

test("this repository's own database is allowed", async () => {
  const mine = readFileSync(ADDRESS, "utf8").trim();
  const { exitCode, chose } = await attempt(mine);
  expect(exitCode).toBe(0);
  expect(chose).toBe(mine);
});

/**
 * The retired shared database, which is the whole reason this exists.
 *
 * A run pointed at it reported 87 failures in modules nobody had touched, 85 of
 * them from one organization a killed run left behind.
 */
test("the retired shared database is refused, with the reason", async () => {
  const { exitCode, said } = await attempt(
    "postgres://sentrello:sentrello@localhost:5433/sentrello",
  );
  expect(exitCode).toBe(1);
  expect(said).toContain("shared sentrello database");
  // Said, not implied: a message that only refuses costs another run.
  expect(said).toContain("Unset DATABASE_URL");
});

/** Matched at the end of the path, so the right database is not caught by it. */
test("a name that merely starts with sentrello is not the shared one", async () => {
  const { exitCode } = await attempt(
    "postgres://sentrello:sentrello@localhost:5433/sentrello_t_somewhere",
  );
  expect(exitCode).toBe(0);
});

/** A query string after the name must not smuggle it past the match either. */
test("the shared database is still refused with parameters after it", async () => {
  const { exitCode, said } = await attempt(
    "postgres://sentrello:sentrello@localhost:5433/sentrello?sslmode=disable",
  );
  expect(exitCode).toBe(1);
  expect(said).toContain("shared sentrello database");
});

/**
 * The browser instance. Claiming it leaves an organization behind, and the
 * bootstrap tests then fail with 409s about nothing anybody changed.
 */
test("the dev database somebody looks at in a browser is refused", async () => {
  const { exitCode, said } = await attempt(
    "postgres://sentrello:sentrello@localhost:5433/sentrello_dev",
  );
  expect(exitCode).toBe(1);
  expect(said).toContain("sentrello_dev");
});

/** The suites truncate tables. Being wrong about where is not undoable. */
test("a database that is not on this machine is refused", async () => {
  const { exitCode, said } = await attempt(
    "postgres://sentrello:sentrello@db.example.com:5432/sentrello_t_core",
  );
  expect(exitCode).toBe(1);
  expect(said).toContain("not local");
});

/**
 * CI holds no exemption, and this is what says so.
 *
 * Every workflow used to run against a database named `sentrello` — safe there,
 * since the container is new each run — so the obvious shortcut was to spare
 * `process.env.CI`. The databases were renamed instead: a guard that spares one
 * thing is a guard with one place nothing looks.
 */
test("CI is not spared", async () => {
  const proc = Bun.spawn(
    ["bun", "-e", `await import(${JSON.stringify(SCRIPT)})`],
    {
      env: {
        ...process.env,
        CI: "true",
        GITHUB_ACTIONS: "true",
        DATABASE_URL: "postgres://sentrello:sentrello@localhost:5432/sentrello",
      } as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const exitCode = await proc.exited;
  expect(exitCode).toBe(1);
});
