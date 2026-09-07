import { expect, test } from "bun:test";
import { auth } from "./index";

/**
 * Signed in until you sign out, or thirty minutes idle.
 *
 * Asserted on the configuration rather than by waiting half an hour. The two
 * values only mean "rolling window" together: a long `updateAge` leaves the
 * session unrefreshed during use, so it expires on a fixed schedule regardless
 * of whether anyone is working — and leaves `updated_at` stale, which is what
 * made the demo wipe itself out from under the people testing on it.
 */
test("a session rolls forward while it is being used", () => {
  const s = (
    auth.options as { session?: { expiresIn?: number; updateAge?: number } }
  ).session;
  expect(s?.expiresIn).toBe(30 * 60);

  // Must be well under expiresIn, or a session cannot be extended before it
  // lapses and the window stops rolling.
  expect(s?.updateAge).toBeGreaterThan(0);
  expect(s?.updateAge).toBeLessThan((s?.expiresIn ?? 0) / 2);
});
