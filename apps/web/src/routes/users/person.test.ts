import { expect, test } from "bun:test";
import { mostRecent, tabFromSearch } from "./person";

/**
 * `person.tsx` owns its own `?tab=` rather than routing it through
 * `navigation.tsx` — see the docstring on `tabFromSearch`. This imports the
 * real function rather than a copy (`tabs.test.tsx` is the
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

test("the most recent of two pages has no hole in it", () => {
  // Fifty this month as the actor, fifty last year as the subject: each
  // route's own newest fifty. The answer is this month's fifty alone.
  const day = (d: number) => new Date(Date.UTC(2026, 9, d)).toISOString();
  const acted = Array.from({ length: 50 }, (_, i) => ({
    id: `a-${i}`,
    at: day(30 - (i % 28)),
  }));
  const actedOn = Array.from({ length: 50 }, (_, i) => ({
    id: `s-${i}`,
    at: new Date(Date.UTC(2025, 0, 1 + i)).toISOString(),
  }));
  const shown = mostRecent(acted, actedOn, 50);
  expect(shown).toHaveLength(50);
  expect(shown.every((e) => e.id.startsWith("a-"))).toBe(true);
});
