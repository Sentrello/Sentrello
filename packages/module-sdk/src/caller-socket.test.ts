import { expect, test } from "bun:test";
import { callerAddress } from "./caller";

/**
 * The half of `callerAddress` no test could reach.
 *
 * Every test in these repositories drives a route through `app.request()`,
 * where there is no socket to ask — so the branch that reads the peer's own
 * address, and the one that decides whether to believe a header coming from it,
 * ran only in production. The address is now asked of the server the way Hono's
 * Bun adapter asks for it, rather than by importing that adapter: the import put
 * `hono/bun` into `@sentrello/db`'s graph, and drizzle-kit reads that under
 * Node, where `Bun` is not defined. Every module's `db:generate` died on
 * `ReferenceError: Bun is not defined` before it reached a table.
 *
 * So this stands in for the socket: Bun hands the server a `requestIP`, and a
 * context carries the server on `env`.
 */
type Caller = Parameters<typeof callerAddress>[0];

function from(
  headers: Record<string, string>,
  peer?: { address: string; port?: number },
): Caller {
  return {
    req: {
      header: (name: string) => headers[name],
      raw: new Request("http://localhost/"),
    },
    env: peer ? { requestIP: () => peer } : undefined,
  } as unknown as Caller;
}

test("with no header, the answer is the socket", () => {
  const who = callerAddress(
    from({}, { address: "198.51.100.4", port: 51234 }),
    {},
  );
  expect(who.ip).toBe("198.51.100.4");
  expect(who.port).toBe("51234");
  expect(who.proxied).toBe(false);
});

test("a header from a hop on the list is believed", () => {
  const who = callerAddress(
    from({ "x-real-ip": "203.0.113.9" }, { address: "10.0.0.5" }),
    { SENTRELLO_TRUSTED_PROXIES: "10.0.0.0/8" },
  );
  expect(who.ip).toBe("203.0.113.9");
  expect(who.proxied).toBe(true);
});

/*
 * And from anywhere else it is a claim, not an address.
 *
 * This is the whole point of the setting: behind Caddy, behind a load balancer
 * naming its own header, or reached directly, a caller writes `x-real-ip`
 * themselves — and a fresh value per request is a fresh rate-limit budget per
 * request.
 */
test("a header from anywhere else loses to the socket", () => {
  const who = callerAddress(
    from({ "x-real-ip": "203.0.113.9" }, { address: "203.0.113.200" }),
    { SENTRELLO_TRUSTED_PROXIES: "10.0.0.0/8" },
  );
  expect(who.ip).toBe("203.0.113.200");
  expect(who.proxied).toBe(false);
});

/*
 * `::ffff:127.0.0.1` is how a dual-stack socket reports an IPv4 peer, and it is
 * what Bun hands back. Without the normalisation, a list naming `127.0.0.1`
 * matches nothing and every instance that set the variable is quietly tightened
 * — several callers counted as one, with nothing to say why.
 */
test("a list naming an IPv4 hop matches the socket's mapped form", () => {
  const who = callerAddress(
    from({ "x-real-ip": "203.0.113.9" }, { address: "::ffff:127.0.0.1" }),
    { SENTRELLO_TRUSTED_PROXIES: "127.0.0.1" },
  );
  expect(who.ip).toBe("203.0.113.9");
});

/*
 * Unset, the header is believed from this machine only.
 *
 * The documented deploy publishes the app on 127.0.0.1 with nginx in front, and
 * inside the container that connection arrives from the bridge's gateway
 * (172.17.0.1 under Docker), so both have to count. It used to be believed from
 * anywhere, which handed every caller on an instance published on its own port
 * a fresh budget per request.
 */
test("an unset list believes the header from this machine, the documented deployment", () => {
  for (const address of [
    "172.17.0.1",
    "10.88.0.1",
    "127.0.0.1",
    "127.8.9.10",
    "::1",
    "::ffff:127.0.0.1",
  ]) {
    const who = callerAddress(
      from({ "x-real-ip": "203.0.113.9" }, { address }),
      {},
    );
    expect(who.ip, `${address} was not believed`).toBe("203.0.113.9");
    expect(who.proxied).toBe(true);
  }
});

test("an unset list does not believe the header from anywhere else", () => {
  for (const address of [
    "203.0.113.200",
    "172.32.0.1",
    "::ffff:198.51.100.5",
    "2001:db8::1",
  ]) {
    const who = callerAddress(
      from({ "x-real-ip": "203.0.113.9" }, { address }),
      {},
    );
    expect(who.ip).toBe(address);
    expect(who.proxied).toBe(false);
  }
});

/*
 * And a server that cannot be asked answers nothing rather than throwing. Hono's
 * adapter throws a TypeError here; a rate limit is not worth a 500.
 */
test("no server to ask is not an error", () => {
  expect(callerAddress(from({}), {}).ip).toBeUndefined();
  const odd = {
    req: {
      header: () => undefined,
      raw: new Request("http://localhost/"),
    },
    env: {
      requestIP: () => {
        throw new TypeError("server.requestIP is not a function.");
      },
    },
  } as unknown as Caller;
  expect(callerAddress(odd, {}).ip).toBeUndefined();
});
