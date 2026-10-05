import { expect, test } from "bun:test";
import { trustedHeaderName, trustedHops } from "@sentrello/module-sdk";
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

/**
 * The library and the product believe the same header, by construction.
 *
 * This file held its own copy of the `x-real-ip` default and its own
 * comma-splitting, beside the copy in the SDK that every other reader of the
 * caller's address goes through. If those two ever drifted, Better Auth would
 * rate-limit a sign-in on one address while the lockout counted another — two
 * answers to one question, in the place where that is worst.
 *
 * They are one call now. This asserts it rather than trusting the diff, because
 * the cheap way to reintroduce it is to inline a default back "for clarity".
 */
test("Better Auth is handed the header the rest of the product believes", () => {
  for (const env of [
    {},
    { SENTRELLO_CLIENT_IP_HEADER: "cf-connecting-ip" },
    { SENTRELLO_CLIENT_IP_HEADER: "  true-client-ip  " },
    { SENTRELLO_TRUSTED_PROXIES: "10.0.0.1, 10.0.0.0/24" },
  ]) {
    expect(clientIpOptions(env).ipAddressHeaders).toEqual([
      trustedHeaderName(env),
    ]);
    expect(clientIpOptions(env).trustedProxies ?? []).toEqual(trustedHops(env));
  }
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

/**
 * And the list has to reach the helper every module actually calls.
 *
 * `SENTRELLO_TRUSTED_PROXIES` was handed to Better Auth and ignored by
 * `clientAddress` — so one variable meant "only believe these hops" to Better
 * Auth's own rate limit and nothing at all to `clientIp`, which is what every
 * public limiter and every audited address goes through.
 *
 * Driven through a real server, because the whole question is where the
 * connection came from and `app.request()` has no socket to ask.
 */
async function askFrom(
  env: Record<string, string | undefined>,
  header: string,
): Promise<{ ip?: string; proxied: boolean }> {
  const { Hono } = await import("hono");
  const { clientAddress } = await import("./index");
  const app = new Hono();
  app.get("/who", (c) => c.json(clientAddress(c)));

  const before = {
    SENTRELLO_TRUSTED_PROXIES: process.env.SENTRELLO_TRUSTED_PROXIES,
  };
  // An empty string reads as absent to `clientIpOptions`, which filters blanks
  // out of the split, and biome refuses `delete` here on performance grounds.
  process.env.SENTRELLO_TRUSTED_PROXIES = env.SENTRELLO_TRUSTED_PROXIES ?? "";

  const server = Bun.serve({ port: 0, fetch: app.fetch });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/who`, {
      headers: { "x-real-ip": header },
    });
    return (await res.json()) as { ip?: string; proxied: boolean };
  } finally {
    server.stop(true);
    process.env.SENTRELLO_TRUSTED_PROXIES =
      before.SENTRELLO_TRUSTED_PROXIES ?? "";
  }
}

test("with no list, the header is believed — the documented deployment", async () => {
  const answer = await askFrom({}, "203.0.113.9");
  expect(answer.ip).toBe("203.0.113.9");
  expect(answer.proxied).toBe(true);
});

test("with a list, a header from a hop not on it is a claim, not an address", async () => {
  // The connection is from loopback; the list names a hop that is not.
  const answer = await askFrom(
    { SENTRELLO_TRUSTED_PROXIES: "10.0.0.1" },
    "203.0.113.9",
  );
  expect(answer.ip).not.toBe("203.0.113.9");
  expect(answer.proxied).toBe(false);
});

test("a hop on the list is believed, by address and by range", async () => {
  for (const list of ["127.0.0.1", "127.0.0.0/8", "127.0.0.1,10.0.0.1"]) {
    const answer = await askFrom(
      { SENTRELLO_TRUSTED_PROXIES: list },
      "203.0.113.9",
    );
    expect(answer.ip, `the list ${list} did not believe loopback`).toBe(
      "203.0.113.9",
    );
  }
});

/** A typo tightens rather than loosens, which is the safe direction. */
test("an entry that cannot be parsed matches nothing", async () => {
  const answer = await askFrom(
    { SENTRELLO_TRUSTED_PROXIES: "not-an-address,10.0.0.0/99" },
    "203.0.113.9",
  );
  expect(answer.ip).not.toBe("203.0.113.9");
});
