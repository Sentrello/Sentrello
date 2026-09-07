import type { SentrelloApp, SentrelloModule } from "@sentrello/module-sdk";

/**
 * Serves screens that came with a module.
 *
 * Pro and the optional modules cannot ship their screens inside this repo —
 * Core is public and AGPL — so each bundle carries a prebuilt file and the host
 * hands it to the browser at `/modules/<id>/ui.js`.
 *
 * Only loaded modules are served. A module the licence did not grant has no
 * entry in the map, so its script is genuinely absent rather than merely hidden
 * by the interface.
 *
 * Returns the ids that have screens, for `/api/_meta` to advertise.
 */
export function serveModuleUi(
  app: SentrelloApp,
  modules: SentrelloModule[],
  loaded: string[],
): string[] {
  const paths = new Map(
    modules
      .filter((m) => m.ui && loaded.includes(m.id))
      .map((m) => [m.id, m.ui as string]),
  );

  /**
   * A module's own stylesheet, sitting beside its script.
   *
   * Modules need one: Tailwind builds Core's stylesheet by scanning Core's
   * source, so a class a module uses and Core does not would simply not exist.
   * Each module therefore compiles its own utilities.
   */
  app.get("/modules/:id/ui.css", async (c) => {
    const js = paths.get(c.req.param("id"));
    if (!js) return c.notFound();

    const file = Bun.file(js.replace(/\.js$/, ".css"));
    if (!(await file.exists())) return c.notFound();

    return new Response(file, {
      headers: {
        "content-type": "text/css; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
    });
  });

  app.get("/modules/:id/ui.js", async (c) => {
    // The path served comes from the module, never from the request: the id is
    // only ever a map key, so there is nothing here to traverse with.
    const path = paths.get(c.req.param("id"));
    if (!path) return c.notFound();

    const file = Bun.file(path);
    if (!(await file.exists())) return c.notFound();

    return new Response(file, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        // Rebuilt per release and served by the instance itself.
        "cache-control": "public, max-age=300",
      },
    });
  });

  return [...paths.keys()];
}
