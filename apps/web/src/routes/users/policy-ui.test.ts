import { expect, test } from "bun:test";
import { statement } from "@sentrello/auth/permissions";
import { HIDDEN, RESOURCES } from "./policy-ui";

/**
 * The access screen draws every resource a business manages.
 *
 * It used to filter out `hr`, `inventory` and `time`, which the statement
 * carried for withdrawn modules and nothing guarded, and missed `make-deal`,
 * which it drew. Those names have left the statement now, and
 * `packages/auth/src/statement-is-guarded.test.ts` fails on any resource that
 * nothing checks, so the screen needs no list of its own.
 */
test("draws the resources that are real", () => {
  const drawn = RESOURCES.map((r) => r.name);
  // A sample rather than the whole list: this is here so a `HIDDEN` that
  // swallowed too much fails rather than quietly emptying the screen an owner
  // manages access on.
  for (const name of ["crm", "invoicing", "settings", "archive"]) {
    expect(drawn).toContain(name);
  }
  expect(drawn.length).toBeGreaterThan(8);
  for (const name of HIDDEN) expect(drawn).not.toContain(name);
});

/**
 * A name in `HIDDEN` that is not in the statement was renamed or removed, and
 * the filter for it has quietly stopped filtering.
 */
test("every name filtered out is a name the statement has", () => {
  const known = Object.keys(statement);
  for (const name of HIDDEN) expect(known).toContain(name);
});
