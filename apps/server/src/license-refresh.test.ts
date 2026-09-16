import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshLicenseToken } from "@sentrello/jobs/license-refresh";
import { type SentrelloEnv, defineModule } from "@sentrello/module-sdk";
import { Hono } from "hono";
import {
  SignJWT,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  importPKCS8,
} from "jose";
import {
  currentLicenseState,
  gate,
  refreshLicenseState,
  resolveLicense,
} from "./license";
import { loadModules } from "./loader";

/**
 * The live half of licence verification.
 *
 * `license.test.ts` covers `resolveLicense` itself — signatures, expiry, the
 * public-key-path bypass — all at boot. These prove the other half: that a
 * refresh landing *after* boot reaches the exact `gate` every module already
 * closed over, rather than a snapshot nothing ever looks at again. Before
 * `refreshLicenseState` existed, none of this was possible to prove — a
 * lapsed licence had no way back into a running process at all.
 */

const ALG = "EdDSA";

let dir: string;
let privateKeyPem: string;
let publicKeyPem: string;
let tokenPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sentrello-licence-live-"));
  tokenPath = join(dir, "license_token.jwt");
  const { publicKey, privateKey } = await generateKeyPair(ALG, {
    extractable: true,
  });
  privateKeyPem = await exportPKCS8(privateKey);
  publicKeyPem = await exportSPKI(publicKey);
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = tokenPath;
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

/**
 * The way a Pro route actually gates itself: `entitled` is captured once, at
 * register time, but called fresh on every request. `tier: "free"` so the
 * module loads unconditionally — the route body is the gate here, exactly
 * like the 271 per-request checks this fix was written for.
 */
function proRoute() {
  return defineModule({
    id: "pro-thing",
    tier: "free",
    register(ctx) {
      ctx.app.get("/api/pro-thing", (c) =>
        ctx.entitled({ tier: "pro" }) ? c.json({ ok: true }) : c.notFound(),
      );
    },
  });
}

test("a licence that lapses mid-process 404s a paid route once a refresh has run — no restart", async () => {
  await writeToken({ tier: "pro", modules: [], license_id: "l1" }, "1h");
  await resolveLicense(publicKeyPem);
  expect(gate({ tier: "pro" })).toBe(true);

  const app = new Hono<SentrelloEnv>();
  loadModules(app, gate, [proRoute()]);

  const before = await app.request("http://localhost/api/pro-thing");
  expect(before.status).toBe(200);

  // The licence lapses: whatever is on disk now fails to verify.
  await writeToken({ tier: "pro", modules: [] }, "-1s");
  await refreshLicenseState(publicKeyPem);

  // Same app, same route, same registered handler — only the state behind
  // `gate` moved.
  const after = await app.request("http://localhost/api/pro-thing");
  expect(after.status).toBe(404);
});

test("a transient refresh failure leaves entitlement intact", async () => {
  await writeToken({ tier: "pro", modules: [] }, "1h");
  await resolveLicense(publicKeyPem);
  expect(gate({ tier: "pro" })).toBe(true);

  // A closed local port: refused immediately, nothing reaches the network,
  // and — critically — nothing touches the token file.
  const attempt = await refreshLicenseToken({
    serverUrl: "http://127.0.0.1:1",
    licenseKey: "lic_test",
    instanceId: "inst_test",
    tokenPath,
  });
  expect(attempt).toEqual({ refreshed: false, error: "unreachable" });

  // Re-verifying the same, still-good token must not read as a downgrade.
  await refreshLicenseState(publicKeyPem);
  expect(gate({ tier: "pro" })).toBe(true);
  expect(currentLicenseState().valid).toBe(true);
});

test("a token that has genuinely expired downgrades even though the server cannot be reached", async () => {
  await writeToken({ tier: "pro", modules: [] }, "1h");
  await resolveLicense(publicKeyPem);
  expect(gate({ tier: "pro" })).toBe(true);

  // Time has passed and the token on disk is now past its exp — the server
  // being unreachable is beside the point, offline verification catches
  // this on its own.
  await writeToken({ tier: "pro", modules: [] }, "-1s");
  const attempt = await refreshLicenseToken({
    serverUrl: "http://127.0.0.1:1",
    licenseKey: "lic_test",
    instanceId: "inst_test",
    tokenPath,
  });
  expect(attempt.refreshed).toBe(false);
  await refreshLicenseState(publicKeyPem);

  expect(gate({ tier: "pro" })).toBe(false);
  expect(currentLicenseState().valid).toBe(false);
});

test("/api/_meta's tier and `gate` never disagree, before or after a refresh", async () => {
  // Mirrors exactly what apps/server/src/index.ts's /api/_meta handler
  // computes from `currentLicenseState()`.
  const metaTier = () =>
    currentLicenseState().claims?.tier === "pro" ? "pro" : "free";

  await writeToken({ tier: "pro", modules: [] }, "1h");
  await resolveLicense(publicKeyPem);
  expect(metaTier() === "pro").toBe(gate({ tier: "pro" }));
  expect(gate({ tier: "pro" })).toBe(true);

  await writeToken({ tier: "pro", modules: [] }, "-1s");
  await refreshLicenseState(publicKeyPem);
  expect(metaTier() === "pro").toBe(gate({ tier: "pro" }));
  expect(gate({ tier: "pro" })).toBe(false);
});
