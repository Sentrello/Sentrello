import { expect, test } from "bun:test";
import { db } from "./client";

/**
 * One pool per process, however many times this module is evaluated.
 *
 * `bun --hot` re-runs the module on every save, and a top-level
 * `postgres(...)` built a new pool each time while the old one kept its
 * sockets. Two dev servers left running a morning held 300 of the database's
 * 300 connections between them and nothing else could open one — including
 * the test suite, which failed in a way that looked like the code under test.
 *
 * The database's ceiling had already been raised from 100 to 300 once to make
 * this go away, which is the shape of a symptom being treated.
 *
 * Re-evaluation is what a reload does, so that is what this does: import the
 * module a second time under a different specifier, which defeats the module
 * cache the way a reload does, and check the pool did not double.
 */
test("re-evaluating the client does not open a second pool", async () => {
  expect(db).toBeTruthy();

  const holder = globalThis as unknown as Record<symbol, unknown>;
  const first = holder[Symbol.for("sentrello.db.pool")];
  expect(first).toBeTruthy();

  const again = (await import(`./client.ts?reload=${Date.now()}`)) as {
    db: unknown;
  };
  expect(again.db).toBeTruthy();

  // The same pool object, not an equal one: a second `postgres(...)` would be
  // a different object holding its own sockets.
  expect(holder[Symbol.for("sentrello.db.pool")]).toBe(first);
});
