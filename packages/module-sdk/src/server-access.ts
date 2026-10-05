import type { Context } from "hono";

/**
 * Reaching Bun's server through the context, without importing its adapter.
 *
 * `hono/bun` exports two helpers that are each a handful of lines, and importing
 * either of them puts `hono/bun` into the import graph of `@sentrello/db` — which
 * drizzle-kit reads under Node, where `Bun` is not defined. Every module's
 * `db:generate` died on that for weeks. So the lines live here, and
 * `packages/db/src/node-can-read-the-schema.test.ts` is what keeps them here.
 *
 * Hono's Bun adapter is called as `fetch(request, server)`, so the server is
 * what lands on `c.env` — behind a `server` property on some setups.
 */
interface BunServer {
  requestIP?: (request: Request) => { address?: string; port?: number } | null;
  timeout?: (request: Request, seconds: number) => void;
}

export function bunServer(c: Pick<Context, "req">): BunServer | undefined {
  const env = (c as { env?: unknown }).env;
  if (!env || typeof env !== "object") return undefined;
  return (
    "server" in env ? (env as { server?: unknown }).server : env
  ) as BunServer;
}

/**
 * This one is allowed to take a while.
 *
 * **`Bun.serve` closes a connection after ten seconds of inactivity, and a
 * handler that has not written a byte counts as inactive.** So any request whose
 * work takes longer than ten seconds is killed with no response at all — the
 * caller sees a connection reset, the route never finishes, and the only trace
 * is one line on the server's own stdout. The default is a ceiling nobody
 * chose and it was the first thing in the chain to bite: nginx's own read
 * timeout is a minute, and the proxy in the published install instructions
 * names no timeout at all.
 *
 * The server's ceiling is generous now, and these are the routes that still want
 * more: reading a half-gigabyte archive back in, importing a bank statement or a
 * list of subscribers, storing a hundred-megabyte file. All of them are one
 * person waiting at a screen, having pressed a button that says it will take a
 * moment.
 *
 * A number, never nought: a request that cannot time out is a connection nobody
 * can get back. Silent when there is no server to ask, which is every test that
 * drives a route through `app.request()`.
 */
export function allowLongRequest(c: Pick<Context, "req">, seconds: number) {
  const server = bunServer(c);
  if (typeof server?.timeout !== "function") return;
  // Bun's own ceiling, and it refuses anything above it.
  server.timeout(c.req.raw, Math.max(1, Math.min(255, Math.floor(seconds))));
}
