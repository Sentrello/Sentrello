/**
 * Origin checking, rate limiting and bot detection for public endpoints.
 *
 * Embedded forms and public booking pages are unauthenticated by necessity —
 * they are pasted into other people's web pages — so these are the only thing
 * between a customer's data and the open internet. Shared here because every
 * module that opens a public endpoint needs the same three guards, and a second
 * implementation is a second set of mistakes.
 */

import { bodyLimit } from "hono/body-limit";
import { addressBucket, callerAddress } from "./caller";

export interface OriginDecision {
  allowed: boolean;
  /** Value for Access-Control-Allow-Origin, when allowed. */
  echo?: string;
}

/**
 * A form declares the domains permitted to post to it. The public form key is
 * visible in page source, so without this anyone could lift it and submit from
 * anywhere; the origin list is what makes the key worth something.
 *
 * An empty list means same-origin only — a form that has not been told where it
 * will live should not accept cross-site posts.
 *
 * **A request with no `Origin` header is refused once a list exists.** It used
 * to be allowed unconditionally, on the reasoning that it is either a
 * same-origin browser or a non-browser client — and the second half of that is
 * the whole problem. The public key is visible in anybody's page source, and
 * the origin list is what the docs say makes the key worth something; a script
 * that simply omits a header walked past it. Naming the places a form is
 * posted from is a statement, and a request from nowhere is not one of them.
 *
 * Where no list is configured nothing changes, because there is no statement
 * to contradict: a form that has not said where it lives is same-origin only,
 * and a header-less request is as likely to be that as anything else. Browsers
 * have sent `Origin` on cross-origin form posts and on every `fetch` for years,
 * so this refuses scripts and not customers. Found 2026-09-28.
 *
 * **`kind: "read"` is the exception, and it exists because the rule above broke
 * a documented integration.** Booking publishes two GETs — what can be booked
 * and which times are free — and the product's own screen tells a customer to
 * call them from their website's build step, which is a server-side request with
 * no `Origin` at all. So the moment a business listed its website, the path the
 * product had just told it to use answered 404. A same-origin GET from a browser
 * sends no `Origin` either: the header goes on cross-origin requests and on
 * writes, not on a same-origin read.
 *
 * Nothing is protected by refusing those: they answer what the public booking
 * page shows to anybody, and a script can send any `Origin` it likes. A write
 * stays strict — that is a state-changing call with a key out of somebody's page
 * source, which is what the paragraph above is about. Found 2026-09-29, when the
 * demo's own reseed could not read its own services.
 */
/**
 * Whether this origin is the instance itself.
 *
 * Compared against the address the request actually arrived on as well as the
 * configured base URL. An instance reached on a host nobody wrote into
 * `SENTRELLO_BASE_URL` — a bare IP, a port during setup, a second name — is
 * still talking to itself, and its own pages should not be refused by its own
 * module with a message about origins.
 *
 * Lived privately in the shop until 3 October, where it compensated for the
 * rule below outside the rule. Booking, the newsletter's embedded form and a
 * CRM form had no equivalent, so on an instance with nothing in its allow-list
 * an explicitly same-origin request was refused — by a rule whose own comment
 * says an empty list means same-origin only.
 */
export function sameOrigin(
  origin: string | undefined,
  requestUrl: string,
): boolean {
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }

  for (const candidate of [process.env.SENTRELLO_BASE_URL, requestUrl]) {
    if (!candidate) continue;
    try {
      if (new URL(candidate).host === host) return true;
    } catch {
      // A base URL somebody typed wrong is not a reason to refuse everything.
    }
  }
  return false;
}

export function originAllowed(
  origin: string | undefined,
  allowedOrigins: string[],
  /**
   * Required, with no default.
   *
   * The default was `"write"`, and it is what made this invisible four times:
   * three modules and a public page each inherited the strict rule for a read
   * and answered 404 to the one site they had been told they serve. A default
   * is a decision nobody made. Now the compiler asks, and
   * `scripts/reads-are-not-writes.ts` asks again for the places a type cannot
   * reach.
   */
  kind: "read" | "write",
  /**
   * The address this request arrived on, so "same-origin only" can be true
   * rather than aspirational.
   *
   * Required, with no default, for the reason `kind` is: the shop had this
   * check and three other public surfaces did not, so an instance with an
   * empty allow-list refused its own pages whenever they named themselves.
   * Pass `c.req.url`.
   */
  requestUrl: string,
): OriginDecision {
  if (!origin) {
    return { allowed: kind === "read" || allowedOrigins.length === 0 };
  }
  /*
   * The instance's own pages are always allowed to call its own API, whatever
   * the list says and whether the list is empty. A browser sends `Origin` on a
   * same-origin write, so without this the pages an instance serves itself are
   * refused by its own module — and on an empty list, which the paragraph above
   * calls "same-origin only", it was refused for being exactly that.
   */
  if (sameOrigin(origin, requestUrl)) {
    return { allowed: true, echo: origin };
  }
  if (allowedOrigins.length === 0) return { allowed: false };

  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return { allowed: false };
  }

  for (const entry of allowedOrigins) {
    const pattern = entry.trim().toLowerCase();
    if (!pattern) continue;

    // accept a bare host, a full origin, or a leading-wildcard subdomain
    const patternHost = pattern.includes("://")
      ? safeHost(pattern)
      : pattern.replace(/\/.*$/, "");
    if (!patternHost) continue;

    if (patternHost.startsWith("*.")) {
      const base = patternHost.slice(2);
      if (host === base || host.endsWith(`.${base}`)) {
        return { allowed: true, echo: origin };
      }
      continue;
    }
    if (host === patternHost) return { allowed: true, echo: origin };
  }
  return { allowed: false };
}

/**
 * Turn what somebody typed into the host the check compares against.
 *
 * People paste "https://example.com/contact", type "www.example.com " with a
 * stray space, or write "*.example.com". All three name a site, so all three
 * are accepted and stored as a host. Storing the raw text instead would mean a
 * form that silently refuses the very site it was made for, and the only clue
 * would be a console warning on somebody else's website.
 *
 * `null` for anything that is not a host, so the screen can say which entry is
 * wrong rather than saving a line that will never match.
 */
export function normalizeOrigin(entry: string): string | null {
  const raw = entry.trim().toLowerCase();
  if (!raw) return null;

  const wildcard = raw.startsWith("*.");
  const rest = wildcard ? raw.slice(2) : raw;
  const host = rest.includes("://")
    ? safeHost(rest)
    : rest.replace(/^\/+/, "").replace(/\/.*$/, "");

  // A host, optionally with a port. Anything else — a path, a space, an email
  // address — is a typo rather than a site.
  if (!host || !/^[a-z0-9-]+(\.[a-z0-9-]+)*(:\d+)?$/.test(host)) return null;
  return wildcard ? `*.${host}` : host;
}

function safeHost(value: string): string | undefined {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Sliding-window rate limit, per key, in memory.
 *
 * ponytail: single-process only. One app container is the shipped topology, so
 * this is enough; move it into Postgres or Redis if the host is ever scaled out,
 * or the limit becomes per-process rather than per-instance.
 */
const hits = new Map<string, number[]>();

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): { allowed: boolean; retryAfterSeconds: number } {
  const recent = (hits.get(key) ?? []).filter((at) => now - at < windowMs);

  if (recent.length >= limit) {
    const oldest = recent[0] ?? now;
    hits.set(key, recent);
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((windowMs - (now - oldest)) / 1000),
      ),
    };
  }

  recent.push(now);
  hits.set(key, recent);

  // keep the map from growing without bound on a long-lived process
  if (hits.size > 10_000) {
    for (const [k, times] of hits) {
      if (times.every((at) => now - at >= windowMs)) hits.delete(k);
    }
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Who is asking, for the purpose of counting how often they ask.
 *
 * `x-real-ip`, then the origin, then nothing. **Never `x-forwarded-for`**, and
 * that is the whole of this function's opinion.
 *
 * nginx sets `x-real-ip` from `$remote_addr`, replacing anything sent, so it
 * is the one address in a request a caller cannot choose. It sets
 * `X-Forwarded-For` with `$proxy_add_x_forwarded_for`, which *appends* the
 * real address to whatever arrived — so every entry but the last is text the
 * caller wrote. The storefront's limit was keyed on the first entry once, and
 * a fresh value on each request was a fresh budget on each request.
 *
 * The last entry is trustworthy behind our own proxy, and this deliberately
 * does not use it either: an instance with no proxy in front of it has no
 * trustworthy entry at all, and a limit that is sometimes forgeable depending
 * on the deployment is a limit nobody can reason about. A test flooding this
 * with a new `x-forwarded-for` each time is how that reasoning got checked —
 * it caught a draft of this function that did read the last entry.
 *
 * So: no proxy means every caller shares one budget, which is stricter than
 * the truth and never looser. The links module reads the chain for visitor
 * *counts*, where best-effort is the right trade and a forged number is a
 * wrong statistic rather than a bypassed guard; see `clientAddress` there.
 *
 * Takes the whole caller, not a route: a limit is about who is asking, and
 * each caller's budget is named by the prefix its own call site passes.
 *
 * **The address comes from `callerAddress`**, which is the one place that decides
 * whether a header may be believed. This used to read `x-real-ip` itself, as did
 * `clientAddress` in `@sentrello/auth`, and only one of the two honoured
 * `SENTRELLO_TRUSTED_PROXIES` — so an operator who set that variable had it
 * applied to sign-in attempts and ignored by every public rate limit in every
 * module. Six more copies of the same raw read were sitting in the newsletter
 * module. One answer now, and `caller.ts` carries the reasoning.
 *
 * The origin fallback stays here rather than moving: it is about *naming a
 * budget* when there is no address, which is this function's job and not a
 * question about who is calling.
 */
export function callerKey(c: Parameters<typeof callerAddress>[0]): string {
  const { ip } = callerAddress(c);
  // Per /64 for IPv6, as the API-key limit already was: one connection is
  // handed a whole block, and a budget per address in it is no budget.
  if (ip) return addressBucket(ip).slice(0, 45);
  return c.req.header("origin")?.slice(0, 80) ?? "anon";
}

/**
 * Whether a key has spent its budget, without spending any of it.
 *
 * For a limit counted on failures only — a wrong API key — where the question
 * before the work is "has this caller already guessed too often", and only a
 * miss should be counted afterwards. A script calling with a good key every
 * second must never be refused for succeeding.
 */
export function rateLimitSpent(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): boolean {
  return (
    (hits.get(key) ?? []).filter((at) => now - at < windowMs).length >= limit
  );
}

export function resetRateLimits() {
  hits.clear();
}

/** The field bots fill in and humans never see. */
/**
 * What a door with no account in front of it may send.
 *
 * Nothing bounded any of them. The server's own ceiling is sized for the one
 * feature that legitimately wants half a gigabyte — reading an archive back in,
 * behind a session and a permission — and until that ceiling was set explicitly
 * Bun's 128MB default was quietly standing in for a decision nobody had made.
 * Either way a public form is nothing like it: a checkout, a booking, a
 * subscribe box and a password on a share page are all a few hundred bytes, and
 * the gap between that and the ceiling is a gap anybody on the internet can
 * stand in.
 *
 * Counted off the stream as it arrives, not taken from `content-length`, which
 * is a claim by the sender. The answer is 413 and a sentence, because the
 * caller may well be a person who attached the wrong thing.
 *
 * Generous on purpose: a long message in a booking's notes, a cart with forty
 * lines and a provider's bounce payload all fit several times over. A route that
 * genuinely takes a file says its own number.
 */
export const MOST_PUBLIC_BYTES = 256 * 1024;

export function publicBodyLimit(maxBytes: number = MOST_PUBLIC_BYTES) {
  return bodyLimit({
    maxSize: maxBytes,
    onError: (c) =>
      c.text("That is more than this form takes. Try again with less.", 413),
  });
}

export const HONEYPOT_FIELD = "_sentrello_hp";

/** CORS headers for an allowed origin; nothing at all for a refused one. */
export function corsHeaders(
  origin: string | undefined,
): Record<string, string> {
  if (!origin) return {};
  return {
    "access-control-allow-origin": origin,
    /*
     * Every method the public routes actually answer.
     *
     * PATCH was missing, and a browser refuses a preflight whose method is not
     * on this list even when the preflight itself returns 204 — so a website on
     * another domain could read a basket and never change one. No email, no
     * address, no delivery option, and the failure lands as a CORS error with
     * nothing in the server log, because the request was never sent.
     *
     * It went unnoticed because the shop's own checkout page is served by the
     * instance, where none of this applies. The only caller that existed was
     * the one exempt from the rule.
     */
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

export function looksAutomated(payload: Record<string, unknown>): boolean {
  const trap = payload[HONEYPOT_FIELD];
  return typeof trap === "string" && trap.trim() !== "";
}
