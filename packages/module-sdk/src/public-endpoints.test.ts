import { expect, test } from "bun:test";

/** The address a request arrived on, for the same-origin half of the rule. */
const HERE = "https://instance.example/api/thing";
import {
  HONEYPOT_FIELD,
  callerKey,
  corsHeaders,
  looksAutomated,
  originAllowed,
  rateLimit,
  resetRateLimits,
} from "@sentrello/module-sdk";

test("a listed origin is allowed and echoed back", () => {
  const d = originAllowed(
    "https://acme.com",
    ["https://acme.com"],
    "write",
    HERE,
  );
  expect(d.allowed).toBe(true);
  expect(d.echo).toBe("https://acme.com");
});

test("a bare host in the list matches the origin", () => {
  expect(
    originAllowed("https://acme.com", ["acme.com"], "write", HERE).allowed,
  ).toBe(true);
  expect(
    originAllowed("http://acme.com", ["acme.com"], "write", HERE).allowed,
  ).toBe(true);
});

test("an unlisted origin is refused", () => {
  expect(
    originAllowed("https://evil.example", ["acme.com"], "write", HERE).allowed,
  ).toBe(false);
});

test("a lookalike domain does not slip through", () => {
  for (const origin of [
    "https://acme.com.evil.example",
    "https://notacme.com",
    "https://acme.com.co",
    "https://evilacme.com",
  ]) {
    expect(originAllowed(origin, ["acme.com"], "write", HERE).allowed).toBe(
      false,
    );
  }
});

test("a wildcard matches subdomains but not the bare domain's neighbours", () => {
  expect(
    originAllowed("https://shop.acme.com", ["*.acme.com"], "write", HERE)
      .allowed,
  ).toBe(true);
  expect(
    originAllowed("https://acme.com", ["*.acme.com"], "write", HERE).allowed,
  ).toBe(true);
  expect(
    originAllowed(
      "https://acme.com.evil.example",
      ["*.acme.com"],
      "write",
      HERE,
    ).allowed,
  ).toBe(false);
});

test("an empty allow-list means same-origin only", () => {
  // a form that has not been told where it lives must not accept cross-site posts
  expect(
    originAllowed("https://anywhere.example", [], "write", HERE).allowed,
  ).toBe(false);
  // no Origin header at all is a same-origin or non-browser request
  expect(originAllowed(undefined, [], "write", HERE).allowed).toBe(true);
});

test("a malformed origin is refused rather than throwing", () => {
  expect(originAllowed("not a url", ["acme.com"], "write", HERE).allowed).toBe(
    false,
  );
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

/**
 * A request with no Origin does not walk past the list.
 *
 * The public form key is visible in anybody's page source, and the origin list
 * is what the docs say makes the key worth something. A header-less request was
 * allowed unconditionally — "same-origin, or a non-browser client" — and the
 * second half of that is a script with curl posting to any form on any instance
 * whose key it has read. Found 2026-09-28.
 *
 * Browsers have sent `Origin` on cross-origin form posts and on every `fetch`
 * for years, so this refuses scripts rather than customers.
 */
test("no Origin is refused once a form has named where it lives", () => {
  expect(originAllowed(undefined, ["acme.com"], "write", HERE).allowed).toBe(
    false,
  );
  expect(originAllowed("", ["acme.com"], "write", HERE).allowed).toBe(false);

  /*
   * And nothing changes where no list is configured, because there is no
   * statement to contradict. A form that has not said where it lives is
   * same-origin only, and a header-less request is as likely to be that as
   * anything else.
   */
  expect(originAllowed(undefined, [], "write", HERE).allowed).toBe(true);

  // The named place still works, which is the case this must never break.
  expect(
    originAllowed("https://acme.com", ["acme.com"], "write", HERE).allowed,
  ).toBe(true);
});

/**
 * The documented integration, which the rule above had closed.
 *
 * Booking's own screen tells a customer to call `GET /api/booking/services` and
 * `GET /api/booking/slots` from their website's build step. That is a server-side
 * request with no `Origin`, so listing the website — the thing the product asks
 * for in the same breath — made the path answer 404. A same-origin GET from a
 * browser carries no `Origin` either.
 *
 * Reads are let through; writes are not, because a write is a state-changing call
 * with a key anybody can lift out of a page's source.
 */
test("a read with no Origin is allowed, and a write is not", () => {
  expect(originAllowed(undefined, ["acme.com"], "read", HERE).allowed).toBe(
    true,
  );
  expect(originAllowed(undefined, ["acme.com"], "write", HERE).allowed).toBe(
    false,
  );
  // The default is the strict one, so an endpoint has to ask for the exception.
  expect(originAllowed(undefined, ["acme.com"], "write", HERE).allowed).toBe(
    false,
  );
});

test("and a read from the wrong website is still refused", () => {
  // The exception is about the *absence* of a header, not about trusting one.
  expect(
    originAllowed("https://evil.example", ["acme.com"], "read", HERE).allowed,
  ).toBe(false);
  expect(
    originAllowed("https://acme.com", ["acme.com"], "read", HERE).allowed,
  ).toBe(true);
});

/**
 * The caller a limit counts, and the header it refuses to believe.
 *
 * nginx sets `X-Forwarded-For` with `$proxy_add_x_forwarded_for`, appending
 * the real address to whatever arrived, so every entry but the last is text
 * the caller wrote. The last one is trustworthy behind our own proxy and not
 * on an instance with nothing in front of it — and a limit that is forgeable
 * depending on the deployment is a limit nobody can reason about. So this
 * reads none of it.
 *
 * The cost is that a proxy-less instance puts every caller in one bucket,
 * which is stricter than the truth and never looser.
 */
test("a limit's caller cannot be chosen by the caller", () => {
  const ask = (headers: Record<string, string>) =>
    callerKey({ req: { header: (name: string) => headers[name] } });

  // The one value nginx replaces rather than appends to.
  expect(ask({ "x-real-ip": "198.51.100.7" })).toBe("198.51.100.7");

  // A forwarded chain says nothing here, however it is arranged.
  const forged = ask({ "x-forwarded-for": "203.0.113.1, 203.0.113.2" });
  expect(forged).not.toContain("203.0.113");
  expect(ask({ "x-forwarded-for": "203.0.113.9" })).toBe(
    ask({ "x-forwarded-for": "203.0.113.8" }),
  );

  // And it cannot beat the header it cannot set.
  expect(
    ask({ "x-real-ip": "198.51.100.7", "x-forwarded-for": "203.0.113.9" }),
  ).toBe("198.51.100.7");

  // Behind no proxy at all: the website asking, then one shared bucket.
  expect(ask({ origin: "https://shop.example" })).toBe("https://shop.example");
  expect(ask({})).toBe("anon");
});

/**
 * An instance's own pages are never refused by its own module.
 *
 * "An empty list means same-origin only" is what this rule has always said,
 * and with an explicit same-origin header it refused for being exactly that.
 * The shop carried its own `sameOrigin` check outside the rule to compensate;
 * booking, the newsletter's embedded form and a CRM form had none, so a fresh
 * instance — nothing in its allow-list — refused a request that named itself.
 *
 * Found by the release walk on 1.2.1, after the module probe started sending
 * the instance's own origin instead of none. The probe had been hiding it by
 * asking a question browsers do not ask.
 */
test("an instance's own origin is allowed, list or no list", () => {
  const here = "https://books.example/api/shop/storefront/shop";
  const mine = "https://books.example";

  // An empty list is "same-origin only", and this is same-origin.
  expect(originAllowed(mine, [], "write", here).allowed).toBe(true);
  expect(originAllowed(mine, [], "read", here).allowed).toBe(true);

  // A list that does not name it changes nothing: it is still the instance.
  expect(originAllowed(mine, ["shop.elsewhere"], "write", here).allowed).toBe(
    true,
  );

  // Somebody else is still somebody else, both ways.
  expect(originAllowed("https://evil.test", [], "write", here).allowed).toBe(
    false,
  );
  expect(
    originAllowed("https://evil.test", ["shop.elsewhere"], "read", here)
      .allowed,
  ).toBe(false);

  // And the configured base URL counts as the instance too, for a request
  // that arrived on a bare address during setup.
  const before = process.env.SENTRELLO_BASE_URL;
  process.env.SENTRELLO_BASE_URL = "https://books.example";
  try {
    expect(
      originAllowed(mine, [], "write", "http://10.0.0.4:3000/api/thing")
        .allowed,
    ).toBe(true);
  } finally {
    // Restored rather than deleted: one process holds the whole suite, so an
    // unset variable here is an unset variable in every file after it.
    process.env.SENTRELLO_BASE_URL = before;
  }
});
