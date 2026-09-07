import { expect, test } from "bun:test";
import {
  HONEYPOT_FIELD,
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
