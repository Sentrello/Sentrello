import { expect, test } from "bun:test";
/**
 * A request value coerced instead of checked, in either of the two shapes that
 * cost a day on 6 October.
 *
 * `String(body.name ?? "")` stores an object as the words "[object Object]" —
 * accepted by the driver, drawn on every screen, nothing failed. `Number([])`
 * is **0**, so an empty list sent where a price belongs passed every range
 * check in the product. Both are refused where they are read, by `asText` and
 * `asWholeNumber` in `@sentrello/db`, and the sweep is shared with Core rather
 * than retyped here.
 */
import { resolve } from "node:path";
import {
  WHY_NOT_NUMBER,
  WHY_NOT_STRING,
  coercedNumberSites,
  coercedTextSites,
  sourcesUnder,
} from "@sentrello/db/request-coercion-sweep";

const REPO = resolve(import.meta.dir, "../../..");
const WHERE = ["packages", "apps"];

test("there is source to sweep", () => {
  expect(sourcesUnder(REPO, WHERE).length).toBeGreaterThan(200);
});

test("no route flattens a request value into text with String()", () => {
  const offenders = coercedTextSites(REPO, WHERE);
  expect(
    offenders,
    `${WHY_NOT_STRING}:\n    ${offenders.join("\n    ")}`,
  ).toEqual([]);
});

test("and none turns one into a number with Number()", () => {
  const offenders = coercedNumberSites(REPO, WHERE);
  expect(
    offenders,
    `${WHY_NOT_NUMBER}:\n    ${offenders.join("\n    ")}`,
  ).toEqual([]);
});
