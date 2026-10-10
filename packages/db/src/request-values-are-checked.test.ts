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
/*
 * The sweep parses every file and follows values between them — about a
 * second here, once, shared by the five questions below. Said out loud
 * because the shared builder is many times slower than a laptop, and a guard
 * that fails on a busy box rather than on a bug teaches people to skip it.
 */
const SWEEP_TIMEOUT = 60_000;
const WHERE = ["packages", "apps"];

test("there is source to sweep", () => {
  expect(sourcesUnder(REPO, WHERE).length).toBeGreaterThan(200);
});

test(
  "no route flattens a request value into text with String()",
  () => {
    const offenders = coercedTextSites(REPO, WHERE);
    expect(
      offenders,
      `${WHY_NOT_STRING}:\n    ${offenders.join("\n    ")}`,
    ).toEqual([]);
  },
  SWEEP_TIMEOUT,
);

test(
  "and none turns one into a number with Number()",
  () => {
    const offenders = coercedNumberSites(REPO, WHERE);
    expect(
      offenders,
      `${WHY_NOT_NUMBER}:\n    ${offenders.join("\n    ")}`,
    ).toEqual([]);
  },
  SWEEP_TIMEOUT,
);

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

test(
  "and no choice turns a word nobody offered into the default",
  () => {
    const offenders = defaultedChoiceSites(REPO, WHERE);
    expect(
      offenders,
      `${WHY_NOT_DEFAULTED}:\n    ${offenders.join("\n    ")}`,
    ).toEqual([]);
  },
  SWEEP_TIMEOUT,
);

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

test(
  "and no flag is read by comparing it with true or false",
  () => {
    const offenders = coercedFlagSites(REPO, WHERE);
    expect(
      offenders,
      `${WHY_NOT_FLAG}:\n    ${offenders.join("\n    ")}`,
    ).toEqual([]);
  },
  SWEEP_TIMEOUT,
);

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

test(
  "and none reads a value only when it is already the right type",
  () => {
    const offenders = guessedShapeSites(REPO, WHERE);
    expect(
      offenders,
      `${WHY_NOT_GUESSED}:\n    ${offenders.join("\n    ")}`,
    ).toEqual([]);
  },
  SWEEP_TIMEOUT,
);

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

/**
 * A request value under another name, which is how the five sweeps above were
 * walked past for as long as they read spellings: `raw`, a destructured
 * `{ method }`, a form's `form.get`, and a body handed to a helper in another
 * file whose parameter was called `input`. Each is seen here, and the things
 * that only look like one are not.
 */
test("the sweep follows a request value under any name, into a helper too", () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const repo = mkdtempSync(join(tmpdir(), "sweep-"));
  mkdirSync(join(repo, "src"));
  writeFileSync(
    join(repo, "src", "route.ts"),
    [
      'import { normalize } from "./helper";',
      'app.post("/a", async (c) => {',
      "  const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;",
      '  const zone = typeof raw.timezone === "string" ? raw.timezone : "";',
      "  const { method, early } = await c.req.json();",
      "  const taking = early === true;",
      "  const form = await c.req.formData();",
      '  const alt = String(form.get("alt") ?? "");',
      "  const hours = raw.workingHours as Record<string, unknown>;",
      "  const start = Number(hours.start);",
      "  normalize(raw.preferences);",
      '  const ok = asTextOrNothing(raw.name, "name");',
      "});",
      "async function elsewhere() {",
      "  const reply = await fetch(url).then((r) => r.json());",
      "  const body = await reply.json();",
      '  const said = typeof reply.error === "string" ? reply.error : "";',
      "}",
    ].join("\n"),
  );
  writeFileSync(
    join(repo, "src", "helper.ts"),
    [
      "export function normalize(input: unknown) {",
      "  const prefs = (input ?? {}) as Record<string, unknown>;",
      '  return typeof prefs.currency === "string" ? prefs.currency : "";',
      "}",
      "export function unrelated(input: unknown) {",
      '  return typeof input === "string" ? input : "";',
      "}",
    ].join("\n"),
  );
  expect(guessedShapeSites(repo, ["src"])).toEqual([
    "src/helper.ts:3",
    "src/route.ts:4",
  ]);
  expect(coercedFlagSites(repo, ["src"])).toEqual(["src/route.ts:6"]);
  expect(coercedTextSites(repo, ["src"])).toEqual(["src/route.ts:8"]);
  expect(coercedNumberSites(repo, ["src"])).toEqual(["src/route.ts:10"]);
});

test("a value checked on the way in, or only asked about, is not followed", () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const repo = mkdtempSync(join(tmpdir(), "sweep-"));
  mkdirSync(join(repo, "src"));
  writeFileSync(
    join(repo, "src", "route.ts"),
    [
      'app.post("/a", async (c) => {',
      "  const raw = await c.req.json();",
      '  cleanDomain(asTextOrNothing(raw.domain, "domain"));',
      "  if (!isKind(raw.kind)) throw new Error();",
      '  const kind = isKind(raw.kind) ? raw.kind : "text";',
      "});",
      "function cleanDomain(input: string | null) {",
      '  return typeof input === "string" ? input : null;',
      "}",
      "const isKind = (value: unknown): value is string =>",
      '  typeof value === "string" && value in KINDS;',
      "function refuse(value: unknown) {",
      '  throw new Error(`"${String(value)}" is not a date`);',
      "}",
    ].join("\n"),
  );
  expect(guessedShapeSites(repo, ["src"])).toEqual(["src/route.ts:5"]);
  expect(coercedTextSites(repo, ["src"])).toEqual([]);
});

test("and into each element of a list the request sent", () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const repo = mkdtempSync(join(tmpdir(), "sweep-"));
  mkdirSync(join(repo, "src"));
  writeFileSync(
    join(repo, "src", "route.ts"),
    [
      'app.post("/a", async (c) => {',
      "  const raw = await c.req.json();",
      "  const lines = Array.isArray(raw.lines) ? raw.lines : [];",
      "  for (const line of lines) {",
      "    const words = String(line.description);",
      "  }",
      "  raw.parts.map((part) => Number(part.shareBp));",
      "  [1, 2].map((n) => Number(n));",
      "});",
    ].join("\n"),
  );
  expect(coercedTextSites(repo, ["src"])).toEqual(["src/route.ts:5"]);
  expect(coercedNumberSites(repo, ["src"])).toEqual(["src/route.ts:7"]);
});

test("and into an object a request value was copied into unread", () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const repo = mkdtempSync(join(tmpdir(), "sweep-"));
  mkdirSync(join(repo, "src"));
  writeFileSync(
    join(repo, "src", "route.ts"),
    [
      'app.patch("/a", async (c) => {',
      "  const body = await c.req.json();",
      "  const patch: Record<string, unknown> = {};",
      '  for (const field of ["seats", "priceCents"]) patch[field] = body[field];',
      "  const price = Number(patch.priceCents);",
      "  const checked: Record<string, unknown> = {};",
      '  checked.name = asText(body.name, "name");',
      "  const name = String(checked.name);",
      "});",
    ].join("\n"),
  );
  expect(coercedNumberSites(repo, ["src"])).toEqual(["src/route.ts:5"]);
  expect(coercedTextSites(repo, ["src"])).toEqual([]);
});
