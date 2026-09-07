import { afterEach, expect, test } from "bun:test";
import { MissingSecretKey, hint, isSealed, open, seal } from "./secrets";

/**
 * Credentials a business pastes into a settings screen end up in the database,
 * and the database ends up in a backup somebody else can read.
 */

const saved = {
  key: process.env.SENTRELLO_SECRET_KEY,
  auth: process.env.BETTER_AUTH_SECRET,
};

afterEach(() => {
  process.env.SENTRELLO_SECRET_KEY = saved.key;
  process.env.BETTER_AUTH_SECRET = saved.auth;
});

test("a sealed value comes back, and does not look like itself on the way", () => {
  process.env.SENTRELLO_SECRET_KEY = "a-long-enough-instance-secret";
  const sealed = seal("sk_live_abcdef123456");

  expect(sealed).not.toContain("sk_live");
  expect(isSealed(sealed)).toBe(true);
  expect(open(sealed)).toBe("sk_live_abcdef123456");
});

test("the same secret sealed twice is two different strings", () => {
  process.env.SENTRELLO_SECRET_KEY = "a-long-enough-instance-secret";
  // A fresh nonce each time. Otherwise two shops with the same test key have
  // visibly identical rows, which tells anyone reading the table something.
  expect(seal("same")).not.toBe(seal("same"));
});

test("a tampered value refuses to open", () => {
  process.env.SENTRELLO_SECRET_KEY = "a-long-enough-instance-secret";
  const sealed = seal("sk_live_abcdef123456");
  const [v, nonce, tag, body] = sealed.split(".");

  // Flip the ciphertext. Without the authentication tag this would decrypt to
  // *something*, and we would send that something to a payment processor.
  const flipped = `${v}.${nonce}.${tag}.${(body ?? "").slice(0, -2)}AA`;
  expect(() => open(flipped)).toThrow();

  // And a value from another instance's key is not ours to read.
  process.env.SENTRELLO_SECRET_KEY = "a-different-instance-secret";
  expect(() => open(sealed)).toThrow();
});

test("nonsense in the column is refused rather than half-read", () => {
  process.env.SENTRELLO_SECRET_KEY = "a-long-enough-instance-secret";
  expect(() => open("sk_live_somebody_pasted_this_straight_in")).toThrow(
    /format we can read/,
  );
  expect(() => open("v1.only.two")).toThrow(/format we can read/);
});

test("an instance with no secret at all says so plainly", () => {
  process.env.SENTRELLO_SECRET_KEY = undefined;
  process.env.BETTER_AUTH_SECRET = undefined;
  // Better than a stack trace from inside a crypto call, which is what the
  // person configuring a payment processor would otherwise be shown.
  expect(() => seal("anything")).toThrow(MissingSecretKey);
});

test("auth's secret is the fallback, so older instances keep working", () => {
  process.env.SENTRELLO_SECRET_KEY = undefined;
  process.env.BETTER_AUTH_SECRET = "the-instance-auth-secret";
  const sealed = seal("pk_test_123");
  expect(open(sealed)).toBe("pk_test_123");

  // Setting the dedicated variable to the same string keeps the data
  // readable — the key is derived from whichever string is there, so somebody
  // separating the two later does not lose their payment connection.
  process.env.SENTRELLO_SECRET_KEY = "the-instance-auth-secret";
  expect(open(sealed)).toBe("pk_test_123");

  // A different one does not, which is the whole point of the derivation.
  process.env.SENTRELLO_SECRET_KEY = "a-newly-generated-instance-secret";
  expect(() => open(sealed)).toThrow();
});

test("a hint identifies a key without handing it over", () => {
  expect(hint("sk_live_abcdef4242")).toBe("…4242");
  expect(hint("abc")).toBe("…");
});
