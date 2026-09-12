/**
 * Which websites may hold a signed-in customer.
 *
 * A shop's own website is a different origin from the instance behind it, and a
 * session is a cookie. Letting one be sent to the other is not a setting to flip
 * casually — it is the difference between "the shop's website can act as this
 * customer" and "anything that can reach the instance can".
 *
 * Two conditions, and both must hold.
 *
 * **The site has to be one the shop named.** That is the existing allow-list,
 * which starts empty and therefore allows nobody.
 *
 * **And it has to be the same site as the instance**, in the sense a browser
 * means: the same registrable domain. `barkerpawski.com` and
 * `sentrello.barkerpawski.com` are the same site and a cookie passes between
 * them with no relaxation at all — the ordinary `SameSite=Lax` session works,
 * and none of the third-party-cookie blocking Safari does today and Chrome is
 * phasing in applies to it.
 *
 * A website on a *different* domain from its instance is genuinely cross-site.
 * Holding a session there would need `SameSite=None`, which Safari already
 * refuses — so it is not merely riskier, it does not reliably work. Those shops
 * put their storefront on a subdomain, which is one DNS record, or use the
 * emailed link that needs no session at all.
 *
 * This refuses rather than degrading, because a login that works in one browser
 * and silently fails in another is worse than one that was never offered.
 */

/**
 * The domain two hosts would have to share, worked out from the instance's own.
 *
 * Deliberately not a public-suffix lookup. That list is large, it goes stale,
 * and getting it wrong here fails open — `co.uk` as a shared parent would make
 * every British website same-site with every other. Stripping one label off the
 * instance's own host cannot do that: the answer is always a domain somebody
 * already controls, because the instance is running on it.
 */
export function sessionDomain(instanceHost: string): string | null {
  const host = instanceHost.trim().toLowerCase().replace(/:\d+$/, "");
  if (!host) return null;

  const labels = host.split(".").filter(Boolean);
  // An address with no dots — `localhost`, a container name — has no parent to
  // share, and is only ever itself.
  if (labels.length < 2) return host;

  /*
   * An instance at the apex keeps the apex. Stripping a label off
   * `barkerpawski.com` gives `com`, which would make every website on earth
   * same-site with it — the one mistake this function exists to not make.
   */
  if (labels.length === 2) return host;

  return labels.slice(1).join(".");
}

/** Whether a host is that domain, or something under it. */
export function withinSessionDomain(
  host: string,
  domain: string | null,
): boolean {
  if (!domain) return false;
  const it = host.trim().toLowerCase().replace(/:\d+$/, "");
  if (!it) return false;
  return it === domain || it.endsWith(`.${domain}`);
}

/**
 * May this origin hold a signed-in customer?
 *
 * `allowed` is the shop's own list having already said yes. This adds the
 * second condition, and says plainly why when it refuses — a shop setting this
 * up needs to be told "that website is not on the same domain as this
 * instance", not handed a session that never arrives.
 */
export function maySignIn(
  origin: string | undefined,
  instanceBaseUrl: string,
  allowed: boolean,
): { ok: boolean; reason?: string } {
  if (!allowed) {
    return { ok: false, reason: "that website is not on this shop's list" };
  }
  // No Origin at all is the instance talking to itself, or a client that is not
  // a browser. Nothing cross-site is happening.
  if (!origin) return { ok: true };

  let site: string;
  let instance: string;
  try {
    site = new URL(origin).host.toLowerCase();
    instance = new URL(instanceBaseUrl).host.toLowerCase();
  } catch {
    return { ok: false, reason: "that is not an address" };
  }

  const domain = sessionDomain(instance);
  if (!withinSessionDomain(site, domain)) {
    return {
      ok: false,
      reason: `a customer can only sign in from a website on ${domain ?? "this instance's domain"}. Browsers will not carry a session between two different domains, so put the shop's website on a subdomain of it.`,
    };
  }
  return { ok: true };
}
