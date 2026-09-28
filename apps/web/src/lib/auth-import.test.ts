import { expect, test } from "bun:test";

/**
 * Importing the auth client cannot throw, whatever shape of window it finds.
 *
 * The client is built at module scope, so a base URL it cannot parse does not
 * fail a test — it fails the *import*, and bun reports that as an unhandled
 * error between tests. Every test in the file disappears, the run says three
 * failures and names none of them, and the file it blames is whichever one
 * happened to be next.
 *
 * That ran on every push for a fortnight while passing on macOS, in a clean
 * clone, and in a Linux container. The CI runner has a `window` whose
 * `location` carries no `origin`, so a check for `typeof window` alone still
 * handed the client `undefined`.
 *
 * The window is set before the import, deliberately: the module is cached
 * after the first one, so the awkward shape has to be in place first or the
 * test proves nothing.
 */
(globalThis as Record<string, unknown>).window = { location: {} };

test("a window whose location has no origin still imports", async () => {
  const mod = await import("./auth");
  expect(mod.authClient).toBeDefined();
});
