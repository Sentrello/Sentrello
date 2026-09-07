import { licenseKey as storedLicenseKey } from "@sentrello/licensing-client";

export interface LicenseRefreshConfig {
  serverUrl?: string | undefined;
  licenseKey?: string | undefined;
  instanceId?: string | undefined;
  tokenPath?: string | undefined;
  /** Something was set, whether or not it turned out to be usable. */
  keyConfigured?: boolean | undefined;
}

/**
 * The key comes from `licenseKey()` rather than straight from the environment,
 * so a key entered in Settings by someone upgrading from Free is picked up by
 * the daily refresh exactly like one the installer wrote.
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
     * could not be reached. prodemo sat like that for four days: its key had
     * been written by hand with six groups instead of four, the daily refresh
     * did nothing every night, and the token expired.
     */
    keyConfigured: Boolean(process.env.SENTRELLO_LICENSE_KEY?.trim()),
  };
}

/**
 * The daily online check from Build Plan §4.2/§4.3. Fetches a fresh short-lived
 * token; if the server is unreachable or the subscription lapsed, the instance
 * keeps its last token until expiry and then downgrades to Free. The
 * `/api/license/token` endpoint itself is built in Packet 03.
 */
export async function refreshLicenseToken(config?: LicenseRefreshConfig) {
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
      // a hung license server must not hang the daily job forever
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // Keep the existing token until it expires — but carry back why, because
      // "refused" and "unreachable" need completely different actions from the
      // person standing at the terminal, and they used to be indistinguishable.
      const { error } = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      return { refreshed: false, error };
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
