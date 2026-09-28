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
import { pursueGainedModules } from "./module-acquisition";

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

/**
 * The whole point of this change: a licence server that says outright, in
 * this response, that the licence is not entitled any more must not wait for
 * the old (still perfectly verifying) token to run out its 72h. A full hour
 * is deliberately left on the token below, so the only thing that could make
 * this degrade is the explicit answer itself.
 */
test("an explicit revocation degrades entitlement immediately, without waiting for the token's own expiry", async () => {
  await writeToken({ tier: "pro", modules: [], license_id: "l1" }, "1h");
  await resolveLicense(publicKeyPem);
  expect(gate({ tier: "pro" })).toBe(true);

  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({ error: "not_entitled", tier: "free" }, { status: 402 }),
  });
  try {
    const result = await refreshLicenseToken({
      serverUrl: `http://127.0.0.1:${server.port}`,
      licenseKey: "lic_cancelled",
      instanceId: "inst_test",
      tokenPath,
    });
    expect(result.revoked).toBe(true);

    await refreshLicenseState(publicKeyPem);
    expect(gate({ tier: "pro" })).toBe(false);
    expect(currentLicenseState().valid).toBe(false);
  } finally {
    server.stop(true);
  }
});

/** Paid routes must not lag the state change above. */
test("a paid route 404s promptly after a revocation", async () => {
  await writeToken({ tier: "pro", modules: [], license_id: "l1" }, "1h");
  await resolveLicense(publicKeyPem);

  const app = new Hono<SentrelloEnv>();
  loadModules(app, gate, [proRoute()]);
  expect((await app.request("http://localhost/api/pro-thing")).status).toBe(
    200,
  );

  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({ error: "not_entitled", tier: "free" }, { status: 402 }),
  });
  try {
    await refreshLicenseToken({
      serverUrl: `http://127.0.0.1:${server.port}`,
      licenseKey: "lic_cancelled",
      instanceId: "inst_test",
      tokenPath,
    });
    await refreshLicenseState(publicKeyPem);
    expect((await app.request("http://localhost/api/pro-thing")).status).toBe(
      404,
    );
  } finally {
    server.stop(true);
  }
});

test("a 5xx from the license server leaves entitlement untouched", async () => {
  await writeToken({ tier: "pro", modules: [], license_id: "l1" }, "1h");
  await resolveLicense(publicKeyPem);
  expect(gate({ tier: "pro" })).toBe(true);

  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("internal error", { status: 500 }),
  });
  try {
    const result = await refreshLicenseToken({
      serverUrl: `http://127.0.0.1:${server.port}`,
      licenseKey: "lic_test",
      instanceId: "inst_test",
      tokenPath,
    });
    expect(result.revoked).toBeUndefined();

    await refreshLicenseState(publicKeyPem);
    expect(gate({ tier: "pro" })).toBe(true);
  } finally {
    server.stop(true);
  }
});

/**
 * `instance_limit` means this particular install was refused a token, not
 * that the licence itself is invalid — the licence may be in perfect
 * standing. Treated the same as any other answer this code cannot be certain
 * about: no change.
 */
test("an ambiguous refusal — not an explicit revocation — leaves entitlement untouched", async () => {
  await writeToken({ tier: "pro", modules: [], license_id: "l1" }, "1h");
  await resolveLicense(publicKeyPem);
  expect(gate({ tier: "pro" })).toBe(true);

  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json(
        { error: "instance_limit", reason: "too many installs" },
        { status: 409 },
      ),
  });
  try {
    const result = await refreshLicenseToken({
      serverUrl: `http://127.0.0.1:${server.port}`,
      licenseKey: "lic_test",
      instanceId: "inst_test",
      tokenPath,
    });
    expect(result.revoked).toBeUndefined();

    await refreshLicenseState(publicKeyPem);
    expect(gate({ tier: "pro" })).toBe(true);
  } finally {
    server.stop(true);
  }
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

/**
 * The wiring in `apps/server/src/index.ts`'s `onLicenseRefresh`, end to end:
 * a real token re-verified by the real `refreshLicenseState`, with
 * `pursueGainedModules` fed the exact `before`/`after` pair that callback
 * builds. This is what a newly bought module arriving on its own actually
 * depends on, not just the pure diff `optional-modules.test.ts` covers.
 */
test("a live refresh that gains an entitled, absent module asks the host to fetch it — exactly once", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sentrello-acquisition-live-"));
  const savedDataDir = process.env.SENTRELLO_DATA_DIR;
  process.env.SENTRELLO_DATA_DIR = dataDir;
  await writeFile(join(dataDir, "update-agent"), "1\n", "utf8");
  const syncRequested = () =>
    Bun.file(join(dataDir, "sync-requested")).exists();

  try {
    // Boot: Pro, but without the module this instance is about to buy.
    await writeToken({ tier: "pro", modules: [], license_id: "l1" }, "1h");
    await resolveLicense(publicKeyPem);

    // First refresh after the purchase: the token now names the module, and
    // it is not among what this instance has on disk ("dashboard" only).
    let before = currentLicenseState();
    await writeToken(
      { tier: "pro", modules: ["scheduling"], license_id: "l1" },
      "1h",
    );
    await refreshLicenseState(publicKeyPem);
    await pursueGainedModules(before, currentLicenseState(), ["dashboard"]);
    expect(await syncRequested()).toBe(true);

    // The host agent would consume the request; simulate that.
    await rm(join(dataDir, "sync-requested"));

    // Next refresh: same token, nothing changed. Still not on disk (loading
    // one is restart-bound), but this must not ask again.
    before = currentLicenseState();
    await refreshLicenseState(publicKeyPem);
    await pursueGainedModules(before, currentLicenseState(), ["dashboard"]);
    expect(await syncRequested()).toBe(false);
  } finally {
    process.env.SENTRELLO_DATA_DIR = savedDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
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
