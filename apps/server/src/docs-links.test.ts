import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The links in the README and the documentation actually go somewhere.
 *
 * The README links into `docs/site/` by published URL, and `docs/site/` links
 * into itself by slug. Neither is checked by a compiler, and a page that was
 * renamed — or written but never linked from where the README says it is —
 * turns into a 404 on docs.sentrello.com with nothing in this repository
 * going red. This went wrong once; now it cannot go wrong quietly.
 *
 * The slug rules mirror how the documentation site publishes a repository:
 * a numeric ordering prefix (`02-core`) is stripped from every path segment,
 * `index.md` takes its directory's slug, and every other page is its
 * directory's slug plus its own name. `docs/site/02-core/money.md` is
 * `/docs/core/money`.
 */

const ROOT = join(import.meta.dir, "../../..");
const SITE = join(ROOT, "docs/site");
const DOCS_URL = /^https:\/\/docs\.sentrello\.com\/docs\/(.+)$/;

const stripPrefix = (segment: string) => segment.replace(/^\d+-/, "");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => relative(SITE, join(e.parentPath, e.name)));
}

function slugOf(path: string): string {
  const parts = path.replace(/\.md$/, "").split("/").map(stripPrefix);
  if (parts[parts.length - 1] === "index") parts.pop();
  return parts.join("/");
}

const pages = walk(SITE);
const slugs = new Set(pages.map(slugOf));

function linksIn(markdown: string): string[] {
  const targets: string[] = [];
  for (const match of markdown.matchAll(/\]\(([^)\s]+)\)|src="([^"]+)"/g)) {
    targets.push((match[1] ?? match[2]) as string);
  }
  return targets;
}

const readme = linksIn(readFileSync(join(ROOT, "README.md"), "utf8"));

test("every relative link in the README points at a file that exists", () => {
  const missing = readme
    .filter((t) => !/^(https?:|mailto:|#)/.test(t))
    .filter((t) => !Bun.file(join(ROOT, t.split("#")[0] as string)).size);
  expect(missing).toEqual([]);
});

test("every docs.sentrello.com link in the README has a source page", () => {
  const dangling = readme
    .map((t) => DOCS_URL.exec(t)?.[1]?.split("#")[0])
    .filter((slug): slug is string => slug !== undefined)
    .filter((slug) => !slugs.has(slug));
  expect(
    dangling,
    "the README links a documentation page docs/site does not contain",
  ).toEqual([]);
});

test("every internal link in the documentation resolves to a page", () => {
  const dangling: string[] = [];
  for (const page of pages) {
    for (const target of linksIn(readFileSync(join(SITE, page), "utf8"))) {
      if (!target.startsWith("/")) continue;
      const slug = (target.split("#")[0] as string).replace(/^\/|\/$/g, "");
      if (!slugs.has(slug)) dangling.push(`${page} -> ${target}`);
    }
  }
  expect(dangling).toEqual([]);
});

test("documentation images are absolute URLs, because only .md files sync", () => {
  // The site is published by syncing the repository's markdown; a relative
  // image path has nothing to resolve against once the page leaves the repo.
  const relativeImages: string[] = [];
  for (const page of pages) {
    for (const target of linksIn(readFileSync(join(SITE, page), "utf8"))) {
      if (
        /\.(png|gif|jpe?g|svg|webp)$/i.test(target) &&
        !/^https?:/.test(target)
      ) {
        relativeImages.push(`${page} -> ${target}`);
      }
    }
  }
  expect(relativeImages).toEqual([]);
});

test("every sidebar position is an integer, because the site stores one", () => {
  const bad: string[] = [];
  for (const page of pages) {
    const value = /^sidebar_position:\s*(\S+)/m.exec(
      readFileSync(join(SITE, page), "utf8"),
    )?.[1];
    if (value && !/^\d+$/.test(value)) bad.push(`${page}: ${value}`);
  }
  for (const entry of readdirSync(SITE, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const category = join(SITE, entry.name, "_category_.json");
    const position = JSON.parse(readFileSync(category, "utf8")).position;
    if (!Number.isInteger(position)) bad.push(`${entry.name}: ${position}`);
  }
  expect(bad).toEqual([]);
});
