import { expect, test } from "bun:test";
import { fraudPreventionHeaders, missingHeaders } from "./mtd-headers";

/**
 * The four things HMRC's own validator refused, and one it warned about.
 *
 * Every assertion here comes from an actual rejection by
 * `POST /test/fraud-prevention-headers/validate` in the sandbox on 2026-09-09,
 * not from reading the specification. The specification did not make any of
 * them obvious, and a submission rejected at quarter end is a bad way to find
 * out.
 */
const client = {
  deviceId: "beec798b-b366-47fa-b1f8-92cd14665123",
  screens: "width=1920&height=1080&scaling-factor=2&colour-depth=24",
  windowSize: "width=1256&height=803",
  timezone: "UTC+00:00",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
};
const server = {
  clientIp: "203.0.113.42",
  clientPort: "51423",
  vendorIp: "143.244.185.149",
  userId: "user-1",
  productVersion: "0.26.7",
  licenceId: "LIC-TEST",
  multiFactor: {
    type: "TOTP",
    timestamp: "2026-09-09T20:00:00Z",
    reference: "abc123",
  },
};

test("the header set HMRC accepted is complete", () => {
  expect(missingHeaders(fraudPreventionHeaders(client, server))).toEqual([]);
});

/** "Value must not be percent encoded" — the one header that is the exception. */
test("the browser user agent is sent raw, unlike everything else", () => {
  const h = fraudPreventionHeaders(client, server);
  expect(h["Gov-Client-Browser-JS-User-Agent"]).toBe(client.userAgent);
  expect(h["Gov-Client-Browser-JS-User-Agent"]).not.toContain("%20");
});

/** "At least 1 user identifier is required" — `os=` is not ours to claim. */
test("the user is keyed by us, not as an operating system account", () => {
  const h = fraudPreventionHeaders(client, server);
  expect(h["Gov-Client-User-IDs"]).toBe("sentrello=user-1");
});

/**
 * "At least 1 value for license is not hashed."
 *
 * They are right to refuse it. The header identifies which installation
 * submitted, which is all they need; the key itself is a credential and has no
 * reason to leave the building.
 */
test("the licence key is hashed, never sent", () => {
  const h = fraudPreventionHeaders(client, server);
  expect(h["Gov-Vendor-License-IDs"]).not.toContain("LIC-TEST");
  expect(h["Gov-Vendor-License-IDs"]).toMatch(/^sentrello=[0-9a-f]{64}$/);
});

/**
 * "At least 1 pair of IPs in Gov-Vendor-Forwarded must include
 * Gov-Client-Public-IP in the 'for' field."
 */
test("the forwarded chain ties the client to this server", () => {
  const h = fraudPreventionHeaders(client, server);
  expect(h["Gov-Vendor-Forwarded"]).toContain(`for=${server.clientIp}`);
  expect(h["Gov-Vendor-Forwarded"]).toContain(`by=${server.vendorIp}`);
});

/**
 * What is not known is left out.
 *
 * A wrong value is a false statement to a tax authority about how a return was
 * submitted; an absent one is a gap they can see and ask about. The screen
 * warns before submitting rather than letting a rejection be the first news.
 */
test("a browser that supplied nothing produces gaps, not inventions", () => {
  const h = fraudPreventionHeaders({}, server);
  expect(h["Gov-Client-Screens"]).toBeUndefined();
  expect(h["Gov-Client-Timezone"]).toBeUndefined();
  expect(missingHeaders(h).length).toBeGreaterThan(0);
  // And what is knowable server-side is still there.
  expect(h["Gov-Client-Public-IP"]).toBe(server.clientIp);
});

/** Signing in with a password alone reports nothing, rather than falsifying. */
test("multi-factor is absent when no second factor was used", () => {
  const h = fraudPreventionHeaders(client, {
    ...server,
    multiFactor: undefined,
  });
  expect(h["Gov-Client-Multi-Factor"]).toBeUndefined();
});
