/**
 * This instance's own address, for every absolute link it writes.
 *
 * An invitation, a password reset, a portal link, a share link, a webhook
 * address to paste into a processor: each is read somewhere other than the
 * request that made it, so each has to name the address the operator
 * configured. Twelve places wrote
 * `SENTRELLO_BASE_URL ?? new URL(c.req.url).origin` instead, and
 * `c.req.url` is built from the Host header. On an instance
 * reached directly, or behind a proxy that passes Host through, whoever sent
 * the request chose the domain in the link, and the link went out in our own
 * email. Found 13 October 2026.
 *
 * Two answers, because two kinds of caller want different things when nothing
 * is configured.
 */

/** What Better Auth is given when nothing is configured; one default, not two. */
export const DEFAULT_BASE_URL = "http://localhost:3000";

/**
 * The configured address, trimmed and without a trailing slash, or null.
 *
 * For anything read later and elsewhere: a reminder sent by a job, an
 * unsubscribe link, a customer's account page. A link to localhost in a
 * customer's inbox is a link to nowhere, so a caller with null leaves the
 * link out.
 */
export function configuredBaseUrl(): string | null {
  return process.env.SENTRELLO_BASE_URL?.trim().replace(/\/+$/, "") || null;
}

/**
 * The configured address, or the same default sign-in uses.
 *
 * For a link handed back to somebody at a screen right now, who would
 * rather see a wrong address they can recognise than nothing. Never the
 * request's own host.
 */
export function baseUrl(): string {
  return configuredBaseUrl() ?? DEFAULT_BASE_URL;
}
