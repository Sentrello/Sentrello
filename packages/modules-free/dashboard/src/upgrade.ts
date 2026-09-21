/**
 * What the Free dashboard says about Pro.
 *
 * One block at the top of the screen, and the only advertising the product
 * carries anywhere. It says the same thing on every instance, it ships in the
 * release, and it is the whole of what used to be the promo system.
 *
 * **That system is gone, deliberately.** A Free instance used to fetch a
 * document from sentrello.com every hour and show whatever it said, so the
 * copy could be changed without a release. Set by James, 21 September: an
 * instance that has bought nothing should not be calling home at all, and the
 * site says in as many words that it does not — "the free tier needs no
 * licence key, so there is nothing to check and no reason for it to reach
 * out". One sentence of advertising is not worth making that untrue, and it
 * is not worth the machinery either: a fetch, a cache file, a validator, an
 * expiry, an hourly job, a public route and a screen to edit it.
 *
 * The words change when the product does, in a release, like every other
 * string in the application.
 */

/** The block, in the copy that ships. */
export interface Upgrade {
  headline: string;
  body: string;
  cta: string;
  url: string;
}

/**
 * Where "see what Pro adds" goes, overridable for a partner's own site.
 *
 * An empty value counts as unset, because a compose file that declares the
 * variable and leaves it blank is the ordinary way to end up with one — and a
 * block whose only link goes nowhere is worse than no block.
 */
export function upgradeUrl(): string {
  const set = (process.env.SENTRELLO_UPGRADE_URL ?? "").trim();
  return set === "" ? "https://sentrello.com/pricing/" : set;
}

/**
 * Shown once setting up is finished, and never on Pro.
 *
 * Both of those gates live in `index.ts`, where the rest of the dashboard's
 * payload is decided; this is only the words.
 */
export function upgradeBlock(): Upgrade {
  return {
    headline: "Get paid faster with Sentrello Pro",
    body: "Payment chasing, recurring invoices, bank reconciliation and reports that balance.",
    cta: "See what Pro adds",
    url: upgradeUrl(),
  };
}
