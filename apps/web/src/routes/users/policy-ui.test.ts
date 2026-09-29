import { expect, test } from "bun:test";
import { statement } from "@sentrello/auth/permissions";
import { HIDDEN, NOT_BUILT, RESOURCES } from "./policy-ui";

/**
 * The access screen offers nothing that cannot be held.
 *
 * Found by asking, of every permission a route requires anywhere in the three
 * product repositories, whether it can be granted — and then the same question
 * backwards. Forwards the answer was clean. Backwards it was three: `hr`,
 * `inventory` and `time` are in the statement, drawn as tick boxes on Policies
 * and on the Access matrix, and guarded by not one route in any repository.
 *
 * So an administrator could grant "HR: approve" to a role and nothing in the
 * product would ever ask for it. Worse than a missing switch: it reads as a
 * feature, and the person who ticked it believes somebody can now do something.
 *
 * The statement keeps the names deliberately — a policy stored before a module
 * was withdrawn may still grant them, and dropping the name would refuse the
 * whole policy — so the filter is here, where the screen is built.
 */
test("the screen draws no resource that nothing guards", () => {
  const drawn = RESOURCES.map((r) => r.name);
  for (const name of NOT_BUILT) expect(drawn).not.toContain(name);
});

test("and still draws the ones that are real", () => {
  const drawn = RESOURCES.map((r) => r.name);
  // A sample rather than the whole list: this is here so a filter that grew
  // teeth — an over-broad `NOT_BUILT`, a `HIDDEN` that swallowed too much —
  // fails rather than quietly emptying the screen an owner manages access on.
  for (const name of ["crm", "invoicing", "settings", "archive"]) {
    expect(drawn).toContain(name);
  }
  expect(drawn.length).toBeGreaterThan(8);
});

/**
 * Both filters only ever name something real.
 *
 * A name in either set that is not in the statement is a name that was renamed
 * or removed, and the filter for it has quietly stopped filtering — which on
 * `NOT_BUILT` means three fictional modules back on the screen, and nothing
 * saying so.
 */
test("every name filtered out is a name the statement has", () => {
  const known = Object.keys(statement);
  for (const name of [...HIDDEN, ...NOT_BUILT]) expect(known).toContain(name);
});
