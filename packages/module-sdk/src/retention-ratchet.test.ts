import { expect, test } from "bun:test";
import type { RegisteredRetention } from "./index";
import {
  addRetention,
  classifySchema,
  clearRetention,
  declareClassification,
  retentionPolicies,
} from "./index";

/**
 * The ratchet, where it cannot be skipped.
 *
 * `classifySchema` is the decision — every table in a repository's schema is
 * either evidence of money or it is not, and a table added tomorrow is in
 * neither list until a person has looked at it. It only ever held where
 * somebody remembered to call it. Core asserts its own coverage in its own
 * suite and nothing in Core could prove that another repository did the same;
 * a repository that never called it looked exactly like one that called it
 * and passed. "Protected where we remembered" is not a guarantee, and the
 * tables it was not protecting were records of money taken at a till, sold
 * from a shop and billed by subscription.
 *
 * So the declaration is what `addRetention` consults. A policy pointed at a
 * table no repository has placed does not register — it throws, at load, in
 * the running instance rather than on a build machine, naming the table and
 * what to do about it. A repository that has not classified its schema cannot
 * sweep anything, which is the only version of this that cannot be forgotten.
 */

const table = (name: string, schema?: string) =>
  ({
    [Symbol.for("drizzle:Name")]: name,
    ...(schema ? { [Symbol.for("drizzle:Schema")]: schema } : {}),
  }) as unknown as RegisteredRetention["table"];

const policy = (id: string, t: RegisteredRetention["table"]) =>
  ({
    moduleId: "ledger-of-somewhere-else",
    id,
    label: "A log",
    table: t,
    clock: {},
    window: () => ({ removeAfterDays: 90 }),
  }) as unknown as RegisteredRetention;

test("a repository that has not classified its schema cannot sweep anything", () => {
  clearRetention();
  const theirs = table("takings", "till_of_a_repository_core_cannot_see");

  expect(() => addRetention(policy("nightly", theirs))).toThrow(
    /no repository has classified/,
  );
  // And the refusal says what to do, because the person reading it is in
  // another repository and cannot see this file.
  expect(() => addRetention(policy("nightly", theirs))).toThrow(
    /declareClassification/,
  );
  expect(retentionPolicies()).toHaveLength(0);
});

test("declaring the schema is what lets its policies register", () => {
  clearRetention();
  const name = "day_book_of_a_repository_core_cannot_see";
  const theirs = table(name, "till");

  expect(() => addRetention(policy("nightly", theirs))).toThrow(
    /no repository has classified/,
  );

  declareClassification({ dayBook: theirs }, [`till.${name}`]);
  addRetention(policy("nightly", theirs));
  expect(retentionPolicies()).toHaveLength(1);
  clearRetention();
});

/**
 * And a gap is not a boot failure.
 *
 * One table nobody has placed yet refuses the policy pointed at *that* table
 * and nothing else. Declaring returns the gaps for the repository's own suite
 * to assert — the same three lists `classifySchema` always gave back — rather
 * than taking a customer's instance down at start-up over a table no policy
 * touches.
 */
test("an unclassified table refuses its own policy, not the whole instance", () => {
  clearRetention();
  const placed = table("bookings_of_a_repository_core_cannot_see", "diary");
  const forgotten = table("notes_of_a_repository_core_cannot_see", "diary");

  const gaps = declareClassification({ placed, forgotten }, [
    "diary.bookings_of_a_repository_core_cannot_see",
  ]);
  expect(gaps.unclassified).toEqual([
    "diary.notes_of_a_repository_core_cannot_see",
  ]);
  expect(gaps.checked).toBe(2);

  addRetention(policy("sound", placed));
  expect(() => addRetention(policy("unlooked-at", forgotten))).toThrow(
    /no repository has classified/,
  );
  expect(retentionPolicies()).toHaveLength(1);
  clearRetention();
});

/** Nothing to classify is a caller pointed at the wrong object, not a pass. */
test("a classification that examined no tables is refused at the source", () => {
  expect(() => classifySchema({}, [])).toThrow(/no tables/);
  expect(() => declareClassification({ notATable: 1 }, [])).toThrow(
    /no tables/,
  );
});
