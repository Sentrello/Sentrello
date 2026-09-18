import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";

/**
 * The code in the published documentation, checked against the code it names.
 *
 * docs/site/ is customer-facing product documentation, synced hourly to
 * docs.sentrello.com by the Docs module. A sample there is the first thing
 * somebody writing a module copies, so a wrong import path in it costs a
 * stranger an afternoon and teaches them the platform is sloppy.
 *
 * The first draft of the platform section had exactly that: it imported
 * `requireSession` from `@sentrello/auth`, which does not export it —
 * `@sentrello/auth/hono` does. Nothing would have caught it, because a fenced
 * code block is prose to every tool in this repository.
 *
 * This does not compile the samples. It checks the two things that rot without
 * anybody noticing: that every `@sentrello/*` path a sample imports from is a
 * real export of a real package, and that every symbol it names is actually
 * exported from the file behind that path. A renamed export fails here.
 */

const ROOT = `${import.meta.dir}/../../..`;
const DOCS = `${ROOT}/docs/site`;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = `${dir}/${entry}`;
    return statSync(path).isDirectory()
      ? walk(path)
      : path.endsWith(".md")
        ? [path]
        : [];
  });

/** `import { a, b } from "@sentrello/pkg/sub";` inside a fenced block. */
interface Sample {
  file: string;
  spec: string;
  names: string[];
}

function samples(): Sample[] {
  const found: Sample[] = [];
  for (const file of walk(DOCS)) {
    const text = readFileSync(file, "utf8");
    for (const [, block] of text.matchAll(/```(?:ts|tsx)\n([\s\S]*?)```/g)) {
      for (const [, inner, spec] of (block ?? "").matchAll(
        /import\s*\{([^}]*)\}\s*from\s*"(@sentrello\/[^"]+)"/g,
      )) {
        found.push({
          file: file.slice(ROOT.length + 1),
          spec: spec as string,
          names: (inner as string)
            .split(",")
            .map((n) => n.trim().replace(/^type\s+/, ""))
            .filter(Boolean),
        });
      }
    }
  }
  return found;
}

/** Where a package's `exports` map sends a specifier. */
function resolve(spec: string): string | null {
  const [, name, ...rest] = spec.split("/");
  const sub = rest.length > 0 ? `./${rest.join("/")}` : ".";
  for (const dir of ["packages", "packages/modules-free"]) {
    const manifest = `${ROOT}/${dir}/${name}/package.json`;
    if (!existsSync(manifest)) continue;
    const exports = (
      JSON.parse(readFileSync(manifest, "utf8")) as {
        exports?: Record<string, string>;
      }
    ).exports;
    const target = exports?.[sub];
    return target
      ? `${ROOT}/${dir}/${name}/${target.replace(/^\.\//, "")}`
      : null;
  }
  return null;
}

describe("the published documentation's code samples", () => {
  const all = samples();

  test("there are samples to check at all", () => {
    // Without this the whole file passes vacuously the day the extraction
    // regex stops matching — which is the failure mode of every check that
    // reads source as text.
    expect(all.length).toBeGreaterThan(0);
  });

  test("every @sentrello import path is a real package export", () => {
    for (const { file, spec } of all) {
      expect(
        resolve(spec),
        `${file} imports from "${spec}", which no package exports`,
      ).not.toBeNull();
    }
  });

  test("every symbol a sample imports is exported by that file", () => {
    for (const { file, spec, names } of all) {
      const path = resolve(spec);
      if (!path || !existsSync(path)) continue;
      const source = readFileSync(path, "utf8");
      for (const name of names) {
        const exported = new RegExp(
          `export\\s+(async\\s+)?(function|const|let|class|interface|type|enum)\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b`,
        ).test(source);
        expect(
          exported,
          `${file} imports { ${name} } from "${spec}", and ${path.slice(ROOT.length + 1)} does not export it`,
        ).toBe(true);
      }
    }
  });
});
