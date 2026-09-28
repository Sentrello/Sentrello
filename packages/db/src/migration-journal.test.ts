import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

/**
 * Every migration in the journal has a snapshot beside it.
 *
 * Drizzle generates a migration by diffing the schema against the *last
 * snapshot*, not against the last migration. So a migration hand-written
 * into `_journal.json` without its `meta/NNNN_snapshot.json` is invisible
 * to the generator — and the next `db:generate` re-emits everything that
 * migration did, on top of it.
 *
 * That happened: `0099` was added without a snapshot, and `0100` came out
 * carrying a second `ALTER TABLE security_events ADD COLUMN seq`. Applied
 * in order, the deployment would have stopped on "column already exists",
 * on every instance, with the first migration half-applied.
 *
 * It was caught by reading the generated SQL. This is so the next one is
 * caught by the build.
 *
 * Only migrations that change the *shape* of the database are held to
 * this. A hand-written data migration — `0038` and `0039` are two, moving
 * staff roles and docs permissions into rows — alters no schema, so the
 * generator has nothing to repeat and a snapshot would say exactly what
 * the one before it said. Requiring one there would be a rule people
 * learn to satisfy rather than a rule that catches anything.
 */
const CHANGES_THE_SCHEMA =
  /^\s*(ALTER TABLE .*(ADD|DROP|ALTER) COLUMN|CREATE TABLE|DROP TABLE|ALTER TABLE .*ADD CONSTRAINT|CREATE TYPE|ALTER TYPE)/im;
const DIR = `${import.meta.dir}/../drizzle`;

test("every migration in the journal has a snapshot", () => {
  const journal = JSON.parse(
    readFileSync(`${DIR}/meta/_journal.json`, "utf8"),
  ) as { entries: { idx: number; tag: string }[] };

  const snapshots = new Set(
    readdirSync(`${DIR}/meta`)
      .filter((f) => f.endsWith("_snapshot.json"))
      .map((f) => f.slice(0, 4)),
  );

  /*
   * Only what comes *after* the newest snapshot can be repeated.
   *
   * The generator diffs against the latest snapshot, so a schema change
   * older than that is already described by it — `0099` has no snapshot
   * of its own, and `0100`'s includes its column, which is why the next
   * generate is correct again. What is dangerous is a schema change with
   * nothing after it to fold it in.
   */
  const newest = Math.max(
    ...[...snapshots]
      .map((i) => Number.parseInt(i, 10))
      .filter(Number.isFinite),
  );

  const missing = journal.entries
    .filter((e) => e.idx > newest)
    .filter((e) =>
      CHANGES_THE_SCHEMA.test(readFileSync(`${DIR}/${e.tag}.sql`, "utf8")),
    )
    .map((e) => e.tag);

  expect(
    missing,
    `these migrations have no snapshot, so the next generated migration will repeat what they did:\n    ${missing.join("\n    ")}`,
  ).toEqual([]);
});

/** And the file each journal entry names is actually there. */
test("every migration in the journal has its SQL file", () => {
  const journal = JSON.parse(
    readFileSync(`${DIR}/meta/_journal.json`, "utf8"),
  ) as { entries: { tag: string }[] };

  const files = new Set(readdirSync(DIR).filter((f) => f.endsWith(".sql")));
  const missing = journal.entries
    .map((e) => `${e.tag}.sql`)
    .filter((f) => !files.has(f));

  expect(missing, `named in the journal and not on disk: ${missing}`).toEqual(
    [],
  );
});
