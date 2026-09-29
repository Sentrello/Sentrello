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

test("an instance with no public pages refuses the lot", async () => {
  expect(await robotsTxt("https://app.example.test")).toBe(
    "User-agent: *\nDisallow: /\n",
  );
});

test("a module that publishes pages gets its prefix allowed", async () => {
  addCrawlable({ moduleId: "shop", prefix: "/shop" });
  const txt = await robotsTxt(null);
  // Disallow first and Allow after: longest match wins, so this is "the shop
  // and nothing else" however a person reads the order.
  expect(txt).toBe("User-agent: *\nDisallow: /\nAllow: /shop\n");
});

test("a sitemap is written absolute, against the address the reader used", async () => {
  addCrawlable({
    moduleId: "docs",
    prefix: "/docs",
    sitemap: "/docs/sitemap.xml",
  });
  expect(await robotsTxt("https://help.example.test")).toContain(
    "Sitemap: https://help.example.test/docs/sitemap.xml",
  );
});

/** Without a host there is nothing to make a sitemap URL out of. */
test("no origin, no sitemap line", async () => {
  addCrawlable({
    moduleId: "docs",
    prefix: "/docs",
    sitemap: "/docs/sitemap.xml",
  });
  expect(await robotsTxt(null)).not.toContain("Sitemap:");
});

/**
 * A prefix of `/` is the absence of a public surface, not one of them.
 *
 * It would turn the file into "help yourself" while looking like a
 * registration, which is the failure this whole thing exists to prevent.
 */
test("a module cannot open the whole instance", async () => {
  addCrawlable({ moduleId: "careless", prefix: "/" });
  addCrawlable({ moduleId: "careless", prefix: "shop" });
  expect(allCrawlable()).toHaveLength(0);
  expect(await robotsTxt(null)).toBe("User-agent: *\nDisallow: /\n");
});

/** The host loads modules more than once in one process during its boot tests. */
test("the same surface registered twice appears once", async () => {
  addCrawlable({ moduleId: "shop", prefix: "/shop" });
  addCrawlable({ moduleId: "shop", prefix: "/shop" });
  expect(allCrawlable()).toHaveLength(1);
});

test("two modules each get a line, in an order a person can read", async () => {
  addCrawlable({ moduleId: "shop", prefix: "/shop" });
  addCrawlable({ moduleId: "docs", prefix: "/docs" });
  expect(await robotsTxt(null)).toBe(
    "User-agent: *\nDisallow: /\nAllow: /docs\nAllow: /shop\n",
  );
});

/**
 * A surface that is declared and not open.
 *
 * Both modules that publish one register it the moment they load: the
 * documentation site registers `/docs` when the licence includes it, the shop
 * registers `/shop` whether or not it serves a storefront. So a fresh Pro
 * instance told every crawler to come into two prefixes that answered 404, and
 * — worse — a business that had marked its documentation site *not indexable*
 * was still advertising its sitemap.
 */
test("only the surfaces that answer today are allowed", async () => {
  clearCrawlable();
  addCrawlable({
    moduleId: "docs",
    prefix: "/docs",
    sitemap: "/docs/sitemap.xml",
    live: () => false,
  });
  addCrawlable({ moduleId: "shop", prefix: "/shop", live: () => true });
  const txt = await robotsTxt("https://books.example.test");
  expect(txt).toContain("Allow: /shop");
  expect(txt).not.toContain("Allow: /docs");
  expect(txt).not.toContain("Sitemap:");
});

test("the hostname reaches the surface, because the answer is per host", async () => {
  clearCrawlable();
  const asked: (string | null)[] = [];
  addCrawlable({
    moduleId: "docs",
    prefix: "/docs",
    live: (hostname) => {
      asked.push(hostname);
      return hostname === "help.example.test";
    },
  });
  expect(await robotsTxt("https://help.example.test")).toContain(
    "Allow: /docs",
  );
  expect(await robotsTxt("https://books.example.test:8443")).not.toContain(
    "Allow: /docs",
  );
  expect(asked).toEqual(["help.example.test", "books.example.test"]);
});

test("a surface that cannot answer counts as closed", async () => {
  clearCrawlable();
  addCrawlable({
    moduleId: "docs",
    prefix: "/docs",
    live: () => {
      throw new Error("the table is not migrated yet");
    },
  });
  expect(await robotsTxt(null)).toBe("User-agent: *\nDisallow: /\n");
});
