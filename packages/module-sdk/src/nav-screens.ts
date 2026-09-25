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
 * A parent is a heading in the rail, not a page — the host opens the first
 * entry under it — so only the children need a screen. Both lists are
 * returned because the two directions want different ones: a door with no
 * room is asked of the children, and a room with no door of all of them.
 */
export function navAsked(register: (spy: NavSpy) => void): {
  all: string[];
  pages: string[];
} {
  const all: string[] = [];
  const pages: string[] = [];
  register((entry) => {
    all.push(entry.id);
    if (entry.parent) pages.push(entry.id);
  });
  return { all, pages };
}

export type NavSpy = (entry: { id: string; parent?: string }) => void;
