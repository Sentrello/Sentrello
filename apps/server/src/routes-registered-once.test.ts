import { expect, test } from "bun:test";

/**
 * No method and path is registered twice.
 *
 * Hono runs the first route a request fits and never reaches a second one
 * with the same method and path, so a copy registered later is code that
 * looks served and is not: an edit made to it changes nothing, and its
 * permission check is one nobody asks. Asked of the assembled app, so it sees
 * every module this instance loads and the host's own routes beside them.
 *
 * One registration is one unbroken run in `app.routes`: `app.get(path, a, b)`
 * lists `a` and `b` one after the other. A second run of the same method and
 * path is a second registration.
 *
 * ponytail: a copy registered immediately after the first merges into its run
 * and is not seen; wrap the app's `get`/`post`/… at construction if that ever
 * matters.
 */
test("no method and path is registered twice", async () => {
  const { app } = await import("./index");
  const runs = new Map<string, number>();
  let previous = "";
  for (const route of app.routes) {
    const key = `${route.method} ${route.path}`;
    // `ALL` is middleware mounted under a prefix, which is meant to repeat.
    if (key !== previous && route.method !== "ALL") {
      runs.set(key, (runs.get(key) ?? 0) + 1);
    }
    previous = key;
  }

  // Matching nothing would pass the assertion below it.
  expect(runs.size).toBeGreaterThan(200);
  expect(runs.has("GET /api/accounting/mtd")).toBe(true);
  expect([...runs].filter(([, count]) => count > 1)).toEqual([]);
});
