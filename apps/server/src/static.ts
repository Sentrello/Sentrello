import { resolve, sep } from "node:path";
import type { SentrelloApp } from "@sentrello/module-sdk";

/**
 * Serves the built SPA. Registered last, after every module's routes, so it
 * only ever sees paths nothing else claimed.
 *
 * Unknown paths fall back to index.html because the client owns routing — but
 * never for /api, where a 404 must stay a 404 rather than returning HTML to
 * something expecting JSON.
 */
export function serveWeb(app: SentrelloApp, distDir?: string) {
  const root = resolve(
    distDir ??
      process.env.SENTRELLO_WEB_DIST ??
      `${import.meta.dir}/../../web/dist`,
  );

  app.get("*", async (c) => {
    const pathname = decodeURIComponent(new URL(c.req.url).pathname);
    if (pathname.startsWith("/api/")) return c.notFound();

    const requested = resolve(root, `.${pathname}`);
    // resolve() collapses ../ — anything that escapes the dist directory is a
    // traversal attempt, not a missing asset.
    const inside = requested === root || requested.startsWith(root + sep);

    if (inside) {
      const file = Bun.file(requested);
      if (await file.exists()) {
        /*
         * The service worker is never cached by the browser's own cache.
         *
         * It is the thing that decides what everything else is allowed to
         * remember, so a stale copy of it is a business that cannot be updated
         * by any means it knows about. Browsers already bypass the HTTP cache
         * when checking for a new worker; saying so as well costs nothing and
         * removes the question.
         */
        if (pathname === "/sw.js") {
          return new Response(file, {
            headers: { "cache-control": "no-cache" },
          });
        }
        return new Response(file);
      }
    }

    const index = Bun.file(resolve(root, "index.html"));
    if (await index.exists()) return new Response(index);
    return c.notFound();
  });
}
