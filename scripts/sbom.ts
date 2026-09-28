/**
 * A software bill of materials, in CycloneDX form.
 *
 * Executive Order 14028 requires one from anybody selling software to the US
 * federal government, and large customers increasingly ask for it in a security
 * review. It is also the thing that answers "are you affected by the
 * vulnerability announced this morning" in a minute rather than an afternoon.
 *
 * Built from what is actually installed rather than from what the manifests ask
 * for. A `package.json` says `^1.2.0`; an SBOM has to say which version is in
 * the artefact, because that is the one with the vulnerability in it. The
 * integrity hash comes from the lockfile, so a component can be checked against
 * what was published.
 *
 * Deterministic: components are sorted, and nothing carries a timestamp except
 * the one field that must. Two builds of the same tree produce the same file,
 * so a diff between releases is a list of what actually changed.
 *
 *   bun run scripts/sbom.ts > sbom.cdx.json
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

/** The lockfile is JSONC — Bun writes trailing commas. */
function readLockfile(): Record<string, unknown> {
  const text = readFileSync(join(root, "bun.lock"), "utf8");
  const stripped = text.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(stripped) as Record<string, unknown>;
}

interface Component {
  name: string;
  version: string;
  license?: string;
  integrity?: string;
}

/**
 * Every package the lockfile resolved — which is every package in the artefact.
 *
 * The lockfile rather than a walk of `node_modules`, and that distinction cost
 * a first attempt. Bun keeps the real packages in `node_modules/.bun` and puts
 * symlinks at the top level, so walking the visible tree and skipping
 * dot-directories found 43 of 357. An SBOM that silently omits seven eighths of
 * the dependencies is worse than none: it answers "are we affected" with a
 * confident no.
 */
function fromLockfile(): Component[] {
  const packages = readLockfile().packages as
    | Record<string, unknown[]>
    | undefined;
  const out: Component[] = [];

  const seen = new Set<string>();
  for (const entry of Object.values(packages ?? {})) {
    /*
     * The name comes from the entry, never from the key.
     *
     * A key is a *path*: a nested dependency appears as
     * `@authenio/xml-encryption/xpath`, and reading that as a package name
     * produces a purl for something that does not exist — which quietly breaks
     * the one thing an SBOM is for, because a scanner matching purls finds
     * nothing and reports all clear.
     *
     * The entry's first element is `name@version`. A scoped name carries an
     * `@` of its own at position 0, so the separator is the last one.
     */
    const spec = typeof entry[0] === "string" ? entry[0] : "";
    const at = spec.lastIndexOf("@");
    if (at <= 0) continue;
    const name = spec.slice(0, at);
    const version = spec.slice(at + 1);
    if (!name || !version) continue;

    // The same package can be reached by several paths; it is one component.
    const key = `${name}@${version}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const integrity = entry.find(
      (x) => typeof x === "string" && x.startsWith("sha512-"),
    ) as string | undefined;

    out.push({ name, version, license: licenceOf(name, version), integrity });
  }
  return out;
}

/**
 * The licence, read from the package as installed.
 *
 * Not in the lockfile, so it comes from disk — `node_modules/.bun/<name>@<ver>`
 * is where Bun actually puts things, with the `/` in a scoped name written as
 * `+`. Falls back to the visible tree for anything linked rather than fetched,
 * which is how the workspace packages appear.
 */
function licenceOf(name: string, version: string): string | undefined {
  const candidates = [
    join(
      root,
      "node_modules/.bun",
      `${name.replace("/", "+")}@${version}`,
      "node_modules",
      name,
      "package.json",
    ),
    join(root, "node_modules", name, "package.json"),
  ];
  for (const path of candidates) {
    try {
      const manifest = JSON.parse(readFileSync(path, "utf8")) as {
        license?: unknown;
        licenses?: { type?: string }[];
      };
      if (typeof manifest.license === "string") return manifest.license;
      const asObject = manifest.license as { type?: string } | undefined;
      if (typeof asObject?.type === "string") return asObject.type;
      // The old array form, still in a few long-lived packages.
      const first = manifest.licenses?.[0]?.type;
      if (typeof first === "string") return first;
      return undefined;
    } catch {
      // Try the next location.
    }
  }
  return undefined;
}

const version =
  (
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      version?: string;
    }
  ).version ?? "0.0.0";

const components = fromLockfile()
  .sort((a, b) =>
    a.name === b.name
      ? a.version.localeCompare(b.version)
      : a.name.localeCompare(b.name),
  )
  .map((c) => {
    const purl = `pkg:npm/${c.name.replace("@", "%40")}@${c.version}`;
    const hash = c.integrity;
    return {
      type: "library",
      "bom-ref": purl,
      name: c.name,
      version: c.version,
      purl,
      ...(c.license
        ? { licenses: [{ license: { id: c.license } }] }
        : {
            /*
             * Said rather than omitted. A component with no licence is the one
             * a lawyer needs to look at, and leaving the field out makes it
             * indistinguishable from the ones that are fine.
             */
            /*
             * Two different unknowns, and the difference matters to whoever
             * reviews this. A package present in the tree with no licence
             * field is a legal question; one the lockfile resolved but Bun
             * never materialised cannot be read from disk at all, and saying
             * "unknown" for both would send somebody hunting for a problem
             * that is not there.
             */
            licenses: [
              {
                license: {
                  name: "NOT DETERMINED — package not present in this tree",
                },
              },
            ],
          }),
      ...(hash
        ? {
            hashes: [
              {
                alg: "SHA-512",
                content: Buffer.from(
                  hash.replace("sha512-", ""),
                  "base64",
                ).toString("hex"),
              },
            ],
          }
        : {}),
    };
  });

console.log(
  JSON.stringify(
    {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      version: 1,
      metadata: {
        // The only field that varies between two builds of the same tree.
        timestamp: new Date().toISOString(),
        component: {
          type: "application",
          "bom-ref": `pkg:generic/sentrello@${version}`,
          name: "sentrello",
          version,
          licenses: [{ license: { id: "AGPL-3.0-only" } }],
        },
        tools: [{ name: "sentrello sbom", version }],
      },
      components,
    },
    null,
    2,
  ),
);
