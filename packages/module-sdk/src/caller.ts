import type { Context } from "hono";

/**
 * Who is calling, and whether we have any reason to believe them.
 *
 * This lives here, in the package that depends on nothing but Hono, because two
 * places needed it and each had written its own. `clientAddress` in
 * `@sentrello/auth` decided it for sign-in, lockouts and the address beside a
 * session; `callerKey` in `public-endpoints.ts` decided it for every public rate
 * limit in every module. Only one of them honoured `SENTRELLO_TRUSTED_PROXIES`,
 * which meant an operator who set that variable got half of what they asked for
 * and no sign the other half was ignored. `@sentrello/auth` already depends on
 * this package, so the dependency runs the right way round and there is now one
 * answer.
 *
 * **Unset, the header is believed**, which is correct on every instance deployed
 * the documented way: our nginx writes `x-real-ip` from `$remote_addr`, so a
 * caller cannot forge it through that. **Set, the header is believed only from a
 * hop on the list** — the lever an operator behind Caddy, behind a load balancer,
 * or exposed directly needs.
 */
function trustedHeaderName(env: Record<string, string | undefined>): string {
  return env.SENTRELLO_CLIENT_IP_HEADER?.trim() || "x-real-ip";
}

function trustedHops(env: Record<string, string | undefined>): string[] {
  return (
    env.SENTRELLO_TRUSTED_PROXIES?.split(",")
      .map((hop) => hop.trim())
      .filter(Boolean) ?? []
  );
}

/**
 * `::ffff:127.0.0.1` is how a dual-stack socket reports an IPv4 peer, and it is
 * what Bun hands back. Without this, a list naming `127.0.0.1` matches nothing
 * and every instance that set the variable is quietly tightened — several callers
 * counted as one, with nothing to say why.
 */
function plainIp(ip: string): string {
  return /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)?.[1] ?? ip;
}

function asNumber(raw: string): number | null {
  const parts = plainIp(raw).split(".");
  if (parts.length !== 4) return null;
  let total = 0;
  for (const part of parts) {
    const byte = Number(part);
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return null;
    total = total * 256 + byte;
  }
  return total;
}

/**
 * Whether a connection came from a hop we said to believe.
 *
 * An entry this cannot parse matches nothing. That tightens rather than loosens,
 * which is the safe direction for a typo, and it shows up as limits counting
 * several callers as one rather than as a limit quietly not applying.
 */
export function fromTrustedHop(
  peer: string | undefined,
  hops: string[],
): boolean {
  /*
   * No socket to ask. Every test driving a route through `app.request()` lands
   * here, and so does any runtime that is not Bun's server — so this believes the
   * header rather than failing a deployment nobody can diagnose.
   */
  if (!peer) return true;

  const peerNumber = asNumber(peer);
  for (const hop of hops) {
    if (hop === peer || plainIp(hop) === plainIp(peer)) return true;
    const [network, bits] = hop.split("/");
    if (!network || bits === undefined) continue;
    const width = Number(bits);
    const networkNumber = asNumber(network);
    if (
      peerNumber === null ||
      networkNumber === null ||
      !Number.isInteger(width) ||
      width < 0 ||
      width > 32
    ) {
      continue;
    }
    // A /0 means everything, and a /32 needs the unsigned shift: `-1 << 0` is
    // every bit set, which is what /0 should mean rather than what it would do.
    const mask = width === 0 ? 0 : (-1 << (32 - width)) >>> 0;
    if ((peerNumber & mask) === (networkNumber & mask)) return true;
  }
  return false;
}

export interface CallerAddress {
  ip?: string;
  /** Known only when this server holds the caller's socket itself. */
  port?: string;
  /** Whether the answer came out of a header rather than off the socket. */
  proxied: boolean;
}

/**
 * The address off the socket, asked of the server rather than imported.
 *
 * `getConnInfo` from `hono/bun` is these four lines, and importing it put
 * `hono/bun` into the import graph of `@sentrello/db` — which drizzle-kit reads
 * under Node, where `Bun` is not defined. Every module's `db:generate` then died
 * on `ReferenceError: Bun is not defined` before it reached a table. A package
 * three repositories depend on has no business naming a runtime, and the only
 * thing that was wanted from the adapter is the question below.
 *
 * Empty whenever there is no server to ask: a test driving a route through
 * `app.request()`, or a runtime that is not Bun's own.
 */
function peerAddress(c: Pick<Context, "req">): {
  address?: string;
  port?: number;
} {
  const env = (c as { env?: unknown }).env;
  if (!env || typeof env !== "object") return {};
  const holder = (
    "server" in env ? (env as { server?: unknown }).server : env
  ) as
    | {
        requestIP?: (
          request: Request,
        ) => { address?: string; port?: number } | null;
      }
    | undefined;
  if (typeof holder?.requestIP !== "function") return {};
  try {
    return holder.requestIP(c.req.raw) ?? {};
  } catch {
    return {};
  }
}

/** The caller's address, as far as anything here can honestly tell. */
export function callerAddress(
  c: Pick<Context, "req">,
  env: Record<string, string | undefined> = process.env,
): CallerAddress {
  const fromHeader = c.req.header(trustedHeaderName(env));
  if (fromHeader) {
    const hops = trustedHops(env);
    if (hops.length === 0) return { ip: fromHeader, proxied: true };
    if (fromTrustedHop(peerAddress(c).address, hops)) {
      return { ip: fromHeader, proxied: true };
    }
    // The header arrived from somewhere we did not say to believe, so it is a
    // claim rather than an address. Fall through to the socket.
  }

  const peer = peerAddress(c);
  if (peer.address) {
    return {
      ip: peer.address,
      port: peer.port != null ? String(peer.port) : undefined,
      proxied: false,
    };
  }
  return { proxied: false };
}
