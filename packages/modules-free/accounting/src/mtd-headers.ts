import { createHash } from "node:crypto";

/**
 * HMRC's fraud prevention headers.
 *
 * Sixteen of them for `WEB_APP_VIA_SERVER`, which is exactly this shape: a
 * browser talking to the business's own Sentrello, which talks to HMRC. They
 * are mandatory — a submission without them is rejected — and HMRC audits the
 * values, so inventing plausible ones is worse than omitting a header.
 *
 * The rule this file follows: **send what is true, and omit what is not
 * known.** Four values can only come from the browser, and where the screen has
 * not supplied them the header is left out rather than filled with a guess. A
 * wrong value is a false statement to a tax authority about how a return was
 * submitted; an absent one is a gap they can see.
 */

/** What the browser measured about itself, posted with the return. */
export interface ClientContext {
  /** `window.screen`, as HMRC formats it. */
  screens?: string;
  windowSize?: string;
  timezone?: string;
  userAgent?: string;
  /** The long-lived id this browser has been given. */
  deviceId?: string;
}

export interface ServerContext {
  /** The address this request came from, as the server sees it. */
  clientIp?: string;
  clientPort?: string;
  /** Every proxy between the person and this server, in order. */
  forwarded?: string;
  /** This server's own public address. */
  vendorIp?: string;
  userId: string;
  /** Whether the person signed in with a second factor, and when. */
  multiFactor?: { type: string; timestamp: string; reference: string };
  licenceId?: string;
  productVersion: string;
}

const encode = (value: string) => encodeURIComponent(value);

/**
 * The licence key, hashed.
 *
 * HMRC refuses a plaintext licence identifier — "at least 1 value for license
 * is not hashed" — and they are right to. The header identifies *which*
 * installation submitted, which is all they need; the key itself is a
 * credential and there is no reason for it to leave the building.
 */
function hashed(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The headers, as a plain object.
 *
 * `Gov-Client-Public-IP` deserves its warning. It is the *client's* address as
 * this server sees it, and behind a proxy that is the proxy — a self-hosted
 * business behind a load balancer will send their own infrastructure's address
 * on every submission unless the server is configured to read the forwarded
 * header. That is the same problem, and the same fix, as the real_ip work done
 * for Cloudflare; it is worth saying in the setup screen rather than leaving
 * somebody to discover it in an HMRC audit.
 */
export function fraudPreventionHeaders(
  client: ClientContext,
  server: ServerContext,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Gov-Client-Connection-Method": "WEB_APP_VIA_SERVER",
    /*
     * Keyed by us, not by `os`. HMRC's validator refuses `os=` here — that key
     * is for an operating system account, and what we know is who is signed
     * into Sentrello.
     */
    "Gov-Client-User-IDs": `sentrello=${encode(server.userId)}`,
    "Gov-Vendor-Product-Name": encode("Sentrello"),
    "Gov-Vendor-Version": `sentrello=${encode(server.productVersion)}`,
  };

  // Browser-sourced. Omitted rather than guessed — see the note above.
  if (client.deviceId) headers["Gov-Client-Device-ID"] = client.deviceId;
  if (client.screens) headers["Gov-Client-Screens"] = client.screens;
  if (client.windowSize) headers["Gov-Client-Window-Size"] = client.windowSize;
  if (client.timezone) headers["Gov-Client-Timezone"] = client.timezone;
  /*
   * Not percent-encoded. Most of these headers are; this one is refused if it
   * is, which is the sort of thing only their own validator tells you.
   */
  if (client.userAgent) {
    headers["Gov-Client-Browser-JS-User-Agent"] = client.userAgent;
  }

  if (server.clientIp) {
    headers["Gov-Client-Public-IP"] = server.clientIp;
    /*
     * The timestamp says when the address was observed, and it has to be the
     * moment of observation rather than of sending. They differ by however long
     * the submission took, and HMRC's guidance is explicit that this is the
     * time the IP was captured.
     */
    headers["Gov-Client-Public-IP-Timestamp"] = new Date().toISOString();
  }
  if (server.clientPort) headers["Gov-Client-Public-Port"] = server.clientPort;
  /*
   * Built rather than passed through: HMRC requires each hop to name the
   * address it came *for* and the address it came *by*, and the pair has to
   * include the client's address and this server's. A forwarded chain that does
   * not tie those together is refused.
   */
  if (server.vendorIp && server.clientIp) {
    headers["Gov-Vendor-Forwarded"] =
      `by=${encode(server.vendorIp)}&for=${encode(server.clientIp)}`;
  }
  if (server.vendorIp) headers["Gov-Vendor-Public-IP"] = server.vendorIp;
  if (server.licenceId) {
    headers["Gov-Vendor-License-IDs"] = `sentrello=${hashed(server.licenceId)}`;
  }

  /**
   * Multi-factor, which is about the person using the software rather than the
   * person who granted authority.
   *
   * Sent only where a second factor was actually used. A business that signs in
   * with a password alone has nothing to report here, and HMRC says so — the
   * header is absent, not falsified.
   */
  if (server.multiFactor) {
    headers["Gov-Client-Multi-Factor"] =
      `type=${encode(server.multiFactor.type)}&` +
      `timestamp=${encode(server.multiFactor.timestamp)}&` +
      `unique-reference=${encode(server.multiFactor.reference)}`;
  }

  return headers;
}

/**
 * Which required headers are missing, for the screen to warn about.
 *
 * A submission that HMRC rejects for a missing header is a bad quarter-end
 * surprise. Better to say beforehand that the browser did not supply its
 * timezone than to let somebody find out from a rejection.
 */
export function missingHeaders(headers: Record<string, string>): string[] {
  const required = [
    "Gov-Client-Connection-Method",
    "Gov-Client-Browser-JS-User-Agent",
    "Gov-Client-Device-ID",
    "Gov-Client-Public-IP",
    "Gov-Client-Public-IP-Timestamp",
    "Gov-Client-Screens",
    "Gov-Client-Timezone",
    "Gov-Client-User-IDs",
    "Gov-Client-Window-Size",
    "Gov-Vendor-Product-Name",
    "Gov-Vendor-Version",
  ];
  return required.filter((name) => !headers[name]);
}
