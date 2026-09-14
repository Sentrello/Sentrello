import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `contractorTaxDetails` is a Pro-only table, and this Free package must
 * never query it — not directly, and not by keeping a file around that once
 * did. The registration itself now lives in `contractors.ts`, which left
 * for the paid bundle; the tests proving the registration
 * still works on both a Free and a Pro instance travelled with it.
 */

test("the Free package no longer names the Pro-only contractor table", () => {
  const path = join(import.meta.dir, "personal-data.ts");
  // Either the file is gone entirely, or — if it still exists for some other
  // reason — it must not reference the table it never should have queried.
  if (!existsSync(path)) return;
  expect(readFileSync(path, "utf8")).not.toContain("contractorTaxDetails");
});
