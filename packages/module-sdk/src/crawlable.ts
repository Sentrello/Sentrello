/**
 * The parts of an instance a search engine may follow.
 *
 * A Sentrello instance is an application, not a website. Almost everything on
 * it is behind a sign-in, and the few pages that are not — the Shop's
 * storefront, a published documentation site — are the exception rather than
 * the rule. Nothing said so: `/robots.txt` fell through to the single-page app
 * and answered 200 with HTML, which a crawler reads as *no robots.txt at all*
 * and therefore as permission to take everything. Every instance, not only ours.
 *
 * So the default is to refuse the lot, and a module that genuinely publishes
 * something says which prefix. The same shape as `registerNav` and
 * `registerOnboarding`, for the same reason: Core cannot name the modules in
 * other repositories, so each one declares its own surface and Core assembles
 * whatever this instance happens to have loaded.
 *
 * **Prefixes, not a list of pages.** robots.txt matches on prefix and the
 * longest match wins, so `Disallow: /` with `Allow: /shop` is exactly "the shop
 * and nothing else" — and a module that adds a page under its own prefix does
 * not have to remember to come back here.
 */

export interface CrawlableSurface {
  /** The module declaring it, so a duplicate replaces rather than repeats. */
  moduleId: string;
  /**
   * The path prefix that may be crawled, beginning with a slash.
   *
   * `/shop` covers `/shop/anything`. A bare `/` would undo the point of this
   * and is refused.
   */
  prefix: string;
  /** A sitemap for that surface, when the module publishes one. */
  sitemap?: string;
}

const registry: CrawlableSurface[] = [];

export function addCrawlable(surface: CrawlableSurface): void {
  // A prefix that allows everything is not a public surface, it is the absence
  // of one — and it would turn the whole file into "help yourself".
  if (!surface.prefix.startsWith("/") || surface.prefix === "/") return;
  const at = registry.findIndex(
    (s) => s.moduleId === surface.moduleId && s.prefix === surface.prefix,
  );
  if (at >= 0) registry[at] = surface;
  else registry.push(surface);
}

export function allCrawlable(): CrawlableSurface[] {
  return [...registry];
}

/** For tests and for a host that loads its modules more than once. */
export function clearCrawlable(): void {
  registry.length = 0;
}

/**
 * The file itself.
 *
 * `Disallow: /` first and the allowances after it, which is the order a person
 * reads it in; crawlers do not care about order, only about which rule matches
 * longest.
 *
 * `origin` is the address the reader used, because a sitemap line has to be an
 * absolute URL and the one nginx used to reach us is not the one anybody typed.
 */
export function robotsTxt(origin: string | null): string {
  const surfaces = allCrawlable();
  const lines = ["User-agent: *", "Disallow: /"];

  for (const surface of [...surfaces].sort((a, b) =>
    a.prefix.localeCompare(b.prefix),
  )) {
    lines.push(`Allow: ${surface.prefix}`);
  }

  if (origin) {
    for (const surface of surfaces) {
      if (surface.sitemap) lines.push(`Sitemap: ${origin}${surface.sitemap}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
