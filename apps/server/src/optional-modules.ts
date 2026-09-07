import type { SentrelloModule } from "@sentrello/module-sdk";

/**
 * Commercial bundles this host will use *if they are present on disk*.
 *
 * They are deliberately NOT dependencies of this package: Core is public and
 * AGPL, and must never declare or vendor commercial code. In development they
 * appear via `bun link` from the sibling Pro/Modules repos; in distribution the
 * installer only unpacks the bundles a license entitles (Packet 03).
 *
 * Presence alone grants nothing — the loader still checks `entitled(...)`, so a
 * leaked bundle without a valid license token stays dark.
 */
export const OPTIONAL_MODULE_PACKAGES = [
  "@sentrello/pro-core",
  // Ships with Pro, but a package of its own: it is a public redirect service
  // with a database behind it and shares nothing with pro-core's half of CRM,
  // invoicing and the books.
  "@sentrello/pro-links",
  // Also ships with Pro, and also a package of its own: a business's plan
  // should not come and go with its bookkeeping features.
  "@sentrello/pro-projects",
  "@sentrello/mod-scheduling",
  "@sentrello/mod-shop",
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

async function discoverFromBundlesDir(dir: string): Promise<SentrelloModule[]> {
  const found: SentrelloModule[] = [];
  let entries: string[];
  try {
    const { readdir } = await import("node:fs/promises");
    entries = await readdir(dir);
  } catch {
    return found; // no bundles directory: a Free instance
  }

  for (const name of entries) {
    if (name.startsWith(".")) continue;
    try {
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
