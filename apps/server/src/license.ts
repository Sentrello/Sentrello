import {
  type LicenseState,
  SENTRELLO_LICENSE_PUBLIC_KEYS,
  makeEntitlementGate,
  verifyLicenseToken,
} from "@sentrello/licensing-client";
import type { EntitlementNeed } from "@sentrello/module-sdk";

/**
 * The live licence state, held here rather than returned as a plain value.
 *
 * `gate` is a closure every module captures once, at boot, and calls on every
 * request from then on — that is what makes 271 per-request checks possible
 * with one predicate. If that predicate closed over a snapshot, a licence
 * that lapsed mid-process would keep granting everything until somebody
 * restarted the container, which nothing does on a schedule. So the snapshot
 * lives in one mutable place instead, `gate` reads it fresh on every call,
 * and the hourly refresh job (see `packages/jobs/src/license-refresh.ts`)
 * updates it after it writes a new token to disk.
 */
let live: { state: LicenseState; tokenPresent: boolean } = {
  state: { claims: null, valid: false, reason: "not yet resolved" },
  tokenPresent: false,
};

async function readTokenFromDisk(): Promise<string> {
  const tokenPath = process.env.SENTRELLO_LICENSE_TOKEN_PATH;
  if (!tokenPath) return "";
  try {
    const f = Bun.file(tokenPath);
    if (await f.exists()) return (await f.text()).trim();
  } catch (err) {
    // an unreadable token is the same as no token: run as Free
    console.warn(
      `[license] cannot read ${tokenPath} (${(err as Error).message})`,
    );
  }
  return "";
}

/**
 * Re-reads the token off disk and re-verifies it, replacing the live state.
 *
 * Called at boot (via `resolveLicense`) and again after every hourly refresh
 * attempt — whether or not that attempt reached the licence server. That
 * single rule is what gives both halves of the fail-safe behaviour for free,
 * and holds at any cadence, this one included: `verifyLicenseToken` checks
 * `exp` offline, so a token that has genuinely run out stops verifying the
 * moment this runs again, server or no server; and when the server could not
 * be reached, the refresh job never touched the file, so re-verifying the
 * same still-good token yields the same still-good state. Nothing here
 * downgrades an instance because our server had a bad night — only because
 * the token on disk no longer verifies. Moving from a daily to an hourly
 * refresh raises how often that proof runs, never what it proves.
 *
 * The one case that jumps the queue: `refreshLicenseToken`
 * (packages/jobs/src/license-refresh.ts) clears the token file outright when
 * the licence server has just told us, explicitly, that this licence is no
 * longer entitled — rather than leaving the old (still-verifying) token in
 * place until its own 72h runs out. That still goes through this same
 * function and the same rule: state changes here only because what is on
 * disk stopped verifying, it is just that "stopped verifying" now sometimes
 * happens on purpose, a request early, instead of by the clock.
 */
export async function refreshLicenseState(
  trustedKeys: string | string[] = SENTRELLO_LICENSE_PUBLIC_KEYS,
): Promise<void> {
  const token = await readTokenFromDisk();
  const state: LicenseState = token
    ? await verifyLicenseToken(token, trustedKeys)
    : { claims: null, valid: false, reason: "no token (Free)" };
  live = { state, tokenPresent: !!token };
}

/** What the instance is entitled to right now, not at boot. */
export function currentLicenseState(): LicenseState {
  return live.state;
}

/** Whether a token is present right now, not at boot. */
export function currentTokenPresent(): boolean {
  return live.tokenPresent;
}

/**
 * The gate every module and route calls. A stable function identity — it is
 * this exact reference every module closes over at load time — whose answer
 * is computed fresh from `live.state` on each call, so a state update after
 * boot reaches every one of those closures without anybody needing to be
 * handed a new function.
 */
export function gate(need: EntitlementNeed): boolean {
  return makeEntitlementGate(live.state)(need);
}

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
  await refreshLicenseState(trustedKeys);

  // Whether a token was found at all: the licence screen tells "running Free,
  // as installed" apart from "a licence is here and failing", which are a
  // shrug and an alarm respectively.
  return { state: live.state, gate, tokenPresent: live.tokenPresent };
}
// A pg-boss hourly job fetches a fresh token from SENTRELLO_LICENSE_SERVER_URL,
// writes it to tokenPath, and calls `refreshLicenseState` (the online check).
// The same job also asks the host to fetch and install a newly-entitled
// bundle it finds missing — see `apps/server/src/module-acquisition.ts`.
