import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Whether this process may send anything to a customer-supplied URL.
 *
 * A webhook or HTTP-step URL is typed by somebody with permission to
 * configure a module, and the request goes out from a machine that can reach
 * the database, the other containers and the hypervisor's metadata service.
 * On a cloud host, `http://169.254.169.254/` hands out credentials to
 * whoever asks from the right place — and this would be asking from the
 * right place. That is server-side request forgery, and "only an admin can
 * configure it" is not an answer: an admin account is exactly what somebody
 * who has phished their way in is using.
 *
 * In the SDK because every module that calls out needs the same judgement,
 * and a second copy is a copy that lets one range through in one repository
 * only. The rules:
 *
 * - **A name is resolved first**, and the address it resolves to is what is
 *   judged. Refusing `127.0.0.1` while allowing a domain that points at it
 *   would be a check that only stops the honest.
 * - **Private, loopback, link-local, carrier-NAT and unspecified addresses
 *   are refused**, in both IPv4 and IPv6, including IPv4 written as IPv6.
 * - **Senders must not follow redirects** — a redirect is the same check
 *   again from a place we are no longer looking.
 * - **https unless somebody says otherwise**, because business data over
 *   plain http is business data anybody on the path can read.
 * - **Judged again before every send**, by the caller, because DNS can
 *   change its answer between the day a URL was accepted and today — a
 *   creation-time check is exactly what rebinding defeats.
 *
 * There is a window between resolving a name and connecting to it in which
 * the answer can change — DNS rebinding proper. Closing it entirely means
 * doing our own connecting, which is a great deal of machinery; what it buys
 * over re-checking per send is small, and it is written down here rather
 * than left as something nobody thought about.
 */

/** As far as we are concerned, nothing on this list is on the internet. */
export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts as [number, number, number, number];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local, and the metadata one
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    // Carrier-grade NAT: not the public internet either.
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (kind === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    // Unique-local and link-local.
    if (/^f[cd]/.test(lower) || lower.startsWith("fe80")) return true;
    /*
     * An IPv4 address wearing an IPv6 hat, in either of the two ways it is
     * written: `::ffff:127.0.0.1` is loopback, and so is `::ffff:7f00:1` —
     * the same address after a URL parser has normalised it, which is the
     * form that actually arrives.
     */
    const dotted = lower.split(":").pop() ?? "";
    if (isIP(dotted) === 4) return isPrivateAddress(dotted);

    const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex?.[1] && hex[2]) {
      const high = Number.parseInt(hex[1], 16);
      const low = Number.parseInt(hex[2], 16);
      const quad = [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
      return isPrivateAddress(quad);
    }
    return false;
  }
  return false;
}

export interface Reachable {
  ok: true;
  address: string;
}

export interface Refused {
  ok: false;
  why: string;
}

/** Whether anything may be sent to this address, and why not when not. */
export async function mayCall(
  url: string,
  opts: { allowInsecure?: boolean } = {},
): Promise<Reachable | Refused> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, why: "that is not a web address" };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, why: "only http and https can be called" };
  }
  if (parsed.protocol === "http:" && !opts.allowInsecure) {
    return {
      ok: false,
      why: "that address is not https, so anything sent to it can be read on the way",
    };
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const address = isIP(host) ? host : await resolveOrNothing(host);
  if (!address) {
    return { ok: false, why: "that address does not resolve to anything" };
  }
  if (isPrivateAddress(address)) {
    return {
      ok: false,
      why: "that address is inside this server's own network, which a webhook may not reach",
    };
  }
  return { ok: true, address };
}

async function resolveOrNothing(host: string): Promise<string | null> {
  try {
    const { address } = await lookup(host);
    return address;
  } catch {
    return null;
  }
}

/**
 * What goes in an outbound call's signature header:
 * `t=<unix seconds>,v1=<hex>`.
 *
 * The HMAC covers the timestamp as well as the body, so a captured call
 * cannot be replayed later as a fresh one — a receiver that checks the
 * timestamp is checking something the signature vouches for.
 */
export function signOutbound(
  secret: string,
  timestamp: number,
  body: string,
): string {
  const mac = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return `t=${timestamp},v1=${mac}`;
}
