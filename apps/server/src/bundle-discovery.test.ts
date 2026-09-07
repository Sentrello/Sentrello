import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverOptionalModules, failedBundles } from "./optional-modules";

/**
 * A module a customer just bought turns up without anybody editing this repo.
 *
 * This is the mechanism the whole "new modules arrive like any other update"
 * promise rests on: the installer fetches whatever the licence entitles into
 * the bundles directory, and the host finds it there by walking the directory
 * rather than by knowing its name. `OPTIONAL_MODULE_PACKAGES` is the
 * *development* path — `bun link` from a sibling checkout — and a list in this
 * repository naming commercial packages could never be the production one:
 * Core would have to be edited and re-released for every module ever sold.
 *
 * It had no test. Four separate bugs this month came from a hardcoded list
 * somebody had to remember, and the check that a directory walk needs no such
 * list is the one that was missing.
 */
async function bundleDir(name: string, source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sentrello-bundles-"));
  await mkdir(join(root, name, "src"), { recursive: true });
  await writeFile(join(root, name, "src", "index.ts"), source);
  return root;
}

/** A module whose name appears nowhere in this repository. */
const A_MODULE = `
  export default {
    id: "mod-something-nobody-here-has-heard-of",
    tier: "module",
    register() {},
  };
`;

test("a bundle nobody named is found and loaded", async () => {
  const dir = await bundleDir("mod-whatever", A_MODULE);

  // No packages at all: this is the production path with nothing linked.
  const found = await discoverOptionalModules([], dir);

  expect(found.map((m) => m.id)).toEqual([
    "mod-something-nobody-here-has-heard-of",
  ]);
});

/**
 * And it does not need to be entitled to be found.
 *
 * Discovery and entitlement are two steps on purpose — the loader gates what
 * it registers — so a bundle present on disk is expected to be *discovered*
 * whatever the licence says. Asserting it here keeps somebody from "fixing"
 * discovery by filtering it, which would move the gate somewhere with no test.
 */
test("discovery does not decide entitlement", async () => {
  const dir = await bundleDir("mod-not-paid-for", A_MODULE);
  const found = await discoverOptionalModules([], dir);
  expect(found).toHaveLength(1);
});

test("a bundle that throws on import is reported, not swallowed", async () => {
  const before = failedBundles.length;
  const dir = await bundleDir(
    "mod-broken",
    'throw new Error("the database driver is missing");',
  );

  const found = await discoverOptionalModules([], dir);

  expect(found).toEqual([]);
  const reported = failedBundles.slice(before);
  expect(reported).toHaveLength(1);
  expect(reported[0]?.name).toBe("mod-broken");
  expect(reported[0]?.reason).toContain("the database driver is missing");
});

test("a bundle with no module in it is reported", async () => {
  const before = failedBundles.length;
  const dir = await bundleDir("mod-empty", "export default { hello: 1 };");

  expect(await discoverOptionalModules([], dir)).toEqual([]);
  expect(failedBundles.slice(before)[0]?.reason).toContain(
    "no valid default export",
  );
});

/** No bundles directory at all is a Free instance, and not a failure. */
test("no bundles directory is silence, not an error", async () => {
  const before = failedBundles.length;
  const found = await discoverOptionalModules(
    [],
    join(tmpdir(), "sentrello-there-is-nothing-here"),
  );
  expect(found).toEqual([]);
  expect(failedBundles.slice(before)).toEqual([]);
});

/**
 * The same module linked in development and unpacked in production loads once.
 *
 * Our own machines have both: a `bun link` to the sibling repo *and* a bundles
 * directory left by a demo refresh. Registering it twice would register its
 * routes twice, and Hono answers with the first match — so the symptom would
 * be a module that half works, which is the worst kind to diagnose.
 */
test("a module found both ways is registered once", async () => {
  const dir = await bundleDir("mod-twice", A_MODULE);
  const found = await discoverOptionalModules([], dir);
  const again = await discoverOptionalModules([], dir);

  // Each call is independent; within one call, ids are deduplicated.
  expect(found).toHaveLength(1);
  expect(again).toHaveLength(1);

  const both = await bundleDir("mod-twice-b", A_MODULE);
  await mkdir(join(both, "mod-twice-c", "src"), { recursive: true });
  await writeFile(join(both, "mod-twice-c", "src", "index.ts"), A_MODULE);

  // Two directories, one module id between them.
  const deduped = await discoverOptionalModules([], both);
  expect(deduped).toHaveLength(1);
});
