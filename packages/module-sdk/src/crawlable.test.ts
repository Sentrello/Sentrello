import { afterAll, beforeEach, expect, test } from "bun:test";
import {
  addCrawlable,
  allCrawlable,
  clearCrawlable,
  crawlablePath,
  removeCrawlable,
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
// And after the file: the registry is one array for the whole process, so a
// prefix this file left behind is a prefix another file's `noindex` header
// answers with.
afterAll(clearCrawlable);

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
  expect(txt).toBe("User-agent: *\nDisallow: /\nAllow: /$\nAllow: /shop\n");
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
    "User-agent: *\nDisallow: /\nAllow: /$\nAllow: /docs\nAllow: /shop\n",
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

/**
 * The root, when there is anything behind it.
 *
 * `Disallow: /` closed the one address anybody links to or submits. The
 * documentation host redirects `/` to `/docs/intro`, and a crawler will not
 * fetch a disallowed URL even to learn that it redirects — so a site whose every
 * page was allowed under `/docs` had its front door shut, which is what
 * "robots.txt is blocking search engines from the docs" turned out to mean on
 * 7 October 2026.
 */
test("the root is opened once something is published behind it", async () => {
  clearCrawlable();
  addCrawlable({ moduleId: "docs", prefix: "/docs" });
  const txt = await robotsTxt("https://help.example.test");
  // `/$` is the root and nothing else, so this opens one URL rather than undoing
  // the default.
  expect(txt).toContain("Allow: /$");
  expect(txt.split("\n")).toEqual([
    "User-agent: *",
    "Disallow: /",
    "Allow: /$",
    "Allow: /docs",
    "",
  ]);
});

test("and an instance with nothing published still refuses even that", async () => {
  clearCrawlable();
  // The whole point of the file: a business running an application and
  // publishing nothing is not asking to be crawled at all.
  expect(await robotsTxt("https://app.example.test")).not.toContain("Allow:");
});

/**
 * A surface that is closed on *this* host does not open the root either.
 *
 * The documentation module answers per host — a site its owner marked not
 * indexable is closed — and an opened root with everything else disallowed would
 * be a door to one redirect nobody may follow.
 */
test("a surface closed on this host leaves the root closed", async () => {
  clearCrawlable();
  addCrawlable({
    moduleId: "docs",
    prefix: "/docs",
    live: (hostname) => hostname === "open.example.test",
  });
  expect(await robotsTxt("https://shut.example.test")).toBe(
    "User-agent: *\nDisallow: /\n",
  );
  expect(await robotsTxt("https://open.example.test")).toContain("Allow: /$");
});

/*
 * A prefix is the wrong unit for what sits inside it.
 *
 * The shop's storefront is public and `/shop/orders/<token>` is somebody's
 * name, address and download links. Both were invited in, by the file and by
 * the header, because each read the prefix alone.
 */

test("a surface can shut part of itself, and the file says so", async () => {
  addCrawlable({
    moduleId: "shop",
    prefix: "/shop",
    closed: ["/shop/cart", "/shop/orders"],
  });
  expect(await robotsTxt(null)).toBe(
    [
      "User-agent: *",
      "Disallow: /",
      "Allow: /$",
      "Allow: /shop",
      // Under their own allow, and longer than it, which is how a crawler
      // decides: /shop/orders/abc matches this and not the line above.
      "Disallow: /shop/cart",
      "Disallow: /shop/orders",
      "",
    ].join("\n"),
  );
});

test("the header and the file agree about every path", () => {
  addCrawlable({
    moduleId: "shop",
    prefix: "/shop",
    closed: ["/shop/cart", "/shop/orders"],
  });
  // The storefront and a product page: crawl away.
  expect(crawlablePath("/shop")).toBe(true);
  expect(crawlablePath("/shop/brass-kettle")).toBe(true);
  // The cart, the order page, and anything under it.
  expect(crawlablePath("/shop/cart")).toBe(false);
  expect(crawlablePath("/shop/orders")).toBe(false);
  expect(crawlablePath("/shop/orders/9f3c-not-a-real-token")).toBe(false);
  // And the application, which is almost all of it.
  expect(crawlablePath("/crm")).toBe(false);
  expect(crawlablePath("/")).toBe(false);
});

test("a path that only looks like a closed one is still open", () => {
  addCrawlable({
    moduleId: "shop",
    prefix: "/shop",
    closed: ["/shop/orders"],
  });
  // A product whose slug begins with the closed path's name. Prefix matching on
  // the raw string would shut it; matching on path segments does not.
  expect(crawlablePath("/shop/orders-ledger-2024")).toBe(true);
});

test("an exclusion a module did not mean closes nothing", async () => {
  addCrawlable({
    moduleId: "muddle",
    prefix: "/shop",
    // Not under the prefix, so it would disallow a path this surface does not
    // own; and the prefix itself, which would close the whole storefront. A
    // typo in an exclusion must not take a published shop off the web.
    closed: ["/docs/secret", "/shop"],
  });
  const txt = await robotsTxt(null);
  expect(txt).toBe("User-agent: *\nDisallow: /\nAllow: /$\nAllow: /shop\n");
  expect(crawlablePath("/shop")).toBe(true);
  expect(crawlablePath("/shop/anything")).toBe(true);
});

test("a closed path is shut even when the module is asked about twice", () => {
  // Re-registering replaces, which is what a host that loads its modules twice
  // does — and the replacement must not quietly drop the exclusions.
  addCrawlable({ moduleId: "shop", prefix: "/shop", closed: ["/shop/cart"] });
  addCrawlable({ moduleId: "shop", prefix: "/shop", closed: ["/shop/cart"] });
  expect(allCrawlable()).toHaveLength(1);
  expect(crawlablePath("/shop/cart")).toBe(false);
});

/*
 * One instance, several names, and a proxy that sends each one somewhere.
 *
 * A documentation host served `Allow: /shop` and then a shop sitemap, both 404
 * on that name. Measured on a real host on 7 October, not reasoned about.
 */

test("a surface that holds a hostname is the only one on it", async () => {
  addCrawlable({
    moduleId: "docs",
    prefix: "/docs",
    sitemap: "/docs/sitemap.xml",
    only: (hostname) => hostname === "docs.example.test",
  });
  addCrawlable({
    moduleId: "shop",
    prefix: "/shop",
    sitemap: "/shop/sitemap.xml",
    closed: ["/shop/cart"],
  });

  // On the documentation's own name: the documentation, and nothing of the shop.
  const docs = await robotsTxt("https://docs.example.test");
  expect(docs).toContain("Allow: /docs");
  expect(docs).toContain("Sitemap: https://docs.example.test/docs/sitemap.xml");
  expect(docs).not.toContain("/shop");

  // On the instance's own name, where the proxy serves the application and the
  // shop: both, because nobody there claims to be the whole of it.
  const app = await robotsTxt("https://books.example.test");
  expect(app).toContain("Allow: /shop");
  expect(app).toContain("Disallow: /shop/cart");
  expect(app).toContain("Allow: /docs");
});

test("two surfaces both claiming a name keep both", async () => {
  // A disagreement to leave visible rather than resolve by coin toss: dropping
  // one of them would hide a surface on the word of a module that may be wrong.
  addCrawlable({ moduleId: "a", prefix: "/alpha", only: () => true });
  addCrawlable({ moduleId: "b", prefix: "/beta", only: () => true });
  const txt = await robotsTxt("https://both.example.test");
  expect(txt).toContain("Allow: /alpha");
  expect(txt).toContain("Allow: /beta");
});

test("a claim that cannot be answered is not a claim", async () => {
  addCrawlable({
    moduleId: "docs",
    prefix: "/docs",
    only: () => {
      throw new Error("the table this wants is not migrated yet");
    },
  });
  addCrawlable({ moduleId: "shop", prefix: "/shop" });
  // The throw closes nothing: a surface that cannot say whether it holds the
  // name has said nothing, so the shop stays where it was.
  const txt = await robotsTxt("https://books.example.test");
  expect(txt).toContain("Allow: /docs");
  expect(txt).toContain("Allow: /shop");
});

test("holding a name it is not serving on claims nothing", async () => {
  addCrawlable({
    moduleId: "docs",
    prefix: "/docs",
    // Switched off here, and certain it owns the place. The first answer wins:
    // a surface that is not serving cannot be the whole of what is served.
    live: () => false,
    only: () => true,
  });
  addCrawlable({ moduleId: "shop", prefix: "/shop" });
  const txt = await robotsTxt("https://books.example.test");
  expect(txt).not.toContain("/docs");
  expect(txt).toContain("Allow: /shop");
});

test("one surface can be taken back out without flattening the rest", () => {
  addCrawlable({ moduleId: "docs", prefix: "/docs" });
  addCrawlable({ moduleId: "shop", prefix: "/shop" });
  removeCrawlable("shop", "/shop");
  expect(allCrawlable().map((s) => s.prefix)).toEqual(["/docs"]);
  // And asking for one that was never there changes nothing.
  removeCrawlable("shop", "/shop");
  expect(allCrawlable()).toHaveLength(1);
});
