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
        /*
         * Hashed assets may be kept as long as anything likes: the name
         * changes when the contents do, so a cached one is the right one.
         */
        if (pathname.startsWith("/assets/")) {
          return new Response(file, {
            headers: { "cache-control": "public, max-age=31536000, immutable" },
          });
        }
        return new Response(file);
      }
    }

    /*
     * The shell is revalidated every time, for the same reason `/sw.js` is.
     *
     * It carries no hash of its own and names which hashed assets to load, so
     * a browser holding an old copy loads an old application — and keeps doing
     * it, because nothing in that copy knows a newer one exists. It went out
     * with no `cache-control` at all, which leaves the decision to whatever
     * each browser does with a document that has no directive and no
     * validator: usually a refetch, sometimes not, and never something to rely
     * on for a business that has just run `sentrello update`.
     *
     * The service worker already answers navigations network-first, so this
     * changes nothing for anybody it controls. It is for the first visit, the
     * browser where it never registered, and the one where somebody cleared
     * it — which is exactly the case nobody tests and everybody eventually
     * hits.
     */
    const index = Bun.file(resolve(root, "index.html"));
    if (await index.exists()) {
      return new Response(index, { headers: { "cache-control": "no-cache" } });
    }
    return c.notFound();
  });
}
