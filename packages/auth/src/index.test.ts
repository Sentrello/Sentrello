import { expect, test } from "bun:test";
import { DEFAULT_IDLE_MINUTES } from "@sentrello/db/security-events";
import { auth } from "./index";

/**
 * The library's number is the ceiling; the idle window is somebody else's job.
 *
 * `expiresIn` was thirty minutes, and because the library refreshes a session
 * on use it *was* the idle window — for every instance, whatever the business
 * had set on its own Authentication screen. "Stay signed in for" saved in
 * days, appeared on the screen, and was read by nothing. Changed 2026-09-28.
 *
 * One number read once at startup cannot be a business's decision, and the
 * session cookie's lifetime comes from the same number — so a longer window
 * set here would hand out a cookie that outlived nothing. The business's own
 * figure is enforced per request in `requireSession` (`hono.ts`), which can
 * read it and can change without a restart.
 *
 * Asserted on the configuration rather than by waiting a month.
 */
test("the library's session ceiling is the longest the setting allows", () => {
  const s = (
    auth.options as { session?: { expiresIn?: number; updateAge?: number } }
  ).session;

  /*
   * Thirty days, which is the clamp on "Stay signed in for". It has to be at
   * least that or the product could not honour the largest number it offers;
   * it should not be much more, because it is the only bound on anything that
   * does not pass through our own middleware — the library's own endpoints
   * under `/api/auth`, which is where a password is changed.
   */
  expect(s?.expiresIn).toBe(30 * 24 * 60 * 60);

  /*
   * And the session still rolls forward while it is being used.
   *
   * `updateAge` is what keeps `updated_at` current, which is now doing real
   * work: the idle guard measures from it. A long `updateAge` would leave it
   * stale and sign people out mid-sentence — the same staleness that made the
   * demo wipe itself out from under the people testing on it.
   */
  expect(s?.updateAge).toBeGreaterThan(0);
  expect(s?.updateAge).toBeLessThan(DEFAULT_IDLE_MINUTES * 60);
});
