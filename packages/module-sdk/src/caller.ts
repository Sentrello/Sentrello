import type { Context } from "hono";
import { bunServer } from "./server-access";

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
 * **Unset, the header is believed only from this machine** — loopback, or the
 * private address a container runtime hands the host. The documented deploy
 * publishes the app on `127.0.0.1:3000` with nginx in front, and inside the
 * container that connection arrives from the bridge's gateway (`172.17.0.1`
 * under Docker, measured), not from 127.0.0.1, so loopback alone would refuse
 * every honest header and count every visitor as one. The header used to be
 * believed from anywhere when this was unset, so an instance published on a
 * public port took each caller's word for their address, and every limit and
 * lockout keyed on it was theirs to pick. **Set, the header is believed only
 * from a hop on the list** — the lever an operator behind Caddy, behind a load
 * balancer, or on another machine needs.
 */
export function trustedHeaderName(
  env: Record<string, string | undefined>,
): string {
  return env.SENTRELLO_CLIENT_IP_HEADER?.trim() || "x-real-ip";
}

export function trustedHops(env: Record<string, string | undefined>): string[] {
  return (
    env.SENTRELLO_TRUSTED_PROXIES?.split(",")
      .map((hop) => hop.trim())
      .filter(Boolean) ?? []
  );
}

/**
 * Where the documented proxy connects from: loopback, and the private ranges a
 * container bridge's gateway sits in. `::ffff:127.x` is read as the IPv4 it is
 * by `fromTrustedHop`, so the IPv4 ranges cover a dual-stack socket too.
 *
 * Private ranges, not the one bridge actually in use, so a machine
 * whose app port is reachable from its own LAN believes that LAN's headers;
 * an operator for whom that matters names the proxy in the list.
 */
export const LOCAL_HOPS = [
  "127.0.0.0/8",
  "::1",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
];

/** The hops a header is believed from: the list, or this machine when none. */
export function believedHops(
  env: Record<string, string | undefined>,
): string[] {
  const hops = trustedHops(env);
  return hops.length > 0 ? hops : LOCAL_HOPS;
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
 * Empty whenever there is no server to ask: a test driving a route through
 * `app.request()`, or a runtime that is not Bun's own. See `server-access.ts`
 * for why the adapter is not imported.
 */
function peerAddress(c: Pick<Context, "req">): {
  address?: string;
  port?: number;
} {
  const server = bunServer(c);
  if (typeof server?.requestIP !== "function") return {};
  try {
    return server.requestIP(c.req.raw) ?? {};
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
    if (fromTrustedHop(peerAddress(c).address, believedHops(env))) {
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

/**
 * The part of an address that names one caller, for a budget to count.
 *
 * An IPv4 address, whole. An IPv6 address by its first 64 bits: that is what
 * one connection is handed, so a caller counted per full address has 2^64 of
 * them to spend and a budget per address is no budget. `::ffff:` IPv4 comes
 * back as the IPv4 it is. Anything this cannot read is returned as it came,
 * which still counts it — only less generously grouped.
 */
export function addressBucket(ip: string): string {
  const plain = plainIp(ip.trim());
  if (!plain.includes(":")) return plain;
  const address = plain.split("%")[0]?.toLowerCase() ?? "";
  const halves = address.split("::");
  if (halves.length > 2) return plain;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves[1] ? halves[1].split(":") : [];
  // An IPv4 tail ("::1.2.3.4") is two groups' worth; it is never in the /64.
  const width = (groups: string[]) =>
    groups.reduce((n, g) => n + (g.includes(".") ? 2 : 1), 0);
  const missing = 8 - width(head) - width(tail);
  if (halves.length === 1 ? missing !== 0 : missing < 1) return plain;
  const groups = [...head, ...Array(missing).fill("0"), ...tail];
  const prefix = groups.slice(0, 4);
  if (!prefix.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return plain;
  return `${prefix.map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}
