import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Does every door open onto something, and does every room have a door?
 *
 * A module's routes are TypeScript the host imports. Its screens are a bundle
 * the browser fetches. Nothing at runtime connects the two, so a nav id with
 * nothing behind it renders a blank panel — indistinguishable from a broken
 * one, and how `mod-links` came to ship its first commit with three doors onto
 * nothing. The Booking module shipped six.
 *
 * Three of the product's twelve bundles checked this when it was counted on
 * 25 September, and each had written its own copy. That is the arrangement
 * that cost the modules repository nine drifted copies of the drift walk, so
 * the answer lives here once and the bundles ask it.
 *
 * ## The regex, which is the part that bites
 *
 * The three hand-written copies matched `registerScreen("…")` and nothing
 * else. Run against the modules repository that form reported six doors onto
 * nothing in `mod-newsletter` which do not exist: it registers its settings
 * pages in a loop, as ``registerScreen(`newsletter-settings-${id}`, …)``.
 * A guard that cries wolf is a guard somebody deletes, so a dynamic
 * registration is recorded as a prefix and ids under it count as drawn.
 */

/** Every `.tsx` a bundle's UI directory holds, as one string. */
export function uiSource(dir: string): string {
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("\n");
}

/** What a bundle draws: the ids it names, and the families it builds. */
export function screensDrawn(source: string): {
  named: Set<string>;
  draws: (id: string) => boolean;
} {
  const named = new Set(
    [...source.matchAll(/registerScreen\(\s*"([^"]+)"/g)].map(
      (m) => m[1] as string,
    ),
  );
  const families = [
    ...source.matchAll(/registerScreen\(\s*`([^`$]*)\$\{/g),
  ].map((m) => m[1] as string);
  return {
    named,
    draws: (id) =>
      named.has(id) || families.some((p) => p !== "" && id.startsWith(p)),
  };
}

/**
 * What a module asks the host to show, split into everything and the pages.
 *
 * An entry is a heading in the rail only when something else sits under it —
 * the host opens the first entry beneath a heading, so the heading itself
 * needs no screen. Everything else is a page and does.
 *
 * **Decided by what points at what, not by whether an entry has a parent.**
 * The first version asked the simpler question and was wrong for Storage,
 * which registers one top-level entry and nothing under it: that entry has no
 * parent and is nevertheless the only page the module has. Reading it as a
 * heading made the module look like it had no pages at all, which is a check
 * that passes by finding nothing.
 *
 * Both lists come back because the two directions want different ones: a door
 * with no room is asked of the pages, and a room with no door of all of them.
 */
export function navAsked(register: (spy: NavSpy) => void): {
  all: string[];
  pages: string[];
} {
  const entries: { id: string; parent?: string }[] = [];
  register((entry) => entries.push(entry));
  const headings = new Set(
    entries.map((e) => e.parent).filter((id): id is string => Boolean(id)),
  );
  return {
    all: entries.map((e) => e.id),
    pages: entries.filter((e) => !headings.has(e.id)).map((e) => e.id),
  };
}

export type NavSpy = (entry: { id: string; parent?: string }) => void;
