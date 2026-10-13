import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DEFAULT_BASE_URL, baseUrl, configuredBaseUrl } from "./base-url";

/**
 * Every absolute link names the configured address, never the request's.
 *
 * See `base-url.ts` for the twelve places that took the Host header instead.
 */

const saved = process.env.SENTRELLO_BASE_URL;
afterEach(() => {
  if (saved === undefined)
    Reflect.deleteProperty(process.env, "SENTRELLO_BASE_URL");
  else process.env.SENTRELLO_BASE_URL = saved;
});

test("the configured address, trimmed, with no trailing slash", () => {
  process.env.SENTRELLO_BASE_URL = "  https://books.example//  ";
  expect(configuredBaseUrl()).toBe("https://books.example");
  expect(baseUrl()).toBe("https://books.example");
});

test("unset or empty is null to a job and the sign-in default to a screen", () => {
  for (const value of [undefined, "", "   ", "/"]) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, "SENTRELLO_BASE_URL");
    } else process.env.SENTRELLO_BASE_URL = value;
    expect(configuredBaseUrl()).toBeNull();
    expect(baseUrl()).toBe(DEFAULT_BASE_URL);
  }
});

/*
 * And nothing goes round it. A reader of the variable outside the helper is a
 * place that can pick its own fallback, and the fallback twelve of them
 * picked was the request's host.
 */
const root = join(import.meta.dir, "../../..");
const ALLOWED = new Set([
  // The helper itself.
  "packages/db/src/base-url.ts",
  // Normalises the variable at boot for the sibling repositories' readers.
  "apps/server/src/index.ts",
  // Compares an Origin with it; builds no link, and cannot import this package.
  "packages/module-sdk/src/public-endpoints.ts",
]);

test("no source reads the base address, or builds one from the request, except through the helper", () => {
  const offenders: string[] = [];
  for (const pattern of [
    "apps/*/src/**/*.{ts,tsx}",
    "packages/*/src/**/*.{ts,tsx}",
    "packages/modules-free/*/src/**/*.{ts,tsx}",
  ]) {
    for (const file of new Bun.Glob(pattern).scanSync({ cwd: root })) {
      const path = relative(root, join(root, file));
      if (/\.test\.tsx?$/.test(path) || ALLOWED.has(path)) continue;
      const text = readFileSync(join(root, file), "utf8");
      if (
        text.includes("process.env.SENTRELLO_BASE_URL") ||
        // Taken as a value, not compared with: the settings screen asks
        // whether the two agree, and that is the right question.
        /(\?\?|[^=!]=)\s*new URL\(\s*(c\.req\.url|requestUrl)\s*\)\.origin/.test(
          text,
        )
      ) {
        offenders.push(path);
      }
    }
  }
  expect(offenders).toEqual([]);
});
