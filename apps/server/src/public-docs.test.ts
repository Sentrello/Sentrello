import { expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * What is allowed to sit in `docs/` at the top level of this repository.
 *
 * This repository is public. The design notes each module is built from — the
 * parity audits — are not: they describe what was studied, what was taken and
 * what was deliberately left, module by module. That is the most useful
 * document in the project and the one least suited to being world-readable,
 * so it lives outside every repository.
 *
 * Five of them were here until 2026-09-07. They came out on James's
 * instruction, and the rule holds for every platform or module build after
 * this one: the audit is written, and it is written somewhere private.
 *
 * A test rather than a note in CLAUDE.md, because the note has been true for a
 * while and the files were here anyway. The failure mode is not somebody
 * disagreeing with the rule, it is somebody writing `docs/booking.md` on a
 * Friday without thinking about it.
 *
 * `docs/site/` is deliberately not covered: it is the published product
 * documentation, written for customers, and belongs in the open.
 */
const ALLOWED = new Set(["self-hosting.md"]);

test("only self-hosting.md sits at the top of docs", () => {
  const dir = join(import.meta.dir, "../../../docs");
  const loose = readdirSync(dir).filter(
    (name) => name.endsWith(".md") && !statSync(join(dir, name)).isDirectory(),
  );

  // The list emptying would pass this without checking anything, and the file
  // it names is the one a self-hoster actually needs.
  expect(loose).toContain("self-hosting.md");

  const unexpected = loose.filter((name) => !ALLOWED.has(name));
  expect(
    unexpected,
    "design notes and parity audits belong in ~/Documents/Sentrello-Private/audits, not in a public repository",
  ).toEqual([]);
});
