import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * The bill of materials describes what is actually here.
 *
 * Executive Order 14028 requires one from anybody selling software to the US
 * federal government, and it is what answers "are we affected by this morning's
 * advisory" in a minute. Both uses depend on it being complete and on the
 * identifiers being right — and both fail *silently* when it is not, because a
 * scanner that matches nothing reports all clear.
 *
 * So the two ways it went wrong while being written are tested, rather than the
 * fact that it produces JSON.
 */
/*
 * The version is handed in, because the generator refuses without one.
 *
 * It used to fall back to "0.0.0" when the workspace root had no `version`
 * field — which it does not — so every document ever published named no
 * release, including the one serving as the current bill of materials the day
 * v1 shipped. It refuses now; and the first version of this test then broke in
 * CI but not here, because `actions/checkout` is shallow and has no tags for
 * the generator's other fallback to find.
 */
const sbom = JSON.parse(
  execFileSync(
    "bun",
    ["run", join(import.meta.dir, "../../../scripts/sbom.ts")],
    {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, SENTRELLO_VERSION: "0.0.0-test" },
    },
  ),
) as {
  bomFormat: string;
  specVersion: string;
  components: {
    name: string;
    version: string;
    purl: string;
    hashes?: unknown[];
  }[];
};

test("it is a CycloneDX document", () => {
  expect(sbom.bomFormat).toBe("CycloneDX");
  expect(sbom.specVersion).toBe("1.5");
});

/**
 * The first attempt walked `node_modules` and found 43 of 357 packages, because
 * Bun keeps the real ones in `node_modules/.bun` and the walk skipped
 * dot-directories. An SBOM missing seven eighths of the tree is worse than
 * none: it answers "are we affected" with a confident no.
 */
test("it lists the whole dependency tree, not the part that is easy to see", () => {
  expect(sbom.components.length).toBeGreaterThan(300);
});

/**
 * The lockfile keys a nested dependency by its *path* —
 * `@authenio/xml-encryption/xpath` — and reading that as a package name
 * produces a purl for something that does not exist. A scanner matching purls
 * then finds nothing, which looks exactly like being unaffected.
 */
test("names come from the package, not from the lockfile's path key", () => {
  const wrong = sbom.components.filter((c) => {
    const scoped = c.name.startsWith("@");
    const slashes = c.name.split("/").length - 1;
    return scoped ? slashes > 1 : slashes > 0;
  });
  expect(wrong.map((c) => c.name)).toEqual([]);
});

test("every component can be identified and most can be verified", () => {
  for (const c of sbom.components) {
    expect(c.purl).toContain(c.version);
    expect(c.name.length).toBeGreaterThan(0);
  }
  // Not all: a package the lockfile resolved but Bun never fetched has no
  // integrity to record, and claiming one would be worse than the gap.
  const withHash = sbom.components.filter((c) => c.hashes?.length).length;
  expect(withHash / sbom.components.length).toBeGreaterThan(0.9);
});

/** Two runs of the same tree differ only by the timestamp. */
test("it is reproducible", () => {
  const again = JSON.parse(
    execFileSync(
      "bun",
      ["run", join(import.meta.dir, "../../../scripts/sbom.ts")],
      {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      },
    ),
  ) as { metadata: { timestamp: string }; components: unknown[] };
  expect(JSON.stringify(again.components)).toBe(
    JSON.stringify(sbom.components),
  );
});

test("it refuses to describe a release it cannot name", () => {
  // The silent "0.0.0" is what made a nameless document publishable, so the
  // refusal is the fix and belongs under a test of its own. `git describe` is
  // kept out of the way with an empty cwd-relative tag namespace rather than
  // by moving the script.
  const run = Bun.spawnSync(
    ["bun", "run", join(import.meta.dir, "../../../scripts/sbom.ts")],
    {
      env: {
        ...process.env,
        SENTRELLO_VERSION: "",
        // `git describe` resolves tags through this; pointed at a directory
        // with no repository in it, it finds none and exits non-zero.
        GIT_CEILING_DIRECTORIES: "/",
        GIT_DIR: "/nonexistent",
      },
    },
  );

  expect(run.exitCode).toBe(1);
  expect(run.stderr.toString()).toContain("no version");
});
