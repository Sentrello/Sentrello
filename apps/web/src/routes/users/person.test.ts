import { expect, test } from "bun:test";
import { tabFromSearch } from "./person";

/**
 * `person.tsx` owns its own `?tab=` rather than routing it through
 * `navigation.tsx` — see the docstring on `tabFromSearch`. This imports the
 * real function rather than a copy, per Ruling 39 (`tabs.test.ts` is the
 * worked example): a test that restates the logic cannot fail when the real
 * one breaks.
 */

test("reads the tab named in the query string", () => {
  expect(tabFromSearch("?tab=access")).toBe("access");
});

test("a query string with other params still finds tab", () => {
  expect(tabFromSearch("?foo=bar&tab=groups")).toBe("groups");
});

test("no query string at all gives the empty string, not null or a guess", () => {
  expect(tabFromSearch("")).toBe("");
});

test("a query string naming no tab gives the empty string", () => {
  expect(tabFromSearch("?foo=bar")).toBe("");
});
