import {
  type LicenseState,
  SENTRELLO_LICENSE_PUBLIC_KEYS,
  makeEntitlementGate,
  verifyLicenseToken,
} from "@sentrello/licensing-client";

/**
 * `trustedKeys` exists for tests, which sign with a throwaway keypair and
 * need to tell `verifyLicenseToken` to trust it — there is no other way to
 * exercise a valid-token path without the real signing key, which must never
 * be in this repository. Production code never passes it: an instance trusts
 * exactly the keys embedded in the core.
 *
 * There used to be an environment variable for this
 * (`SENTRELLO_LICENSE_PUBLIC_KEY_PATH`) so a self-hoster's own key, or a
 * staging signer's, could be trusted without a rebuild. It was removed: the
 * same knob let anyone generate a keypair, point the variable at their public
 * half, and mint themselves a Pro token — no source change, no rebuild,
 * permanent. Key rotation is handled instead by `SENTRELLO_LICENSE_PUBLIC_KEYS`
 * in the core, which a release can extend to trust an old and a new key at
 * once (see the runbook).
 */
export async function resolveLicense(
  trustedKeys: string | string[] = SENTRELLO_LICENSE_PUBLIC_KEYS,
) {
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
    ? await verifyLicenseToken(token, trustedKeys)
    : { claims: null, valid: false, reason: "no token (Free)" };

  return { state, gate: makeEntitlementGate(state) };
}
// Packet 03 adds: a pg-boss daily job that fetches a fresh token from
// SENTRELLO_LICENSE_SERVER_URL and writes it to tokenPath (the online check).
