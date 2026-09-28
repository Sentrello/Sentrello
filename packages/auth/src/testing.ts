import { auth } from "./index";
import { duringBootstrap } from "./signup-policy";

/**
 * Creates an account the way a first-run owner is created, without going near
 * `SENTRELLO_ALLOW_SIGNUP`.
 *
 * Test files run concurrently, so mutating `process.env` in one leaks into the
 * others — a suite that flipped the flag to assert the guard would silently
 * disable it for everything running alongside it. This takes the sanctioned
 * bootstrap path instead, so the guard stays armed everywhere.
 */
export async function signUpAsOwner(body: {
  email: string;
  password: string;
  name: string;
}) {
  return duringBootstrap(() =>
    auth.api.signUpEmail({ body, returnHeaders: true }),
  );
}
