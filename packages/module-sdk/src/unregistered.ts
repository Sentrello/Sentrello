import { pathShape, registeredRoutes, requestedPaths } from "./reachability";
import { templateRoutes } from "./reachability";

/**
 * The other direction: a screen asking for a route nobody registered.
 *
 * `unreachableRoutes` asks whether a route has a screen. This asks whether a
 * screen's request has a route, and it is the question that catches a whole
 * class the first one cannot: a button that answers 404. Two were found the
 * day it was written, both in Shop, both there since the screen was —
 *
 *   - the settings save sent PATCH to a route registered only as PUT;
 *   - the Remove button on every discount sent a DELETE that did not exist.
 *
 * Neither could be found by asking about routes, because the failure is a
 * request with nothing behind it. Both had tests on the route and tests on the
 * screen, and each test used the verb its own side already used.
 */
export function unregisteredRequests(args: {
  /** Directories of route source, from every repository on this machine. */
  routeFiles: string[];
  screenFiles: string[];
  /** Requests something other than this platform answers, and why. */
  answeredElsewhere?: Record<string, string>;
}): string[] {
  const excused = args.answeredElsewhere ?? {};

  /**
   * Both kinds of registration, and template ones resolved.
   *
   * A route written as `` `/api/${path}` `` is real, and a check that could not
   * see it would report every screen calling it. `templateRoutes` resolves the
   * variable from the file it is in, so `${path}` becomes the seven resources
   * the CRM actually registers rather than a wildcard that matches half the
   * platform — which, left as a wildcard, hid one of the two bugs above.
   */
  const known = [
    ...registeredRoutes(args.routeFiles),
    ...templateRoutes(args.routeFiles),
  ].map((r) => ({
    method: r.slice(0, r.indexOf(" ")),
    shape: pathShape(r.slice(r.indexOf(" ") + 1)),
  }));

  const missing = new Set<string>();
  for (const asked of requestedPaths(args.screenFiles)) {
    const path = asked.shape.join("/");
    if (excused[path]) continue;

    /**
     * A path the screen holds in a variable carries every verb, because its
     * call sites are elsewhere. One matching route is all that can be asked
     * of it — demanding all five would fail on every such path.
     */
    const anyVerb = asked.methods.size === 5;
    const verbs = anyVerb ? ["ANY"] : [...asked.methods];

    for (const method of verbs) {
      const hit = known.some(
        (k) =>
          k.shape.length === asked.shape.length &&
          k.shape.every(
            (seg, i) =>
              seg === "*" || asked.shape[i] === "*" || seg === asked.shape[i],
          ) &&
          (anyVerb || k.method === method),
      );
      if (!hit) missing.add(anyVerb ? `(any) ${path}` : `${method} ${path}`);
    }
  }
  return [...missing].sort();
}
