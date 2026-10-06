import { expect, test } from "bun:test";
/**
 * `String(body.x)` is how "[object Object]" gets into a book.
 *
 * The rule has two halves and both were learned the hard way on 6 October. A
 * write guard on the database handle catches an object that *reaches* it — and
 * it caught nothing for the commonest shape in this repository, because
 * `String(body.name ?? "")` flattens the object on the way and hands over an
 * ordinary string that happens to read "[object Object]". A test through the
 * real server said 201 where it expected 400, which is the only reason this is
 * known.
 *
 * So the coercion is the thing to keep out: `asText(body.name, "name")`
 * refuses an object and a plain array, and the error handler answers 400
 * naming the field. This is the half that stays true after the next route is
 * written, because the alternative — remembering — was measured at 4 routes
 * out of 31.
 */
import { resolve } from "node:path";
import {
  WHY_NOT_STRING,
  coercedTextSites,
  sourcesUnder,
} from "./text-coercion-sweep";

const REPO = resolve(import.meta.dir, "../../..");
const WHERE = ["packages/modules-free", "apps/server/src"];

test("there is source to sweep", () => {
  expect(sourcesUnder(REPO, WHERE).length).toBeGreaterThan(100);
});

test("no route flattens a request value into text with String()", () => {
  const offenders = coercedTextSites(REPO, WHERE);
  expect(
    offenders,
    `${WHY_NOT_STRING}:\n    ${offenders.join("\n    ")}`,
  ).toEqual([]);
});
