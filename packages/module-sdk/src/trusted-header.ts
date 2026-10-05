/**
 * Who may read the trusted address header, and who must ask instead.
 *
 * `x-real-ip` is written by our own nginx from `$remote_addr`, so behind the
 * documented deployment a caller cannot forge it. Behind anything else — Caddy,
 * Traefik, a load balancer naming its own header, or an instance reached directly
 * — a caller sets it themselves, and a fresh value per request is a fresh budget
 * per request. `SENTRELLO_TRUSTED_PROXIES` exists for exactly that, and the only
 * code that honours it is `callerAddress`.
 *
 * Twelve places read the header raw instead. Two were the shared helpers
 * themselves — `callerKey` here and `clientAddress` in `@sentrello/auth` — which
 * is why setting the variable applied it to sign-in attempts and to nothing else:
 * every public rate limit in every module, the CRM's forms, invoicing's share
 * links, the newsletter's six doors, the buy page and the welcome flow all read it
 * directly. One answer now, and this is what stops a thirteenth copy.
 *
 * A scan rather than a type, because the fault is reading a string by name and no
 * type can forbid that.
 */

/** Reading the header, however it is spelled. */
const READS_IT =
  /(?:req\.header|headers\.get)\(\s*["'](?:x-real-ip|x-forwarded-for|cf-connecting-ip|true-client-ip)["']/i;

/** A comment, which is where this gets explained rather than done. */
const IS_COMMENT = /^\s*(\/\/|\*|\/\*)/;

/**
 * Said in writing, above the line, with a reason after it.
 *
 * One place genuinely wants the raw chain: the links module counts visitors, where
 * best-effort is the right trade and a forged entry is a wrong statistic rather
 * than a bypassed guard. That file says so at length, and this is how it keeps
 * saying it.
 */
const EXCUSED = /trusted-header-on-purpose:\s*\S/;

export interface RawHeaderRead {
  line: number;
  text: string;
  say: string;
}

export function findRawTrustedHeader(source: string): RawHeaderRead[] {
  const out: RawHeaderRead[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!READS_IT.test(line) || IS_COMMENT.test(line)) continue;
    const above = lines.slice(Math.max(0, i - 6), i);
    if (above.some((l) => IS_COMMENT.test(l) && EXCUSED.test(l))) continue;
    out.push({
      line: i + 1,
      text: line.trim(),
      say: "reads the caller's address straight out of a header, which a caller can set — use callerKey(c) to name a rate-limit budget, or callerAddress(c) for the address itself; both honour SENTRELLO_TRUSTED_PROXIES",
    });
  }
  return out;
}
