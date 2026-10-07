/**
 * The address the reader used.
 *
 * Three places need it and each had written its own: `/robots.txt`, whose
 * `Sitemap:` line has to be absolute; a documentation page's canonical link;
 * and now a storefront's. Behind nginx the request arrives over plain HTTP with
 * the real scheme in `x-forwarded-proto`, so a hardcoded `https` is wrong on a
 * machine served plainly on a local network and a hardcoded `http` is wrong
 * everywhere else.
 *
 * **It is not a security boundary.** `x-forwarded-proto` is a header, and a
 * client can forge it where the proxy does not overwrite it. That is why HSTS
 * is not set from this — the worst a forged value does here is put the wrong
 * scheme in a canonical link, which costs a crawler a redirect. The trust
 * decision belongs to the proxy, which owns the header.
 */
// biome-ignore lint/suspicious/noExplicitAny: the host's context type
export function requestOrigin(c: any): string | null {
  const forwarded = (c.req.header("x-forwarded-proto") as string | undefined)
    ?.split(",")[0]
    ?.trim();
  /*
   * The Host header first, because that is what the reader typed. `c.req.url`
   * is built from it in the ordinary case and falls back to something the
   * runtime chose when it is absent — which is a machine's own idea of its name,
   * not an address anybody can fetch.
   */
  const host = (c.req.header("host") as string | undefined)?.trim();
  let own: string | undefined;
  try {
    const requested = new URL(c.req.url as string);
    own = requested.protocol.replace(":", "");
    if (!host) return `${forwarded || own}://${requested.host}`;
  } catch {
    // A URL the runtime cannot parse leaves the scheme to the proxy's word.
  }
  if (!host) return null;
  return `${forwarded || own || "https"}://${host}`;
}
