import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  coreIsTooOld,
  discoverOptionalModules,
  failedBundles,
  migrateLoadedModules,
} from "./optional-modules";

/**
 * Put `failedBundles` back the way it was found.
 *
 * It is a module-level array — one per process, shared by everything in it —
 * and these tests deliberately push to it. `boot.test.ts` then asks /healthz
 * for `modules_failed` and expects nothing, so whether that passes depended
 * on which file bun happened to run first.
 *
 * It failed in CI the day a new test file was added elsewhere in this
 * directory and changed the ordering. Nothing about either test was wrong;
 * the leak had been there the whole time, waiting for an alphabet.
 *
 * Truncated rather than reassigned, because the export is a `const` binding
 * and every other module in the process is holding the same array.
 */
afterEach(() => {
  failedBundles.length = 0;
});

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

/**
 * A bundle that needs a newer core says so, instead of throwing on import.
 *
 * The failure this replaces is on record: a `pro-projects` bundle built beside
 * a core that had just gained a `date` export was installed on an instance one
 * release behind, and every screen it carried was simply absent. The loader
 * failed safe and reported it, which is the design working — but what it
 * reported was `Export named 'date' not found`, which names neither the fix
 * nor the versions involved.
 */
test("a bundle built for a newer core says which one it needs", async () => {
  const before = failedBundles.length;
  const dir = await bundleDir("mod-ahead", A_MODULE);
  await writeFile(
    join(dir, "mod-ahead", "package.json"),
    JSON.stringify({ name: "mod-ahead", sentrelloCore: "0.27.0" }),
  );

  const was = process.env.SENTRELLO_VERSION;
  process.env.SENTRELLO_VERSION = "0.26.3";
  try {
    expect(await discoverOptionalModules([], dir)).toEqual([]);
  } finally {
    if (was === undefined) process.env.SENTRELLO_VERSION = undefined;
    else process.env.SENTRELLO_VERSION = was;
  }

  const reported = failedBundles.slice(before);
  expect(reported[0]?.reason).toContain("0.27.0 or newer");
  expect(reported[0]?.reason).toContain("0.26.3");
  expect(reported[0]?.reason).toContain("sentrello update");
});

test("a core new enough loads it", async () => {
  const dir = await bundleDir("mod-fine", A_MODULE);
  await writeFile(
    join(dir, "mod-fine", "package.json"),
    JSON.stringify({ name: "mod-fine", sentrelloCore: "0.26.0" }),
  );

  const was = process.env.SENTRELLO_VERSION;
  process.env.SENTRELLO_VERSION = "0.26.3";
  try {
    expect(await discoverOptionalModules([], dir)).toHaveLength(1);
  } finally {
    if (was === undefined) process.env.SENTRELLO_VERSION = undefined;
    else process.env.SENTRELLO_VERSION = was;
  }
});

/**
 * Version ordering, where string comparison is wrong.
 *
 * `"0.9.0" < "0.10.0"` is false as strings and true as versions, and a check
 * that got this backwards would refuse to load bundles that were fine — which
 * is the same outcome as the bug it was written to prevent.
 */
test("versions compare as numbers, not as strings", () => {
  expect(coreIsTooOld("0.9.0", "0.10.0")).toBe(true);
  expect(coreIsTooOld("0.10.0", "0.9.0")).toBe(false);
  expect(coreIsTooOld("1.0.0", "0.26.3")).toBe(false);
  expect(coreIsTooOld("0.26.3", "0.26.3")).toBe(false);
  expect(coreIsTooOld("0.26", "0.26.1")).toBe(true);

  // A checkout with no version baked in refuses nothing: every bundle would
  // fail to load on a developer's machine, which is where they are written.
  expect(coreIsTooOld("unknown", "9.9.9")).toBe(false);
  expect(coreIsTooOld("", "9.9.9")).toBe(false);
  expect(coreIsTooOld("0.26.3", "not-a-version")).toBe(false);
});

/**
 * How a real instance stamps itself.
 *
 * `SENTRELLO_VERSION` on a real instance is `v0.26.7+e4e88f1` — the image
 * tag, with the commit on the end. Parsed digit by digit that produced NaN,
 * which this function reads as "cannot tell" and answers `false` to.
 *
 * `false` here means "the core is new enough", so a bundle built against a
 * core this instance does not have would be imported anyway and fail on an
 * export it could not find — which is precisely the cryptic failure this
 * function was written to turn into a sentence.
 */
test("a v prefix and build metadata do not defeat the comparison", () => {
  expect(coreIsTooOld("v0.26.7+e4e88f1", "0.27.9")).toBe(true);
  expect(coreIsTooOld("v0.27.9+e4e88f1", "0.26.7")).toBe(false);
  expect(coreIsTooOld("0.26.7", "v0.27.9")).toBe(true);
  expect(coreIsTooOld("v0.26.7+aaaaaaa", "v0.26.7+bbbbbbb")).toBe(false);
});

/**
 * A file sitting beside the bundles is not a bundle that failed.
 *
 * The walk treated every entry as a directory to import from, so a README next
 * to them became "bundle README.md did not load" — on /healthz and on the
 * settings screen, where that sentence means a paid feature is gone. Telling a
 * business one of its modules is broken when nothing is wrong is the fastest
 * way to teach it to ignore the place we report real breakage.
 */
test("a stray file beside the bundles is not reported as a broken one", async () => {
  const root = await bundleDir("mod-real", A_MODULE);
  await writeFile(join(root, "README.md"), "# these are the bundles\n");

  const before = failedBundles.length;
  const found = await discoverOptionalModules([], root);

  expect(found.map((m) => m.id)).toContain(
    "mod-something-nobody-here-has-heard-of",
  );
  expect(failedBundles.slice(before)).toEqual([]);
});

/**
 * A module whose tables will not build stops being offered.
 *
 * This is the project's most reliable bug shape wearing a new coat: the code
 * was there, it was correct, and every door onto it opened into a room with no
 * floor. A module whose migrations threw used to log one line and carry on in
 * `loaded` — /healthz reported the instance healthy, `/api/_meta` offered the
 * module, the rail drew it, and every screen behind it answered 500 against
 * tables that did not exist. The only witness was whoever happened to be
 * reading stdout as it scrolled past, which on a customer's own server is
 * nobody.
 *
 * Demoting it does not unregister its routes — registration happens first and
 * Hono cannot take a route back. It takes the module out of everything that
 * points at those routes, which is the part a person sees.
 */
const withTables = (id: string) =>
  ({
    id,
    migrations: { dir: `/tmp/${id}`, table: `__${id}` },
  }) as unknown as Parameters<typeof migrateLoadedModules>[0][number];

const quiet = { log: () => {}, error: () => {} };

test("a module whose migrations fail is reported, not left serving", async () => {
  const loaded = ["shop", "booking", "links"];
  const before = failedBundles.length;

  await migrateLoadedModules(
    [withTables("shop"), withTables("booking"), withTables("links")],
    loaded,
    async (dir) => {
      if (dir.endsWith("booking"))
        throw new Error('relation "x" does not exist');
    },
    quiet,
  );

  // Gone from what the instance says it is running, so nothing draws a door.
  expect(loaded).toEqual(["shop", "links"]);

  const reported = failedBundles.slice(before);
  expect(reported).toHaveLength(1);
  expect(reported[0]?.name).toBe("booking");
  // The reason carries Postgres's own words: "its features may not work" sent
  // whoever read it back to the logs for the sentence that actually said why.
  expect(reported[0]?.reason).toContain('relation "x" does not exist');
});

test("one module's broken tables do not stop the next module's", async () => {
  // The business still has invoices to send today. A module that will not
  // migrate is a module, not the instance.
  const loaded = ["shop", "booking"];
  const migrated: string[] = [];

  await migrateLoadedModules(
    [withTables("booking"), withTables("shop")],
    loaded,
    async (dir) => {
      if (dir.endsWith("booking")) throw new Error("nope");
      migrated.push(dir);
    },
    quiet,
  );

  expect(migrated).toEqual(["/tmp/shop"]);
  expect(loaded).toEqual(["shop"]);
});

test("a module the licence never loaded is not migrated at all", async () => {
  // Someone else's schema has no business in this customer's database.
  const loaded = ["shop"];
  const seen: string[] = [];

  await migrateLoadedModules(
    [withTables("shop"), withTables("pos")],
    loaded,
    async (dir) => {
      seen.push(dir);
    },
    quiet,
  );

  expect(seen).toEqual(["/tmp/shop"]);
  expect(failedBundles).toHaveLength(0);
});
