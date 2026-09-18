import type { SentrelloModule } from "@sentrello/module-sdk";

/**
 * Commercial bundles this host will use *if they are present on disk*.
 *
 * They are deliberately NOT dependencies of this package: Core is public and
 * AGPL, and must never declare or vendor commercial code. In development they
 * appear via `bun link` from the sibling Pro/Modules repos; in distribution the
 * installer only unpacks the bundles a license entitles.
 *
 * Presence alone grants nothing — the loader still checks `entitled(...)`, so a
 * leaked bundle without a valid license token stays dark.
 */
export const OPTIONAL_MODULE_PACKAGES = [
  "@sentrello/pro-core",
  // Ships with Pro, and a package of its own: a business's plan
  // should not come and go with its bookkeeping features.
  "@sentrello/pro-projects",
  // The paid half of Bookkeeping, moving here from the public repo's own
  // `pro.ts` group by group. Empty for now — no routes, no nav, no jobs — so
  // its arrival on this list changes nothing on a running instance yet.
  "@sentrello/pro-accounting",
  "@sentrello/mod-scheduling",
  "@sentrello/mod-shop",
  // The POS. Bought separately and entitled in its own right; it needs Shop
  // underneath it, which the module declares rather than this list. Still a
  // bundle of its own — a shop with no counter should not carry it.
  "@sentrello/mod-pos",
  // sentrello.com only, and additionally gated by SENTRELLO_CONTROL_PLANE=true
  "@sentrello/control-plane",
  /**
   * Sentrello SEO Cloud, gated again by SENTRELLO_SEO_CLOUD=true.
   *
   * Named here so the same image can run it, and built to leave: when the
   * volume justifies its own machine, this name comes out of the list and the
   * service is deployed on its own with nothing else changing.
   */
  "@sentrello/seo-cloud",
  // bmp.sentrello.com only: Sentrello's own console, gated again by
  // SENTRELLO_MASTER=true. It is never built into any customer bundle, so on
  // every other host this name simply does not resolve.
  "@sentrello/master",
  "@sentrello/mod-documents",
  "@sentrello/mod-newsletter",
  "@sentrello/mod-docs",
  "@sentrello/mod-seo",
  "@sentrello/mod-subscriptions",
  // Sold on its own since 2026-09-12; it rode with Pro before that. A public
  // redirect service with a database behind it, sharing nothing with pro-core.
  "@sentrello/mod-links",
];

/**
 * Whether a failed import means "this instance did not buy it".
 *
 * Absent is the overwhelmingly common case and says nothing worth logging. A
 * bundle that is present and throws is the opposite: a customer losing every
 * feature they paid for. The two used to look identical here, and Pro was
 * silently missing from our own instance for it — it could not resolve
 * `@sentrello/email`, and the healthz that exists to report exactly that said
 * nothing at all.
 *
 * They are told apart by which module could not be found: this one, or
 * something this one needed.
 */
export function isNotInstalled(name: string, message: string): boolean {
  return (
    message.includes(`Cannot find module '${name}'`) ||
    message.includes(`Cannot find package '${name}'`)
  );
}

/**
 * Bundles the licence pays for that are simply not here.
 *
 * The licence says what to expect, in two claims that must stay apart:
 * `with_tier` is what comes with the tier, `modules` is what was bought.
 * There used to be a hardcoded list here of what a Pro licence includes,
 * because an absent bundle cannot name itself — and being a list somebody
 * had to remember, it went wrong: `pro-projects` is sold separately, was on
 * the list anyway, and every Pro instance that had not bought it wore a
 * permanent banner about a module that was never theirs. Now the token
 * carries the answer and the core reads instead of remembering.
 *
 * A token from before the claim existed carries no `with_tier`, and expects
 * only what it names outright. That errs quiet — an absent tier bundle goes
 * unreported for the hour it takes the next refresh to fetch a token that
 * says more — which is the right direction: a false alarm on every screen is
 * worse than a short silence.
 *
 * `present` is every module discovery found, loaded or not: one that arrived
 * and then failed — an unmet dependency, a declined host — is already
 * reported (or deliberately silent) on its own terms, and reporting it twice
 * would say two things are wrong when one is.
 *
 * An invalid or expired licence expects nothing: the instance is Free then,
 * the settings screen already says why the features went, and a
 * missing-bundle alarm on top would misdiagnose it.
 */
// Known limit: a module a licence grants via another's `includedWith` is not
// checked — that fact lives in the absent bundle, which cannot speak. Name it
// here if one ever ships without also appearing in the licence's module list.
export function missingEntitledBundles(
  state: {
    valid: boolean;
    claims: { tier?: string; modules?: string[]; with_tier?: string[] } | null;
  },
  present: string[],
): { name: string; reason: string }[] {
  const claims = state.valid ? state.claims : null;
  if (!claims) return [];

  // Shape-checked rather than trusted: a token from a newer control plane
  // than this core may carry a shape it never imagined, and a surprise here
  // must degrade to expecting less, never to an alarm or a crash. `modules`
  // was spread straight in — a string there would have alarmed about bundles
  // named "s" and "h", and a number throws at module scope during boot, which
  // is not a licence failing safe to Free but an instance that does not start.
  const named = (value: unknown) =>
    Array.isArray(value) ? value.filter((id) => typeof id === "string") : [];

  /*
   * What comes with the tier is claimed only by a tier that has one; what was
   * bought is claimed whatever the tier says.
   *
   * That second half is the part this got wrong. Modules are sold on their
   * own — the redirect module has been since 2026-09-12 — so a business on
   * Free can be entitled to one, and the loader agrees: a `module` tier asks
   * only whether the licence names it. This asked the tier first and answered
   * nothing at all unless it read `pro`, so a Free customer whose paid module
   * never reached the image got silence from /healthz, silence on the settings
   * screen and silence in the banner.
   */
  const withTier = claims.tier === "pro" ? named(claims.with_tier) : [];
  const here = new Set(present);
  const entitled = new Set([...withTier, ...named(claims.modules)]);
  return [...entitled]
    .filter((id) => !here.has(id))
    .map((name) => ({
      name,
      reason:
        "the licence includes it, and it is not installed on this instance. Run `sentrello update`.",
    }));
}

/**
 * What a licence-state transition alone gained, still absent from disk.
 *
 * `missingEntitledBundles` answers "what is missing right now" from one
 * state; this answers "what became missing between two of them" — the
 * difference is what makes automatic acquisition (see
 * `apps/server/src/module-acquisition.ts`) fire on a genuine new purchase and
 * stay quiet on every refresh after, including ones where the gap is still
 * there because the fetch failed or a restart has not happened yet. A name
 * already missing in `before` is not new and does not count again; a name
 * that dropped out of `after`'s entitlements is a loss, not a gain, and
 * `missingEntitledBundles` would not report it either way.
 */
export function newlyMissingEntitledBundles(
  before: {
    valid: boolean;
    claims: { tier?: string; modules?: string[]; with_tier?: string[] } | null;
  },
  after: {
    valid: boolean;
    claims: { tier?: string; modules?: string[]; with_tier?: string[] } | null;
  },
  present: string[],
): string[] {
  const was = new Set(
    missingEntitledBundles(before, present).map((f) => f.name),
  );
  return missingEntitledBundles(after, present)
    .map((f) => f.name)
    .filter((name) => !was.has(name));
}

function isModule(value: unknown): value is SentrelloModule {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SentrelloModule).id === "string" &&
    typeof (value as SentrelloModule).register === "function"
  );
}

/**
 * Bundles unpacked by the installer, discovered by path.
 *
 * Resolution by package name would mean writing links into the image's
 * node_modules, which the container cannot do when it runs as the customer's
 * own uid. The bundles directory is theirs and always writable, so the host
 * reads from there instead.
 */
/**
 * Bundles that were installed but would not load.
 *
 * A bundle that throws on import takes every one of its features with it —
 * a customer paying for Pro loses deals, reports, bank import and recurring
 * invoices at once. That used to be a warning in a log nobody reads, which is
 * how a broken import survived several releases. It is now reported by
 * /healthz and on the settings screen.
 */
export const failedBundles: { name: string; reason: string }[] = [];

/**
 * The core a bundle says it needs, against the core that is running.
 *
 * A bundle is source, linked in at startup and run by the host's own Bun
 * against the host's own packages. So a bundle built against a core that has
 * something the running one does not simply throws on import, and the reason
 * lands in a log: `Export named 'date' not found`. That happened — a paid
 * module went dark on a customer's instance for a release that was one version
 * behind, and the only visible symptom was a feature that was not there.
 *
 * `sentrelloCore` in a bundle's package.json is the bundle saying so in
 * advance. Comparing it here turns a cryptic import error into a sentence
 * naming both versions, on /healthz and on the settings screen, where the
 * answer is `sentrello update`.
 *
 * Deliberately a minimum and not a range: bundles are published with the core
 * they were built beside, and a bundle refusing a *newer* core would make
 * every core release a coordinated release of everything ever sold.
 */
export function coreIsTooOld(running: string, needs: string): boolean {
  // An instance that cannot say what it is running is not told it is wrong;
  // a dev checkout has no version baked in and every bundle would refuse.
  if (!running || running === "unknown") return false;
  /*
   * A leading `v` and `+` build metadata are stripped first.
   *
   * `SENTRELLO_VERSION` is the image tag with the commit on the end —
   * `v0.26.7+e4e88f1` on a real host. Parsed digit by digit that yields NaN,
   * which is read below as "cannot tell" and answered `false`: the core is new
   * enough. So a bundle built against a core this instance does not have would
   * be imported anyway, and fail on an export it could not find — the cryptic
   * failure this function exists to turn into a sentence.
   */
  const parts = (v: string) =>
    (v.trim().replace(/^v/i, "").split("+")[0] ?? "")
      .split(".")
      .map((n) => Number.parseInt(n, 10));
  const [a, b] = [parts(running), parts(needs)];
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right;
  }
  return false;
}

async function discoverFromBundlesDir(dir: string): Promise<SentrelloModule[]> {
  const found: SentrelloModule[] = [];
  let entries: string[];
  try {
    const { readdir } = await import("node:fs/promises");
    /*
     * Directories only. A bundle is a directory; a README beside them is not a
     * bundle that failed to load, and saying so put a line on /healthz and on
     * the settings screen telling a business one of its paid features was
     * broken when nothing was.
     */
    entries = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return found; // no bundles directory: a Free instance
  }

  const running = process.env.SENTRELLO_VERSION ?? "unknown";

  for (const name of entries) {
    if (name.startsWith(".")) continue;
    try {
      // Asked before the import, because the import is what fails obscurely.
      const manifest = await import(`${dir}/${name}/package.json`, {
        with: { type: "json" },
      }).catch(() => null);
      const needs = (
        manifest as { default?: { sentrelloCore?: string } } | null
      )?.default?.sentrelloCore;
      if (needs && coreIsTooOld(running, needs)) {
        const reason = `it needs Sentrello ${needs} or newer, and this instance is running ${running}. Run \`sentrello update\`.`;
        failedBundles.push({ name, reason });
        console.error(`[modules] bundle ${name} did not load: ${reason}`);
        continue;
      }

      const mod: unknown = await import(`${dir}/${name}/src/index.ts`);
      const candidate = (mod as { default?: unknown }).default;
      if (isModule(candidate)) found.push(candidate);
      else {
        const reason = "it has no valid default export";
        failedBundles.push({ name, reason });
        console.error(`[modules] bundle ${name} did not load: ${reason}`);
      }
    } catch (err) {
      const reason = (err as Error).message;
      failedBundles.push({ name, reason });
      console.error(`[modules] bundle ${name} did not load: ${reason}`);
    }
  }
  return found;
}

/** Resolves whichever optional bundles are installed; missing ones are normal. */
export async function discoverOptionalModules(
  packages: string[] = OPTIONAL_MODULE_PACKAGES,
  bundlesDir = process.env.SENTRELLO_BUNDLES_DIR,
): Promise<SentrelloModule[]> {
  const found: SentrelloModule[] = [];

  // development: bundles linked into node_modules by `bun link`
  for (const name of packages) {
    try {
      const mod: unknown = await import(name);
      const candidate = (mod as { default?: unknown }).default;
      if (isModule(candidate)) found.push(candidate);
      else {
        const reason = "it has no valid default export";
        failedBundles.push({ name, reason });
        console.error(`[modules] ${name} did not load: ${reason}`);
      }
    } catch (err) {
      const message = (err as Error).message ?? "";
      if (!isNotInstalled(name, message)) {
        failedBundles.push({ name, reason: message });
        console.error(`[modules] ${name} did not load: ${message}`);
      }
    }
  }

  // production: bundles the installer unpacked
  if (bundlesDir) {
    // Ids already loaded, growing as the directory is walked.
    //
    // It used to be built once and never added to, which deduplicated a bundle
    // against a linked package and not against another bundle. Two directories
    // carrying the same module id — what a renamed bundle leaves behind, since
    // the installer only removes the names it is fetching — would both
    // register, and a module whose routes are registered twice is answered by
    // whichever won the race. Half-working is worse to diagnose than dark.
    const seen = new Set(found.map((m) => m.id));
    for (const module of await discoverFromBundlesDir(bundlesDir)) {
      if (seen.has(module.id)) {
        console.error(
          `[modules] ${module.id} is installed more than once; using the first`,
        );
        continue;
      }
      seen.add(module.id);
      found.push(module);
    }
  }

  return found;
}
