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
  WHY_NOT_DEFAULTED,
  WHY_NOT_FLAG,
  WHY_NOT_GUESSED,
  WHY_NOT_NUMBER,
  WHY_NOT_STRING,
  coercedFlagSites,
  coercedNumberSites,
  coercedTextSites,
  defaultedChoiceSites,
  guessedShapeSites,
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

test("the sweep sees a field chosen at run time, not only one named", () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const repo = mkdtempSync(join(tmpdir(), "sweep-"));
  mkdirSync(join(repo, "src"));
  writeFileSync(
    join(repo, "src", "route.ts"),
    'const a = String(body[name] ?? "");\nconst b = Number(payload[field]);\n',
  );
  expect(coercedTextSites(repo, ["src"])).toEqual(["src/route.ts:1"]);
  expect(coercedNumberSites(repo, ["src"])).toEqual(["src/route.ts:2"]);
});

test("and no choice turns a word nobody offered into the default", () => {
  const offenders = defaultedChoiceSites(REPO, WHERE);
  expect(
    offenders,
    `${WHY_NOT_DEFAULTED}:\n    ${offenders.join("\n    ")}`,
  ).toEqual([]);
});

test("the choice sweep sees both shapes, across a line break too", () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const repo = mkdtempSync(join(tmpdir(), "sweep-"));
  mkdirSync(join(repo, "src"));
  writeFileSync(
    join(repo, "src", "route.ts"),
    [
      'const a = body.visibility === "public" ? "public" : "private";',
      "const b = KINDS.includes(body.kind as Kind)",
      '  ? body.kind : "text";',
      'const c = asChoice(body.kind, "kind", KINDS, "text");',
      "if (!KINDS.includes(body.kind)) throw new Error();",
    ].join("\n"),
  );
  expect(defaultedChoiceSites(repo, ["src"])).toEqual([
    "src/route.ts:1",
    "src/route.ts:2",
  ]);
});

test("and no flag is read by comparing it with true or false", () => {
  const offenders = coercedFlagSites(REPO, WHERE);
  expect(
    offenders,
    `${WHY_NOT_FLAG}:\n    ${offenders.join("\n    ")}`,
  ).toEqual([]);
});

test("the flag sweep sees all three spellings, and not the fix", () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const repo = mkdtempSync(join(tmpdir(), "sweep-"));
  mkdirSync(join(repo, "src"));
  writeFileSync(
    join(repo, "src", "route.ts"),
    [
      "const a = body.archived === true;",
      "const b = !!payload.enabled;",
      'const c = typeof body.active === "boolean" ? body.active : row.active;',
      'const d = asFlag(body.archived, "archived", false);',
      "const e = answer.valid === true;",
    ].join("\n"),
  );
  expect(coercedFlagSites(repo, ["src"])).toEqual([
    "src/route.ts:1",
    "src/route.ts:2",
    "src/route.ts:3",
  ]);
});

test("and none reads a value only when it is already the right type", () => {
  const offenders = guessedShapeSites(REPO, WHERE);
  expect(
    offenders,
    `${WHY_NOT_GUESSED}:\n    ${offenders.join("\n    ")}`,
  ).toEqual([]);
});

test("the shape sweep sees text, numbers and a run-time field, and not a refusal", () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const repo = mkdtempSync(join(tmpdir(), "sweep-"));
  mkdirSync(join(repo, "src"));
  writeFileSync(
    join(repo, "src", "route.ts"),
    [
      'const a = typeof body.email === "string" ? body.email : null;',
      "const b = Number.isInteger(body.seats) ? body.seats : 1;",
      "if (Number.isFinite(payload[field])) patch[field] = payload[field];",
      'if (typeof body?.position === "number") patch.position = body.position;',
      'if (typeof body.name !== "string") throw new Error();',
      "if (!Number.isInteger(body.seats)) throw new Error();",
      'const c = asTextOrNothing(body.email, "email");',
      'const d = typeof answer.error === "string" ? answer.error : "";',
    ].join("\n"),
  );
  expect(guessedShapeSites(repo, ["src"])).toEqual([
    "src/route.ts:1",
    "src/route.ts:2",
    "src/route.ts:3",
    "src/route.ts:4",
  ]);
});
