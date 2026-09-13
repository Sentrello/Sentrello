import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A module cannot depend on one that does not exist.
 *
 * `requires` is checked by the loader against what it has actually loaded, and
 * a name nothing answers to can never be satisfied — so the module is skipped
 * on every pass, for ever, and until 2026-09-13 in silence.
 *
 * That is not hypothetical. `invoicing` and `accounting` stopped being modules
 * of their own when they merged into `money`, which imports both and registers
 * them itself. Three modules still named them:
 *
 * - `pro-core`, which is every Pro feature in the product
 * - `mod-shop`
 * - `mod-pos`, which requires the Shop and went with it
 *
 * All three were entitled, installed, and simply absent. Nothing on any screen
 * said why, and no test failed, because each module's own tests register it
 * directly and never go near the loader.
 *
 * So the ids are read out of the source of every module in every repository
 * and compared with what the dependencies ask for. Reading the files rather
 * than importing them, because importing a commercial bundle from here would
 * be the public repository naming one.
 */

/**
 * The core modules the host itself imports.
 *
 * Read from `index.ts` rather than from the directory, because the directory
 * is not the answer: `invoicing` and `accounting` are still files that call
 * `defineModule`, and they are still modules — they are simply never loaded as
 * modules of their own any more. `money` imports both and registers them
 * itself, so the loader has one id where there used to be three, and a
 * dependency on either of the other two can never be satisfied.
 *
 * The host's import list is the only place that distinction is written down.
 */
function coreIds(): string[] {
  const index = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
  return [...index.matchAll(/from "@sentrello\/module-([a-z0-9-]+)"/g)]
    .map((m) => m[1] as string)
    .filter((id) => id !== "sdk");
}

/** The commercial bundles this host will use if they are on disk. */
function bundleIds(): string[] {
  const source = readFileSync(
    join(import.meta.dir, "optional-modules.ts"),
    "utf8",
  );
  const list = source.slice(
    source.indexOf("OPTIONAL_MODULE_PACKAGES"),
    source.indexOf("];", source.indexOf("OPTIONAL_MODULE_PACKAGES")),
  );
  return [...list.matchAll(/"@sentrello\/(?:mod-)?([a-z0-9-]+)"/g)]
    .map((m) => m[1] as string)
    .filter((id) => !["control-plane", "master", "seo-cloud"].includes(id));
}

interface Declared {
  where: string;
  id: string;
  requires: string[];
}

/** Every `defineModule` in the commercial repositories, read as text. */
function declared(): Declared[] {
  const out: Declared[] = [];

  for (const repo of ["Pro", "Modules"]) {
    const root = join(import.meta.dir, "../../../..", repo);
    if (!existsSync(root)) continue;

    const listed = spawnSync("git", ["ls-files", "packages/*/src/index.ts"], {
      cwd: root,
      encoding: "utf8",
    });
    if (listed.status !== 0) continue;

    for (const file of listed.stdout.split("\n").filter(Boolean)) {
      const source = readFileSync(join(root, file), "utf8");
      const at = source.indexOf("defineModule({");
      if (at === -1) continue;
      const block = source.slice(at);

      const id = block.match(/^\s*id:\s*"([a-z0-9-]+)"/m)?.[1];
      if (!id) continue;

      const requires = (block.match(/^\s*requires:\s*\[([^\]]*)\]/m)?.[1] ?? "")
        .split(",")
        .map((r) => r.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);

      out.push({ where: `${repo}/${file}`, id, requires });
    }
  }
  return out;
}

/**
 * Whether the commercial repositories are beside this one.
 *
 * They are on a development machine and they are not in CI, which checks out
 * this repository alone. An empty listing has to skip rather than fail — but it
 * must not quietly pass either, because a listing that came back empty for any
 * other reason would satisfy every assertion under it without reading a line.
 */
const siblings = ["Pro", "Modules"].some((repo) =>
  existsSync(join(import.meta.dir, "../../../..", repo, "packages")),
);

test.skipIf(!siblings)(
  "every module a dependency names is one the host can load",
  () => {
    const all = declared();
    expect(all.length).toBeGreaterThan(5);

    const loadable = new Set([
      ...coreIds(),
      ...bundleIds(),
      ...all.map((m) => m.id),
    ]);
    const dangling = all.flatMap((m) =>
      m.requires
        .filter((r) => !loadable.has(r))
        .map(
          (r) =>
            `${m.where} (${m.id}) requires "${r}", which this host never loads`,
        ),
    );

    expect(dangling).toEqual([]);
  },
);

/**
 * And the merge that caused it is pinned from the other side.
 *
 * If `money` is ever split back into two, this fails and says so — rather than
 * the split being made and three modules going dark a second time.
 */
test("money is the module the host loads, and invoicing is not", () => {
  const core = coreIds();
  expect(core).toContain("money");
  // Both are still files that define a module. Neither is loaded as one: money
  // imports and registers them, so the loader has one id where there were
  // three. A split back into two fails here rather than going dark again.
  expect(core).not.toContain("invoicing");
  expect(core).not.toContain("accounting");
});
