import { expect, test } from "bun:test";
import { clientIpOptions } from "./index";

/**
 * The header a client can set must not be the one we believe.
 *
 * `x-forwarded-for` is written by the caller. Keying rate limiting or a
 * lockout on it means an attacker chooses their own bucket, and the address
 * shown beside a session is whatever they typed.
 */
test("the default trusted header is one a proxy sets, not one a client sends", () => {
  const options = clientIpOptions({});
  expect(options.ipAddressHeaders).toEqual(["x-real-ip"]);
  expect(options.ipAddressHeaders).not.toContain("x-forwarded-for");
});

test("a deployment behind a different proxy can name its own header", () => {
  const options = clientIpOptions({
    SENTRELLO_CLIENT_IP_HEADER: "cf-connecting-ip",
  });
  expect(options.ipAddressHeaders).toEqual(["cf-connecting-ip"]);
});

test("trusted proxies are parsed into a list, and absent means none", () => {
  expect(
    clientIpOptions({ SENTRELLO_TRUSTED_PROXIES: "10.0.0.1, 10.0.0.0/24" })
      .trustedProxies,
  ).toEqual(["10.0.0.1", "10.0.0.0/24"]);
  expect(clientIpOptions({}).trustedProxies).toBeUndefined();
});
