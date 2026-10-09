import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Three ways a migration quietly does not happen, all found on one day.
 *
 * Drizzle keeps two records of the same thing: `_journal.json`, which the
 * migrator reads, and `meta/NNNN_snapshot.json`, which the *generator*
 * diffs against. Neither is the directory listing. So a migration can be
 * on disk and not run, or run and be invisible to the generator, and in
 * both cases every command reports success.
 *
 * On 27 September 2026 all three failures were live at once across the
 * repositories:
 *
 *  - **A file in no journal never runs.** A migration that nulls a column
 *    of full referring URLs was written, applied by hand, reported as
 *    done, and had never run on any instance. A privacy fix that silently
 *    does not happen is worse than one nobody wrote, because everybody
 *    believes it.
 *  - **A schema change with no snapshot gets repeated.** `0099` here added
 *    a column that way, and the next generated migration carried a second
 *    `ADD COLUMN seq`. In order that stops on "column already exists", on
 *    every instance, with the first migration half-applied. The same trap
 *    was found four more times in the modules.
 *  - **A journal entry with no file** is a migration list that cannot be
 *    replayed at all.
 *
 * Every repository with migrations carries a copy of this file, and it
 * walks every journal it can find rather than one — the modules keep nine
 * between them.
 */

/** Anything holding a `drizzle/meta/_journal.json`, however it is nested. */
function journals(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "node_modules" || name === ".git" || name === "dist")
        continue;
      const full = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      if (name === "meta") {
        const j = join(full, "_journal.json");
        try {
          statSync(j);
          found.push(j);
        } catch {
          /* a meta directory with no journal is not one of ours */
        }
      }
      walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

const REPO = resolve(import.meta.dir, "../../..");
const ALL = journals(REPO);

/** A repository that has stopped being scanned is a guard that passes blind. */
test("there are migration journals to check", () => {
  expect(ALL.length).toBeGreaterThan(0);
});

const CHANGES_THE_SCHEMA =
  /^\s*(ALTER TABLE .*(ADD|DROP|ALTER) COLUMN|CREATE TABLE|DROP TABLE|ALTER TABLE .*ADD CONSTRAINT|CREATE TYPE|ALTER TYPE|CREATE SCHEMA|ALTER TABLE .*SET SCHEMA)/im;

interface Entry {
  idx: number;
  tag: string;
  when: number;
}

function read(journal: string): { dir: string; entries: Entry[] } {
  const dir = dirname(dirname(journal));
  const { entries } = JSON.parse(readFileSync(journal, "utf8")) as {
    entries: Entry[];
  };
  return { dir, entries };
}

const sqlFiles = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.replace(/\.sql$/, ""));

test("no migration file is missing from its journal", () => {
  const orphans: string[] = [];
  for (const journal of ALL) {
    const { dir, entries } = read(journal);
    const named = new Set(entries.map((e) => e.tag));
    for (const tag of sqlFiles(dir)) {
      if (!named.has(tag)) orphans.push(`${dir}/${tag}.sql`);
    }
  }
  expect(
    orphans,
    `on disk and in no journal, so they will never run:\n    ${orphans.join("\n    ")}`,
  ).toEqual([]);
});

/**
 * The migrator applies only what is newer than the last migration it ran,
 * judged by `when`. A hand-written entry stamped later than the one generated
 * after it made every database that had run the first skip the second for
 * good, with "migrations applied" printed over the top.
 */
test("every journal entry is stamped later than the one before it", () => {
  const backwards: string[] = [];
  for (const journal of ALL) {
    const { dir, entries } = read(journal);
    for (let i = 1; i < entries.length; i++) {
      const before = entries[i - 1] as Entry;
      const entry = entries[i] as Entry;
      if (entry.when <= before.when) {
        backwards.push(`${dir}: ${entry.tag} is not later than ${before.tag}`);
      }
    }
  }
  expect(
    backwards,
    `a database that ran the earlier one will never run these:\n    ${backwards.join("\n    ")}`,
  ).toEqual([]);
});

test("every journal entry has its SQL file", () => {
  const missing: string[] = [];
  for (const journal of ALL) {
    const { dir, entries } = read(journal);
    const present = new Set(sqlFiles(dir));
    for (const e of entries) {
      if (!present.has(e.tag)) missing.push(`${dir}/${e.tag}.sql`);
    }
  }
  expect(missing, `named in a journal and not on disk: ${missing}`).toEqual([]);
});

test("every schema change newer than the latest snapshot has a snapshot", () => {
  const missing: string[] = [];
  for (const journal of ALL) {
    const { dir, entries } = read(journal);
    const snapshots = readdirSync(join(dir, "meta"))
      .filter((f) => f.endsWith("_snapshot.json"))
      .map((f) => Number.parseInt(f.slice(0, 4), 10))
      .filter(Number.isFinite);
    if (snapshots.length === 0) continue;
    const newest = Math.max(...snapshots);

    /*
     * Only what comes after the newest snapshot can be repeated: the
     * generator diffs against that one, so an older change is already
     * described by it. And only a change of *shape* counts — a data
     * migration has nothing for the generator to repeat, and a rule that
     * fires on those is one people learn to satisfy rather than one that
     * catches anything.
     */
    for (const e of entries.filter((x) => x.idx > newest)) {
      let sql = "";
      try {
        sql = readFileSync(join(dir, `${e.tag}.sql`), "utf8");
      } catch {
        continue;
      }
      if (CHANGES_THE_SCHEMA.test(sql)) missing.push(`${dir}/${e.tag}.sql`);
    }
  }
  expect(
    missing,
    `no snapshot, so the next generated migration will repeat them:\n    ${missing.join("\n    ")}`,
  ).toEqual([]);
});
