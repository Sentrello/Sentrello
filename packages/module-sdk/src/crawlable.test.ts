import { beforeEach, expect, test } from "bun:test";
import {
  addCrawlable,
  allCrawlable,
  clearCrawlable,
  robotsTxt,
} from "./crawlable";

/**
 * An instance refuses crawlers unless a module says otherwise.
 *
 * `/robots.txt` used to fall through to the single-page app — a 200 of HTML,
 * which a crawler reads as *no robots.txt at all* and therefore as permission
 * to index everything. On our own hosts nginx sent `X-Robots-Tag` and nothing
 * came of it; a customer on their own domain had no such cover.
 */

beforeEach(clearCrawlable);

test("an instance with no public pages refuses the lot", () => {
  expect(robotsTxt("https://app.example.test")).toBe(
    "User-agent: *\nDisallow: /\n",
  );
});

test("a module that publishes pages gets its prefix allowed", () => {
  addCrawlable({ moduleId: "shop", prefix: "/shop" });
  const txt = robotsTxt(null);
  // Disallow first and Allow after: longest match wins, so this is "the shop
  // and nothing else" however a person reads the order.
  expect(txt).toBe("User-agent: *\nDisallow: /\nAllow: /shop\n");
});

test("a sitemap is written absolute, against the address the reader used", () => {
  addCrawlable({
    moduleId: "docs",
    prefix: "/docs",
    sitemap: "/docs/sitemap.xml",
  });
  expect(robotsTxt("https://help.example.test")).toContain(
    "Sitemap: https://help.example.test/docs/sitemap.xml",
  );
});

/** Without a host there is nothing to make a sitemap URL out of. */
test("no origin, no sitemap line", () => {
  addCrawlable({
    moduleId: "docs",
    prefix: "/docs",
    sitemap: "/docs/sitemap.xml",
  });
  expect(robotsTxt(null)).not.toContain("Sitemap:");
});

/**
 * A prefix of `/` is the absence of a public surface, not one of them.
 *
 * It would turn the file into "help yourself" while looking like a
 * registration, which is the failure this whole thing exists to prevent.
 */
test("a module cannot open the whole instance", () => {
  addCrawlable({ moduleId: "careless", prefix: "/" });
  addCrawlable({ moduleId: "careless", prefix: "shop" });
  expect(allCrawlable()).toHaveLength(0);
  expect(robotsTxt(null)).toBe("User-agent: *\nDisallow: /\n");
});

/** The host loads modules more than once in one process during its boot tests. */
test("the same surface registered twice appears once", () => {
  addCrawlable({ moduleId: "shop", prefix: "/shop" });
  addCrawlable({ moduleId: "shop", prefix: "/shop" });
  expect(allCrawlable()).toHaveLength(1);
});

test("two modules each get a line, in an order a person can read", () => {
  addCrawlable({ moduleId: "shop", prefix: "/shop" });
  addCrawlable({ moduleId: "docs", prefix: "/docs" });
  expect(robotsTxt(null)).toBe(
    "User-agent: *\nDisallow: /\nAllow: /docs\nAllow: /shop\n",
  );
});
