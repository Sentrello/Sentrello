import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A migration may add. From v1 it may not take away.
 *
 * Rollback is the whole safety net under an update: `sentrello rollback` puts
 * the *previous* release back against the database the newer one migrated, and
 * that only works while every migration is additive. Drop a column and the
 * older code selecting it fails on every request; drop a table and it fails at
 * boot. The customer is then holding a version that will not run and a version
 * they just rolled back from, which is the worst place an update can leave
 * somebody.
 *
 * Until now that was a sentence in the runbook asking whoever reviews a
 * release to check. This is the same rule, mechanised, over the core's
 * migrations; every repository with migrations carries a copy.
 *
 * **Taking a column out of the product is still allowed.** It goes in two
 * releases: stop reading it, ship, then drop it a release later, by which time
 * the version a rollback lands on no longer wants it. The block here is on
 * doing both at once.
 */
const here = join(import.meta.dir, "../drizzle");

/**
 * Written before the product had a single instance in the field.
 *
 * Every one of these is a real drop, and every one was safe for exactly one
 * reason: nobody was running the release it would have rolled back to. That
 * reason expires at v1, which is why they are listed by name rather than
 * pattern-matched away — a list somebody has to add to is a list somebody has
 * to think about.
 */
const BEFORE_ANY_INSTANCE: Record<string, string> = {
  "0002_steady_silver_sable.sql":
    "the organization id became text, when the auth library's own type was adopted",
  "0006_last_red_wolf.sql": "a deal's three first-draft columns",
  "0079_a_table_no_invoice_ever_read.sql":
    "credit_notes, which never had a reader — a credit note is an invoice row",
};

/** `DROP COLUMN`, `DROP TABLE`, a rename, or a type change that can narrow. */
const DESTRUCTIVE =
  /\b(?:DROP\s+(?:COLUMN|TABLE)|RENAME\s+(?:COLUMN|TO)|ALTER\s+COLUMN\s+\S+\s+SET\s+DATA\s+TYPE)\b/i;

/** Every migration in the repository. */
function migrations(): { name: string; sql: string }[] {
  return readdirSync(here)
    .filter((f) => f.endsWith(".sql"))
    .map((name) => ({ name, sql: readFileSync(join(here, name), "utf8") }));
}

test("there are migrations to read", () => {
  // A glob matching nothing passes every assertion under it.
  expect(migrations().length).toBeGreaterThan(100);
});

test("no migration takes something away that a rollback would want", () => {
  const destructive = migrations()
    .filter(({ sql }) =>
      // Comments explain; they do not run.
      sql
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .some((line) => DESTRUCTIVE.test(line)),
    )
    .map(({ name }) => name)
    .filter((name) => !(name in BEFORE_ANY_INSTANCE));

  expect(
    destructive,
    `these drop or rename something, so rolling back to the release before them leaves code reading a column that is gone:\n    ${destructive.join("\n    ")}\n\nSplit it across two releases, or add the file to BEFORE_ANY_INSTANCE with the reason if it truly predates every instance.`,
  ).toEqual([]);
});

test("every excused migration still exists", () => {
  /*
   * An excuse for a file nobody can find is an excuse that has outlived what
   * it excused — usually a rename, and the new name goes unchecked.
   */
  const gone = Object.keys(BEFORE_ANY_INSTANCE).filter(
    (name) => !existsSync(join(here, name)),
  );
  expect(gone).toEqual([]);
});
