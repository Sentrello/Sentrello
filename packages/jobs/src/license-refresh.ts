import { licenseKey as storedLicenseKey } from "@sentrello/licensing-client";

export interface LicenseRefreshConfig {
  serverUrl?: string | undefined;
  licenseKey?: string | undefined;
  instanceId?: string | undefined;
  tokenPath?: string | undefined;
  /** Something was set, whether or not it turned out to be usable. */
  keyConfigured?: boolean | undefined;
}

export interface LicenseRefreshResult {
  refreshed: boolean;
  error?: string | undefined;
  /**
   * Set only when the server just told us, in this response, that the
   * licence is not entitled any more — never inferred, never set for a
   * status this job does not recognise. See `refreshLicenseToken` below.
   */
  revoked?: true | undefined;
}

/**
 * The key comes from `licenseKey()` rather than straight from the environment,
 * so a key entered in Settings by someone upgrading from Free is picked up by
 * the refresh exactly like one the installer wrote.
 */
async function configFromEnv(): Promise<LicenseRefreshConfig> {
  return {
    serverUrl: process.env.SENTRELLO_LICENSE_SERVER_URL,
    licenseKey: (await storedLicenseKey()) ?? undefined,
    instanceId: process.env.SENTRELLO_INSTANCE_ID,
    tokenPath: process.env.SENTRELLO_LICENSE_TOKEN_PATH,
    /**
     * Whether a key was configured at all, as against configured and unusable.
     *
     * `licenseKey()` answers null for both, which is right for deciding
     * whether to run — and useless for saying why nothing happened. An
     * instance whose key is the wrong shape looks exactly like a Free one,
     * refreshes nothing, and is reported at the terminal as a server that
     * could not be reached. One of our own instances sat like that for four days: its key had
     * been written by hand with six groups instead of four, the daily refresh
     * did nothing every night, and the token expired.
     */
    keyConfigured: Boolean(process.env.SENTRELLO_LICENSE_KEY?.trim()),
  };
}

/**
 * The hourly online check that keeps a licensed instance's token fresh. Fetches
 * a fresh short-lived token; if the server is unreachable or answers with
 * anything short of an explicit revocation, the instance keeps its last
 * token until expiry and then downgrades to Free. The one exception is a
 * server that says outright, in this request's own response, that the
 * licence is no longer entitled (402 `not_entitled`) — that clears the token
 * on the spot, so the next `refreshLicenseState` (apps/server/src/license.ts)
 * degrades immediately instead of riding out the old token's remaining TTL.
 */
export async function refreshLicenseToken(
  config?: LicenseRefreshConfig,
): Promise<LicenseRefreshResult> {
  const { serverUrl, licenseKey, instanceId, tokenPath, keyConfigured } =
    config ?? (await configFromEnv());

  /**
   * A key was set and could not be used.
   *
   * Said apart from "there is no key", because they need opposite actions from
   * the person standing at the terminal — one buys a licence, the other fixes
   * the one they have — and they used to be the same silent answer.
   */
  if (!licenseKey && keyConfigured) {
    return { refreshed: false, error: "malformed_key" as const };
  }

  // Free instance: nothing to refresh
  if (!serverUrl || !licenseKey || !tokenPath) return { refreshed: false };

  try {
    const res = await fetch(`${serverUrl}/api/license/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        license_key: licenseKey,
        instance_id: instanceId,
      }),
      // a hung license server must not hang the refresh job forever
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // Keep the existing token until it expires — but carry back why, because
      // "refused" and "unreachable" need completely different actions from the
      // person standing at the terminal, and they used to be indistinguishable.
      const { error } = (await res.json().catch(() => ({}))) as {
        error?: string;
      };

      // The one status the licence server uses to say, in as many words,
      // "this licence is not entitled any more" (see
      // control-plane/src/license-server.ts, `issueToken`'s `not_entitled`
      // branch). Everything else short of this — instance_limit, a malformed
      // request, a 5xx, an error string we don't recognise — is "could not
      // tell you", not "told us no", and must leave the token exactly alone.
      // Getting this wrong in the permissive direction drops a paying
      // customer to Free because of a network hiccup; getting it wrong in the
      // strict direction only costs a little of the revocation speed this was
      // built for, so an unrecognised answer defaults to "no answer".
      const revoked = res.status === 402 && error === "not_entitled";
      if (revoked) await Bun.write(tokenPath, "");
      return { refreshed: false, error, ...(revoked ? { revoked } : {}) };
    }
    const { token } = (await res.json()) as { token?: string };
    if (!token) return { refreshed: false };
    await Bun.write(tokenPath, token);
    return { refreshed: true };
  } catch {
    // offline: keep last token; graceful-lockdown in licensing-client handles
    // expiry. Named, so "unreachable" is not also what a misconfiguration says.
    return { refreshed: false, error: "unreachable" as const };
  }
}
