import { expect, test } from "bun:test";
import { stillDeciding } from "./App";

/**
 * The shell waits for the first answer and must never wait again.
 *
 * `isLoading` cannot express that. A query holding no data goes back to
 * `pending` the moment anything refetches it, clearing the error it had
 * already reported — so a second observer mounting is enough to turn
 * `isLoading` true again. The Profile screen reads the same `["profile"]`
 * query the shell waits on, and that was the whole loop: shell gives up,
 * draws itself, mounts Profile, Profile's observer refetches, the query
 * returns to pending, the shell goes back to `Loading…` and unmounts
 * Profile. Twice a second, for ever, on a bare page with no way out.
 */
test("nothing has come back yet, so wait", () => {
  expect(stillDeciding({ isLoading: true, isFetched: false })).toBe(true);
});

test("an answer arrived, so never wait again", () => {
  expect(stillDeciding({ isLoading: false, isFetched: true })).toBe(false);
});

/**
 * The case the bug lived in: it failed, something asked again, and the query
 * is back to pending. The shell has already been told; it must carry on and
 * let the screen report it.
 */
test("it failed once and is being asked again — carry on", () => {
  expect(stillDeciding({ isLoading: true, isFetched: true })).toBe(false);
});
