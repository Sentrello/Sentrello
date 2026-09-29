import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Every picture the documentation shows, and every page it links to, exists.
 *
 * The published documentation is served **live from this repository** — a
 * correction pushed here is on docs.sentrello.com within the minute, which was
 * checked on 2026-09-29 against four sentences corrected that morning. The same
 * immediacy is why a renamed image is not a stale page somebody will notice at
 * the next release: it is a broken image on a customer's screen straight away,
 * on a page selling the feature it illustrates.
 *
 * The links are absolute `raw.githubusercontent.com` URLs rather than relative
 * paths, because the pages are rendered by the Docs module on another host and a
 * relative path there resolves to nothing. That is the right shape and it is
 * also what makes the reference unverifiable by every ordinary tool: no editor,
 * no bundler and no markdown linter will tell you the file went.
 *
 * So this reads the name out of the URL and looks for it on disk. Offline on
 * purpose — a test that fetched GitHub would be slower, would fail on a train,
 * and would be checking GitHub rather than checking us.
 */
const root = join(import.meta.dir, "..", "..", "..");
const site = join(root, "docs", "site");
const images = join(root, "docs", "images");

/** Every markdown page under docs/site, at any depth. */
function pages(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) pages(path, out);
    else if (name.endsWith(".md") || name.endsWith(".mdx")) out.push(path);
  }
  return out;
}

const RAW = /https:\/\/raw\.githubusercontent\.com\/[^\s)"']+/g;

interface Reference {
  url: string;
  page: string;
}

function referenced(): Reference[] {
  const found: Reference[] = [];
  for (const page of pages(site)) {
    const text = readFileSync(page, "utf8");
    for (const [url] of text.matchAll(RAW)) {
      found.push({ url, page: page.slice(root.length + 1) });
    }
  }
  return found;
}

test("the documentation references some images at all", () => {
  // A regex that matched nothing would pass every assertion below while
  // checking nothing — which is the failure this repository keeps finding.
  expect(referenced().length).toBeGreaterThan(5);
});

test("every image the documentation shows is in this repository", () => {
  const missing = referenced()
    .filter(({ url }) => url.includes("/docs/images/"))
    .filter(
      ({ url }) =>
        !existsSync(join(images, url.split("/docs/images/")[1] ?? "")),
    )
    .map(({ url, page }) => `${page} → ${url.split("/").pop()}`);

  expect(missing).toEqual([]);
});

/**
 * And each one points at this repository's own `main`.
 *
 * A URL naming a fork, a branch or a tag looks identical in the source and in
 * the rendered page, and goes stale on its own schedule. `main` is what the
 * pages are published from.
 */
test("every image link points at this repository's main", () => {
  const wrong = referenced()
    .filter(
      ({ url }) =>
        !url.startsWith(
          "https://raw.githubusercontent.com/Sentrello/Sentrello/main/",
        ),
    )
    .map(({ url, page }) => `${page} → ${url}`);

  expect(wrong).toEqual([]);
});

/**
 * And every page the documentation links to is a page that is there.
 *
 * Same reason as the images, same immediacy: the pages are served live, so a
 * renamed file is a customer following a link to nothing, now. Forty links
 * between forty-three pages, and they all resolved when this was written —
 * checked against the published site as well as on disk.
 *
 * The address is derived rather than declared. `docs/site/02-core/money.md` is
 * `/core/money`: the numeric prefixes order the sidebar and are not part of the
 * URL, and an `index.md` is the directory itself. That mapping is the Docs
 * module's, and writing it out here is the only way an offline check can know
 * where a link points.
 */
function addresses(): Set<string> {
  const out = new Set<string>();
  for (const page of pages(site)) {
    const parts = page
      .slice(site.length + 1)
      .split("/")
      .map((part) => part.replace(/^\d+-/, ""));
    const last = parts.pop()?.replace(/\.mdx?$/, "") ?? "";
    if (last !== "index") parts.push(last);
    out.add(`/${parts.join("/")}`);
  }
  return out;
}

/** `](/core/money)` — the documentation's own links, not external ones. */
const INTERNAL = /\]\((\/[a-z0-9/-]*)\)/g;

test("every page the documentation links to is a page it has", () => {
  const here = new Set([...addresses()].map((a) => a.replace(/\/$/, "")));
  const broken: string[] = [];
  let found = 0;
  for (const page of pages(site)) {
    const text = readFileSync(page, "utf8");
    for (const [, link] of text.matchAll(INTERNAL)) {
      found += 1;
      if (!here.has((link as string).replace(/\/$/, ""))) {
        broken.push(`${page.slice(root.length + 1)} → ${link}`);
      }
    }
  }
  // Again: a pattern that matched nothing would report every page perfect.
  expect(found).toBeGreaterThan(10);
  expect([...new Set(broken)]).toEqual([]);
});
