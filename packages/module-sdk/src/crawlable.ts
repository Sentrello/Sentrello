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
   * Paths under the prefix that stay shut, longest-match style.
   *
   * A prefix is the right unit for "the shop is public" and the wrong one for
   * what sits inside it. `/shop` covers `/shop/cart`, which is worth nobody's
   * crawl budget, and `/shop/orders/<token>` — somebody's name, address, order
   * lines and download links, addressed by a token. robots.txt only stops a
   * *fetch*; a URL that escapes by referrer or gets pasted into a forum can
   * still be indexed, and this one was being invited.
   *
   * Each entry must sit under the prefix and must not be the prefix itself:
   * closing the whole surface is what not declaring it does.
   */
  closed?: string[];
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
  /**
   * Whether this surface is the whole of what that hostname serves.
   *
   * One instance can answer on several names, and a proxy decides what each one
   * reaches. A business that points a domain at its documentation gets both that
   * domain and its ordinary address answering the same application — but on the
   * first, the proxy serves the documentation site and nothing else, so a
   * storefront prefix there is a 404.
   *
   * The instance cannot read its own proxy configuration, and said so for a long
   * time by advertising every open surface on every name: an allow for a prefix
   * that name does not serve, which costs a crawler one request, and then, once
   * the storefront published a sitemap, a `Sitemap:` line pointing at an address
   * that 404s. An allow for a dead path is untidy. A sitemap for one is a
   * stronger claim, in the file whose whole job is to be believed.
   *
   * So a surface that knows a hostname is *its* says so, and the others drop off
   * that hostname. A documentation site knows because its owner named the
   * hostname on it, which is what pointing a domain at your documentation
   * means.
   *
   * **The error lands on the quiet side.** Claim this wrongly and a surface that
   * does answer on that name goes unadvertised, which costs crawl coverage.
   * Leave it unclaimed and the file says something untrue. Of the two, a
   * believable file is worth more, and the same reasoning sits above `live`.
   *
   * Left out means "shares the name with whatever else is open", which is what
   * nearly every surface wants.
   */
  only?: (hostname: string | null) => Promise<boolean> | boolean;
}

const registry: CrawlableSurface[] = [];

export function addCrawlable(surface: CrawlableSurface): void {
  // A prefix that allows everything is not a public surface, it is the absence
  // of one — and it would turn the whole file into "help yourself".
  if (!surface.prefix.startsWith("/") || surface.prefix === "/") return;
  /*
   * A closed path that is not under the prefix closes nothing, and one equal to
   * the prefix closes everything. Both are a module saying something it did not
   * mean, so both are dropped rather than honoured — and the surface itself
   * still registers, because the alternative is a typo in an exclusion taking a
   * published storefront off the web.
   */
  const meant = surface.closed?.filter((path) =>
    path.startsWith(`${surface.prefix}/`),
  );
  const declared: CrawlableSurface = {
    ...surface,
    closed: meant?.length ? meant : undefined,
  };
  const at = registry.findIndex(
    (s) => s.moduleId === declared.moduleId && s.prefix === declared.prefix,
  );
  if (at >= 0) registry[at] = declared;
  else registry.push(declared);
}

export function allCrawlable(): CrawlableSurface[] {
  return [...registry];
}

/** For tests and for a host that loads its modules more than once. */
export function clearCrawlable(): void {
  registry.length = 0;
}

/**
 * Take one surface back out.
 *
 * For a test that adds a second module's surface to see how two of them read
 * together. `clearCrawlable` is the wrong tool for that and quietly wrong: the
 * registry is one array for the whole process, so clearing it also throws away
 * what the module under test registered when it loaded, and the next test in
 * the file gets an instance that publishes nothing. That is how it went on
 * 7 October — a test asserting `Allow: /docs` failed because its neighbour had
 * tidied up after itself too thoroughly.
 */
export function removeCrawlable(moduleId: string, prefix: string): void {
  const at = registry.findIndex(
    (s) => s.moduleId === moduleId && s.prefix === prefix,
  );
  if (at >= 0) registry.splice(at, 1);
}

/**
 * May a crawler index this path?
 *
 * Asked by `/robots.txt` and by the `x-robots-tag` header on every response,
 * which is the point: the header exists because a CDN can prepend its own
 * permissive robots.txt to ours, so the two have to agree about every path or
 * the stricter one is decoration. They did not agree. Each computed "under a
 * published prefix" for itself, and only one of them had ever heard of an
 * exclusion.
 *
 * Deliberately **not** asking `live`. That is a database question and this runs
 * on every response; a surface that is switched off serves 404s under its
 * prefix, and a 404 with no `noindex` on it costs nothing. Do not turn this
 * into a per-request query.
 */
export function crawlablePath(pathname: string): boolean {
  for (const surface of registry) {
    const under =
      pathname === surface.prefix || pathname.startsWith(`${surface.prefix}/`);
    if (!under) continue;
    const shut = surface.closed?.some(
      (path) => pathname === path || pathname.startsWith(`${path}/`),
    );
    if (!shut) return true;
  }
  return false;
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
  let open = [];
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

  /*
   * And if one of them holds this hostname outright, it is the only one on it.
   *
   * Asked after `live`, because a surface that is not serving here cannot hold
   * the name either. More than one claimant keeps all the claimants rather than
   * picking: two surfaces each certain they own the name is a disagreement to
   * surface by leaving both, not to resolve by coin toss.
   */
  const holders = [];
  for (const surface of open) {
    if (!surface.only) continue;
    try {
      if (await surface.only(hostname)) holders.push(surface);
    } catch {
      // Cannot say, so it does not claim. Same silence as `live`, same reason.
    }
  }
  if (holders.length > 0) open = holders;

  const lines = ["User-agent: *", "Disallow: /"];
  /*
   * The front door, when there is anything behind it.
   *
   * `Disallow: /` closes the root, and the root is the only address anybody
   * links to or submits: `https://docs.sentrello.com/` redirects to
   * `/docs/intro`, and a crawler will not fetch a disallowed URL *even to find
   * out that it redirects*. So a documentation site whose every page was allowed
   * under `/docs` had its one entry point shut, and that is what "robots.txt is
   * blocking search engines from the docs" turned out to mean — reported on
   * 7 October 2026, measured rather than assumed: the file allowed /docs all
   * along.
   *
   * `/$` matches the root and nothing else, so this opens one URL rather than
   * undoing the default. A parser that does not understand `$` reads it as a
   * literal path that matches nothing, which leaves it exactly where it was.
   *
   * Only when a surface is open on this host. An instance with nothing published
   * still refuses the lot, which is the whole point of the file; on a host that
   * publishes something, the worst a crawler finds at the root is whatever the
   * root serves, because every other path is still disallowed.
   */
  if (open.length > 0) lines.push("Allow: /$");
  for (const surface of [...open].sort((a, b) =>
    a.prefix.localeCompare(b.prefix),
  )) {
    lines.push(`Allow: ${surface.prefix}`);
    /*
     * And the parts of it that stay shut, immediately under their own allow so
     * a person reads them together. A crawler reads them by length: `Disallow:
     * /shop/orders` is longer than `Allow: /shop`, so it wins for every order
     * page and loses for every product page, which is the whole arrangement.
     */
    for (const path of surface.closed ?? []) lines.push(`Disallow: ${path}`);
  }
  if (origin) {
    for (const surface of open) {
      if (surface.sitemap) lines.push(`Sitemap: ${origin}${surface.sitemap}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
