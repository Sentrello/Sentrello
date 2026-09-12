import { expect, test } from "bun:test";
import {
  HONEYPOT_FIELD,
  corsHeaders,
  looksAutomated,
  originAllowed,
  rateLimit,
  resetRateLimits,
} from "@sentrello/module-sdk";

test("a listed origin is allowed and echoed back", () => {
  const d = originAllowed("https://acme.com", ["https://acme.com"]);
  expect(d.allowed).toBe(true);
  expect(d.echo).toBe("https://acme.com");
});

test("a bare host in the list matches the origin", () => {
  expect(originAllowed("https://acme.com", ["acme.com"]).allowed).toBe(true);
  expect(originAllowed("http://acme.com", ["acme.com"]).allowed).toBe(true);
});

test("an unlisted origin is refused", () => {
  expect(originAllowed("https://evil.example", ["acme.com"]).allowed).toBe(
    false,
  );
});

test("a lookalike domain does not slip through", () => {
  for (const origin of [
    "https://acme.com.evil.example",
    "https://notacme.com",
    "https://acme.com.co",
    "https://evilacme.com",
  ]) {
    expect(originAllowed(origin, ["acme.com"]).allowed).toBe(false);
  }
});

test("a wildcard matches subdomains but not the bare domain's neighbours", () => {
  expect(originAllowed("https://shop.acme.com", ["*.acme.com"]).allowed).toBe(
    true,
  );
  expect(originAllowed("https://acme.com", ["*.acme.com"]).allowed).toBe(true);
  expect(
    originAllowed("https://acme.com.evil.example", ["*.acme.com"]).allowed,
  ).toBe(false);
});

test("an empty allow-list means same-origin only", () => {
  // a form that has not been told where it lives must not accept cross-site posts
  expect(originAllowed("https://anywhere.example", []).allowed).toBe(false);
  // no Origin header at all is a same-origin or non-browser request
  expect(originAllowed(undefined, []).allowed).toBe(true);
});

test("a malformed origin is refused rather than throwing", () => {
  expect(originAllowed("not a url", ["acme.com"]).allowed).toBe(false);
});

test("the rate limit lets a burst through and then holds", () => {
  resetRateLimits();
  const now = Date.now();
  for (let i = 0; i < 5; i++) {
    expect(rateLimit("form:1.2.3.4", 5, 60_000, now).allowed).toBe(true);
  }
  const blocked = rateLimit("form:1.2.3.4", 5, 60_000, now);
  expect(blocked.allowed).toBe(false);
  expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
});

test("the window slides, so a client is not banned forever", () => {
  resetRateLimits();
  const now = Date.now();
  for (let i = 0; i < 5; i++) rateLimit("form:5.6.7.8", 5, 60_000, now);
  expect(rateLimit("form:5.6.7.8", 5, 60_000, now).allowed).toBe(false);
  expect(rateLimit("form:5.6.7.8", 5, 60_000, now + 60_001).allowed).toBe(true);
});

test("clients are limited independently", () => {
  resetRateLimits();
  const now = Date.now();
  for (let i = 0; i < 5; i++) rateLimit("form:a", 5, 60_000, now);
  expect(rateLimit("form:a", 5, 60_000, now).allowed).toBe(false);
  expect(rateLimit("form:b", 5, 60_000, now).allowed).toBe(true);
});

test("a filled honeypot marks the submission automated", () => {
  expect(looksAutomated({ [HONEYPOT_FIELD]: "http://spam.example" })).toBe(
    true,
  );
  expect(looksAutomated({ [HONEYPOT_FIELD]: "  " })).toBe(false);
  expect(looksAutomated({ [HONEYPOT_FIELD]: "" })).toBe(false);
  expect(looksAutomated({ name: "A real person" })).toBe(false);
});

/**
 * Every method the public routes answer has to be on the list.
 *
 * A browser refuses a preflight whose method is not advertised here, even when
 * the preflight itself returns 204 — so a route can be perfectly willing and
 * still unreachable from another website. PATCH was missing, which meant a shop
 * on its own domain could read a basket and never change one: no email, no
 * address, no delivery option.
 *
 * It hid because the instance's own checkout page is served by the instance,
 * where cross-origin rules do not apply at all. The only caller that existed
 * was the one exempt from the rule, and it worked perfectly.
 */
test("the methods a storefront needs are all advertised", () => {
  const headers = corsHeaders("https://shop.example");
  const allowed = (headers["access-control-allow-methods"] ?? "")
    .split(",")
    .map((m) => m.trim());

  // Read a basket, make one, change one.
  expect(allowed).toContain("GET");
  expect(allowed).toContain("POST");
  expect(allowed).toContain("PATCH");
  // And the preflight itself.
  expect(allowed).toContain("OPTIONS");

  // Nothing is advertised to a caller with no origin: there is nothing to
  // allow, and an allow-list handed out unasked is one somebody relies on.
  expect(corsHeaders(undefined)).toEqual({});
});
