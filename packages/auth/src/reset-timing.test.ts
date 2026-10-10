import { expect, test } from "bun:test";
import { auth } from "./index";

/**
 * "Forgot password" takes as long for a stranger as for somebody who works here.
 *
 * The answer is the same either way, but the reset mail was sent before it, so
 * an address with an account answered as slowly as the mail server and one
 * without answered at once. The library's own background runner is what sends
 * it; one that never finishes must not hold the answer up.
 */
test("a reset mail that never finishes does not hold the answer", async () => {
  const context = (await auth.$context) as {
    runInBackgroundOrAwait: (p: Promise<unknown>) => Promise<void>;
  };
  const never = new Promise<void>(() => {});
  const done = await Promise.race([
    context.runInBackgroundOrAwait(never).then(() => "answered"),
    new Promise((r) => setTimeout(() => r("waited"), 500)),
  ]);
  expect(done).toBe("answered");
});
