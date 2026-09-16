import type { LicenseState } from "@sentrello/licensing-client";
import { agentPresent, requestSync } from "@sentrello/module-settings/updates";
import { newlyMissingEntitledBundles } from "./optional-modules";

/**
 * What "Check for updates" does by hand, done for a customer who just bought
 * something — so a purchase does not sit invisible until somebody happens to
 * press a button.
 *
 * `before` and `after` are the live licence state either side of one refresh
 * (see `apps/server/src/license.ts`). Comparing them, rather than asking what
 * is missing right now, is what makes this fire exactly once per purchase:
 * `after` is exactly the state the *next* refresh reads back as `before`, so
 * a gap still there next hour — because the fetch failed, or because loading
 * a bundle is restart-bound and nobody has restarted yet — no longer looks
 * new and nothing is asked again. That instance is not left silent about it:
 * the same gap is reported at every boot by `missingEntitledBundles`, on
 * /healthz and the Licence screen, so the one-shot request here never
 * substitutes for that standing alarm.
 *
 * Never grants anything — it only fetches what `after` already says this
 * instance is entitled to; verification is unchanged. And it only asks: the
 * bundle still has to be registered at boot, so using it still needs the
 * restart the button's own path always required.
 */
export async function pursueGainedModules(
  before: LicenseState,
  after: LicenseState,
  present: string[],
): Promise<void> {
  const gained = newlyMissingEntitledBundles(before, after, present);
  if (gained.length === 0) return;

  if (!(await agentPresent())) {
    // No loop to back off from: this state transition has already happened
    // and will not "gain" the same module again, so without an agent the
    // request would simply never be made. The standing licence-screen alarm
    // is what carries this from here.
    console.warn(
      `[modules] the licence now includes ${gained.join(", ")}, and this instance has no update agent to fetch it. Run \`sentrello activate\` on the server.`,
    );
    return;
  }

  console.warn(
    `[modules] the licence now includes ${gained.join(", ")}; asking the host to fetch ${
      gained.length === 1 ? "it" : "them"
    }`,
  );
  await requestSync();
}
