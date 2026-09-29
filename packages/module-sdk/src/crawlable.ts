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
  /**
   * Whether the surface is actually open, on the host being asked.
   *
   * Declared at load, which is not the same as published: the documentation
   * module registers `/docs` the moment it is entitled, and the shop registers
   * `/shop` whether or not it serves a storefront. So a fresh Pro instance
   * answered `Allow: /docs` and advertised a sitemap, both of which were 404 —
   * and a business that had deliberately marked its documentation site *not
   * indexable*, or put the shop away, was still telling every crawler to come
   * in. robots.txt is the one file whose whole job is to be believed.
   *
   * Given the hostname the reader used, because these are per-host answers: one
   * instance can serve a documentation site on its own domain.
   *
   * Left out means "always open", which is what a surface with nothing to
   * configure wants.
   */
  live?: (hostname: string | null) => Promise<boolean> | boolean;
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
export async function robotsTxt(origin: string | null): Promise<string> {
  const hostname = origin
    ? (origin.replace(/^https?:\/\//, "").split(":")[0] ?? null)
    : null;
  /*
   * Only the surfaces that answer today.
   *
   * A module that cannot say — one whose check throws because a table it wants
   * is not migrated yet — counts as closed. The cost of that is a page nobody
   * crawls; the cost the other way is a crawl of something somebody asked us
   * not to publish.
   */
  const open = [];
  for (const surface of allCrawlable()) {
    if (!surface.live) {
      open.push(surface);
      continue;
    }
    try {
      if (await surface.live(hostname)) open.push(surface);
    } catch {
      // Closed, and silent: robots.txt is fetched by crawlers and a log line
      // per fetch is a log nobody reads.
    }
  }

  const lines = ["User-agent: *", "Disallow: /"];
  for (const surface of [...open].sort((a, b) =>
    a.prefix.localeCompare(b.prefix),
  )) {
    lines.push(`Allow: ${surface.prefix}`);
  }
  if (origin) {
    for (const surface of open) {
      if (surface.sitemap) lines.push(`Sitemap: ${origin}${surface.sitemap}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
