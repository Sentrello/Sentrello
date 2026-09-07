import {
  type LicenseState,
  SENTRELLO_LICENSE_PUBLIC_KEY,
  makeEntitlementGate,
  verifyLicenseToken,
} from "@sentrello/licensing-client";

/**
 * Reads the verification key. The key is embedded in the core, so this is only
 * an override hook — for a staging control plane signing with a different key,
 * or a self-hoster running their own. An unreadable override falls back to the
 * embedded key rather than refusing to boot: failing to start is worse than
 * running as Free, and the token simply will not verify if the key is wrong.
 */
async function publicKey(): Promise<string> {
  const path = process.env.SENTRELLO_LICENSE_PUBLIC_KEY_PATH;
  if (!path) return SENTRELLO_LICENSE_PUBLIC_KEY;
  try {
    const file = Bun.file(path);
    if (await file.exists()) return await file.text();
    console.warn(`[license] ${path} not found, using the embedded key`);
  } catch (err) {
    console.warn(
      `[license] cannot read ${path} (${(err as Error).message}), using the embedded key`,
    );
  }
  return SENTRELLO_LICENSE_PUBLIC_KEY;
}

export async function resolveLicense() {
  const publicKeyPem = await publicKey();
  const tokenPath = process.env.SENTRELLO_LICENSE_TOKEN_PATH;

  let token = "";
  if (tokenPath) {
    try {
      const f = Bun.file(tokenPath);
      if (await f.exists()) token = (await f.text()).trim();
    } catch (err) {
      // an unreadable token is the same as no token: run as Free
      console.warn(
        `[license] cannot read ${tokenPath} (${(err as Error).message})`,
      );
    }
  }

  const state: LicenseState = token
    ? await verifyLicenseToken(token, publicKeyPem)
    : { claims: null, valid: false, reason: "no token (Free)" };

  return { state, gate: makeEntitlementGate(state) };
}
// Packet 03 adds: a pg-boss daily job that fetches a fresh token from
// SENTRELLO_LICENSE_SERVER_URL and writes it to tokenPath (the online check).
