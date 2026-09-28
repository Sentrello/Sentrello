import { expect, test } from "bun:test";
import { verifyLicenseToken } from "./index";
import { SENTRELLO_LICENSE_PUBLIC_KEY as REAL } from "./public-key";

/**
 * The licence never stops an instance starting.
 *
 * Verification fails safe to Free and never crashes the app. "Never" is
 * load-bearing in a way the platform's other invariants are not:
 * `resolveLicense()` is awaited at the top level of
 * `apps/server/src/index.ts` and its call to `verifyLicenseToken` is not
 * wrapped, so anything thrown out of here is not a downgrade — it is an
 * instance that does not boot, on every machine holding that file.
 *
 * The suite already covered expired, tampered and one "garbage" token. These
 * two go wider, because the realistic failure is not an attacker: it is a
 * half-written file after a disk filled up or a container was killed
 * mid-copy, and neither of those produces tidy garbage.
 */

/** A well-formed token shape, so the key is what is under test below. */
const TOKEN = `${btoa('{"alg":"EdDSA"}')}.${btoa('{"tier":"pro"}')}.c2ln`;
const NL = String.fromCharCode(10);

const MALFORMED_TOKENS: [string, string][] = [
  ["empty", ""],
  ["whitespace", "   "],
  ["truncated jwt", "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0"],
  ["one dot", "a.b"],
  ["four parts", "a.b.c.d"],
  ["not base64", "!!!.@@@.###"],
  // A token far larger than any real one, in case anything tries to parse it
  // eagerly before deciding it is nonsense.
  ["200KB", `${"a".repeat(200_000)}.b.c`],
  ["spaces inside", "a b.c d.e"],
  ["json, not a jwt", '{"alg":"none"}'],
  // The classic forgery: no signature, and a payload claiming everything.
  ["alg none", `${btoa('{"alg":"none"}')}.${btoa('{"tier":"pro"}')}.`],
  ["negative exp", `${btoa('{"alg":"EdDSA"}')}.${btoa('{"exp":-1}')}.x`],
];

const BROKEN_KEYS: [string, string][] = [
  ["empty", ""],
  ["truncated PEM", REAL.slice(0, 40)],
  ["header only", "-----BEGIN PUBLIC KEY-----"],
  [
    "no base64 body",
    [
      "-----BEGIN PUBLIC KEY-----",
      "not base64!",
      "-----END PUBLIC KEY-----",
    ].join(NL),
  ],
  [
    "half a key",
    `${
      REAL.slice(0, Math.floor(REAL.length / 2)) + NL
    }-----END PUBLIC KEY-----`,
  ],
  ["a log line", "2026-09-04 ERROR something went wrong"],
  ["blank file", NL + NL + NL],
];

test("no malformed token throws out of verification, or verifies", async () => {
  const bad: string[] = [];
  for (const [name, token] of MALFORMED_TOKENS) {
    try {
      const state = await verifyLicenseToken(token);
      if (state.valid) bad.push(`${name}: reported VALID`);
    } catch (err) {
      bad.push(`${name}: threw ${(err as Error).message.slice(0, 60)}`);
    }
  }
  expect(bad).toEqual([]);
});

test("a corrupted public key file cannot stop an instance booting", async () => {
  // `publicKey()` in apps/server falls back to the embedded key when the file
  // cannot be *read*. It cannot tell that a file which reads fine holds half a
  // PEM, so the garbage arrives here — and this is the only thing between that
  // and a boot loop.
  const bad: string[] = [];
  for (const [name, key] of BROKEN_KEYS) {
    try {
      const state = await verifyLicenseToken(TOKEN, key);
      if (state.valid) bad.push(`${name}: reported VALID`);
    } catch (err) {
      bad.push(`${name}: threw ${(err as Error).message.slice(0, 60)}`);
    }
  }
  expect(bad).toEqual([]);
});
