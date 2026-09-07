import { expect, test } from "bun:test";
import {
  SignJWT,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  importPKCS8,
  importSPKI,
} from "jose";
import {
  SENTRELLO_LICENSE_PUBLIC_KEY,
  makeEntitlementGate,
  verifyLicenseToken,
} from "./index";

/**
 * A keypair made here, for this run.
 *
 * These used to be read from `secrets/`, which holds the real signing key and
 * is absent from a fresh clone — so a stranger's first `bun test` failed on a
 * private key they could not have, and were never meant to. Generating one
 * proves the same properties, needs no setup, and removes any reason to put a
 * real signing key where a test can reach it.
 */
const ALG = "EdDSA";
const pair = await generateKeyPair(ALG, { extractable: true });
const priv = await exportPKCS8(pair.privateKey);
const pub = await exportSPKI(pair.publicKey);

async function mint(claims: Record<string, unknown>, exp = "72h") {
  const key = await importPKCS8(priv, ALG);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: ALG })
    .setIssuer("sentrello.com")
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(key);
}

test("valid pro token verifies + gates correctly", async () => {
  const token = await mint({ tier: "pro", modules: ["scheduling"], seats: 20 });
  const state = await verifyLicenseToken(token, pub);
  expect(state.valid).toBe(true);
  const gate = makeEntitlementGate(state);
  expect(gate({ tier: "pro" })).toBe(true);
  expect(gate({ module: "scheduling" })).toBe(true);
  expect(gate({ module: "documents" })).toBe(false);
});

test("expired token downgrades to Free, does not throw", async () => {
  const token = await mint({ tier: "pro", modules: [] }, "-1s");
  const state = await verifyLicenseToken(token, pub);
  expect(state.valid).toBe(false);
  expect(makeEntitlementGate(state)({ tier: "pro" })).toBe(false);
});

test("tampered token rejected", async () => {
  const token = `${(await mint({ tier: "pro", modules: [] })).slice(0, -3)}AAA`;
  expect((await verifyLicenseToken(token, pub)).valid).toBe(false);
});

test("wrong issuer rejected", async () => {
  const key = await importPKCS8(priv, ALG);
  const token = await new SignJWT({ tier: "pro", modules: [] })
    .setProtectedHeader({ alg: ALG })
    .setIssuer("evil.example")
    .setIssuedAt()
    .setExpirationTime("72h")
    .sign(key);
  expect((await verifyLicenseToken(token, pub)).valid).toBe(false);
});

test("missing/garbage token downgrades to Free, does not throw", async () => {
  const state = await verifyLicenseToken("not-a-jwt", pub);
  expect(state.valid).toBe(false);
  expect(state.claims).toBeNull();
  expect(makeEntitlementGate(state)({ tier: "pro" })).toBe(false);
  // Free needs are still satisfied with no license at all.
  expect(makeEntitlementGate(state)({})).toBe(true);
});

test("the embedded production key is a usable Ed25519 public key", async () => {
  const key = await importSPKI(SENTRELLO_LICENSE_PUBLIC_KEY, ALG);
  expect(key).toBeDefined();
  expect(SENTRELLO_LICENSE_PUBLIC_KEY).toContain("-----BEGIN PUBLIC KEY-----");
  // a public key only: shipping a private key in the open core would be fatal
  expect(SENTRELLO_LICENSE_PUBLIC_KEY).not.toContain("PRIVATE KEY");
});

test("verification defaults to the embedded key, so a stock instance needs no config", async () => {
  // A token from the dev keypair must NOT validate against the production key.
  const token = await mint({ tier: "pro", modules: [] });
  const state = await verifyLicenseToken(token);
  expect(state.valid).toBe(false);
  expect(makeEntitlementGate(state)({ tier: "pro" })).toBe(false);
});

test("a token signed by any trusted key verifies, which is what makes rotation possible", async () => {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const rotated = await generateKeyPair(ALG, { extractable: true });
  const newPub = await exportSPKI(rotated.publicKey);
  const newPriv = await exportPKCS8(rotated.privateKey);

  const signedWithNew = await new SignJWT({ tier: "pro", modules: [] })
    .setProtectedHeader({ alg: ALG })
    .setIssuer("sentrello.com")
    .setIssuedAt()
    .setExpirationTime("72h")
    .sign(await importPKCS8(newPriv, ALG));

  // during rotation an instance trusts both keys
  const during = await verifyLicenseToken(signedWithNew, [pub, newPub]);
  expect(during.valid).toBe(true);

  // a token from the old key still works while the old key is trusted
  const signedWithOld = await mint({ tier: "pro", modules: [] });
  expect((await verifyLicenseToken(signedWithOld, [pub, newPub])).valid).toBe(
    true,
  );

  // once the old key is dropped, its tokens stop verifying
  expect((await verifyLicenseToken(signedWithOld, [newPub])).valid).toBe(false);
});

test("an untrusted key is rejected however many keys are trusted", async () => {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const stranger = await generateKeyPair(ALG, { extractable: true });
  const forged = await new SignJWT({ tier: "pro", modules: [] })
    .setProtectedHeader({ alg: ALG })
    .setIssuer("sentrello.com")
    .setIssuedAt()
    .setExpirationTime("72h")
    .sign(await importPKCS8(await exportPKCS8(stranger.privateKey), ALG));

  const state = await verifyLicenseToken(forged, [
    pub,
    await exportSPKI(
      (await generateKeyPair(ALG, { extractable: true })).publicKey,
    ),
  ]);
  expect(state.valid).toBe(false);
  expect(makeEntitlementGate(state)({ tier: "pro" })).toBe(false);
});

/**
 * Optional modules are a marketplace for Pro subscribers, so a module
 * entitlement is worth nothing without Pro underneath it.
 *
 * Enforced here and not only at the licence server, because the token is a
 * file on the customer's disk: the instance is the thing that has to be right.
 */
test("a module entitlement without Pro grants nothing", () => {
  const gate = makeEntitlementGate({
    valid: true,
    claims: { tier: "free", modules: ["projects", "scheduling"] } as never,
  });

  expect(gate({ module: "projects" })).toBe(false);
  expect(gate({ module: "scheduling" })).toBe(false);
  // Free features are unaffected: nothing about this downgrades the core.
  expect(gate({})).toBe(true);
});

test("Pro plus the module is what loads it", () => {
  const gate = makeEntitlementGate({
    valid: true,
    claims: { tier: "pro", modules: ["projects"] } as never,
  });

  expect(gate({ module: "projects" })).toBe(true);
  // Bought Pro, did not buy this one.
  expect(gate({ module: "documents" })).toBe(false);
  expect(gate({ tier: "pro" })).toBe(true);
});

test("an invalid licence naming Pro and every module still grants nothing", () => {
  const gate = makeEntitlementGate({
    valid: false,
    claims: { tier: "pro", modules: ["projects"] } as never,
    reason: "expired",
  });

  expect(gate({ tier: "pro" })).toBe(false);
  expect(gate({ module: "projects" })).toBe(false);
});
