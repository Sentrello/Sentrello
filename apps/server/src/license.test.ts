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
 */

const ALG = "EdDSA";

let dir: string;
let privateKeyPem: string;
let publicKeyPath: string;
let tokenPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sentrello-licence-"));
  publicKeyPath = join(dir, "license_public.pem");
  tokenPath = join(dir, "license_token.jwt");

  const { publicKey, privateKey } = await generateKeyPair(ALG, {
    extractable: true,
  });
  privateKeyPem = await exportPKCS8(privateKey);
  await writeFile(publicKeyPath, await exportSPKI(publicKey), "utf8");
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
  process.env.SENTRELLO_LICENSE_PUBLIC_KEY_PATH = publicKeyPath;
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = tokenPath;

  const { state, gate } = await resolveLicense();
  expect(state.valid).toBe(true);
  expect(state.claims?.tier).toBe("pro");
  expect(gate({ tier: "pro" })).toBe(true);
  expect(gate({ module: "scheduling" })).toBe(true);
  expect(gate({ module: "documents" })).toBe(false);
});

test("an expired token downgrades to Free without throwing", async () => {
  await writeToken({ tier: "pro", modules: ["scheduling"] }, "-1s");
  process.env.SENTRELLO_LICENSE_PUBLIC_KEY_PATH = publicKeyPath;
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = tokenPath;

  const { state, gate } = await resolveLicense();
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

  process.env.SENTRELLO_LICENSE_PUBLIC_KEY_PATH = publicKeyPath;
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = tokenPath;

  const { state, gate } = await resolveLicense();
  expect(state.valid).toBe(false);
  expect(gate({ tier: "pro" })).toBe(false);
});
