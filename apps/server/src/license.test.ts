import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SignJWT,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  importPKCS8,
} from "jose";
import { resolveLicense } from "./license";

/**
 * Licence verification, against a keypair this test makes for itself.
 *
 * It used to sign with `secrets/license_private.pem`, which is the real
 * signing key and must never be in a public repository — so the first thing a
 * stranger cloning this repo saw was three failing tests and an error naming a
 * private key they could not have. Generating a throwaway pair proves the same
 * thing, needs no setup, and cannot tempt anybody into putting a real key where
 * the tests can reach it.
 *
 * `resolveLicense` used to read `SENTRELLO_LICENSE_PUBLIC_KEY_PATH` from the
 * environment to find the key to trust, and these tests pointed it at the
 * throwaway public key above. That was also the whole bypass: anyone could set
 * the same variable on a stock instance and trust their own key. The tests
 * below now pass the throwaway key straight to `resolveLicense` as an
 * argument, which is a seam only test code can reach.
 */

const ALG = "EdDSA";

let dir: string;
let privateKeyPem: string;
let publicKeyPem: string;
let tokenPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sentrello-licence-"));
  tokenPath = join(dir, "license_token.jwt");

  const { publicKey, privateKey } = await generateKeyPair(ALG, {
    extractable: true,
  });
  privateKeyPem = await exportPKCS8(privateKey);
  publicKeyPem = await exportSPKI(publicKey);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeToken(
  claims: Record<string, unknown>,
  exp: string,
): Promise<void> {
  const key = await importPKCS8(privateKeyPem, ALG);
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: ALG })
    .setIssuer("sentrello.com")
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(key);
  await writeFile(tokenPath, token, "utf8");
}

test("a valid Pro token yields tier=pro and its module entitlements", async () => {
  await writeToken(
    { tier: "pro", modules: ["scheduling"], seats: 20, license_id: "dev" },
    "72h",
  );
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = tokenPath;

  const { state, gate } = await resolveLicense(publicKeyPem);
  expect(state.valid).toBe(true);
  expect(state.claims?.tier).toBe("pro");
  expect(gate({ tier: "pro" })).toBe(true);
  expect(gate({ module: "scheduling" })).toBe(true);
  expect(gate({ module: "documents" })).toBe(false);
});

test("an expired token downgrades to Free without throwing", async () => {
  await writeToken({ tier: "pro", modules: ["scheduling"] }, "-1s");
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = tokenPath;

  const { state, gate } = await resolveLicense(publicKeyPem);
  expect(state.valid).toBe(false);
  expect(gate({ tier: "pro" })).toBe(false);
  expect(gate({ module: "scheduling" })).toBe(false);
});

/**
 * A token signed by the wrong key is not a token.
 *
 * Worth stating outright now that the test makes its own keys: the check that
 * matters is the signature, not the shape of the claims, and a second keypair
 * is the only way to demonstrate it.
 */
test("a token signed by somebody else's key is refused", async () => {
  const stranger = await generateKeyPair(ALG, { extractable: true });
  const forged = await new SignJWT({ tier: "pro", modules: ["scheduling"] })
    .setProtectedHeader({ alg: ALG })
    .setIssuer("sentrello.com")
    .setIssuedAt()
    .setExpirationTime("72h")
    .sign(stranger.privateKey);
  await writeFile(tokenPath, forged, "utf8");

  process.env.SENTRELLO_LICENSE_TOKEN_PATH = tokenPath;

  const { state, gate, tokenPresent } = await resolveLicense(publicKeyPem);
  expect(state.valid).toBe(false);
  expect(gate({ tier: "pro" })).toBe(false);
  // A token that is present and failing is the case that earns a warning on
  // the licence screen — unlike plain Free, which has no token at all.
  expect(tokenPresent).toBe(true);
});

/**
 * The bypass this file exists to close: `resolveLicense` used to read
 * `SENTRELLO_LICENSE_PUBLIC_KEY_PATH` from the environment and verify against
 * whatever key that path named. On a stock instance that meant anyone could
 * generate their own keypair, mint a "pro" token with the private half, point
 * this variable at the public half, and get Pro for good — no source change,
 * no rebuild. The variable must now do nothing: only the keys compiled into
 * the core (or, in a test, passed as an explicit argument) are ever trusted.
 */
test("SENTRELLO_LICENSE_PUBLIC_KEY_PATH grants nothing — the environment cannot name a trusted key", async () => {
  const attacker = await generateKeyPair(ALG, { extractable: true });
  const selfSigned = await new SignJWT({
    tier: "pro",
    modules: ["scheduling"],
    seats: 999,
    license_id: "forged",
  })
    .setProtectedHeader({ alg: ALG })
    .setIssuer("sentrello.com")
    .setIssuedAt()
    .setExpirationTime("72h")
    .sign(attacker.privateKey);
  await writeFile(tokenPath, selfSigned, "utf8");

  const attackerKeyPath = join(dir, "attacker_public.pem");
  await writeFile(
    attackerKeyPath,
    await exportSPKI(attacker.publicKey),
    "utf8",
  );

  process.env.SENTRELLO_LICENSE_TOKEN_PATH = tokenPath;
  process.env.SENTRELLO_LICENSE_PUBLIC_KEY_PATH = attackerKeyPath;

  try {
    // No key argument: this is the call production code makes, trusting only
    // the keys embedded in the core — which the attacker's key is not one of.
    const { state, gate } = await resolveLicense();
    expect(state.valid).toBe(false);
    expect(gate({ tier: "pro" })).toBe(false);
  } finally {
    process.env.SENTRELLO_LICENSE_PUBLIC_KEY_PATH = undefined;
  }
});
