import { expect, test } from "bun:test";
import { auth } from "./index";

/**
 * Signing in with Google is not a way round closed sign-up.
 *
 * `signUpGuard` reads `/sign-up/email` and nothing else, and the library makes
 * an account at the end of a Google sign-in through its own callback — so on
 * an instance with Google switched on, anybody with a Google account could
 * press the button and come away with an account and a session on a business
 * that had never invited them. Found 10 October 2026.
 *
 * Asked of the hook directly: a real Google sign-in needs Google.
 */

const create = auth.options.databaseHooks?.user?.create?.before;
const stranger = { email: `stranger-${crypto.randomUUID()}@example.test` };

test("a Google sign-in from somebody nobody invited makes no account", async () => {
  expect(create).toBeDefined();
  for (const path of ["/callback/:id", "/sign-in/social"]) {
    const attempt = create?.(stranger as never, { path } as never);
    await expect(attempt).rejects.toThrow("not accepting new accounts");
  }
});

test("an identity provider a business connected still provisions its people", async () => {
  const sso = await create?.(
    stranger as never,
    { path: "/sso/callback/:providerId" } as never,
  );
  expect(sso).not.toBe(false);
});
