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

/**
 * Prose caught inside a code fence.
 *
 * On the backups page the fence opened, a paragraph about two instances on one
 * machine sat inside it, and the cron line it was meant to introduce sat at the
 * bottom. So the published page showed a code block with a paragraph of prose in
 * it, asterisks and backticks and all, and the warning about a second instance's
 * timer name — on the page whose subject is whether backups are running — was
 * unreadable.
 *
 * Nothing caught it, and nothing could: a fenced block is prose to every tool in
 * this repository, as the note at the top of this file says about the samples.
 * This is the cheapest half of that problem. A line inside a fence that starts
 * with `**` is markdown emphasis, and markdown emphasis inside a code block is
 * always a mistake — no language in this documentation begins a line that way.
 *
 * Fences are counted as well. An odd number means one was never closed, which
 * swallows the rest of the page.
 */
describe("the fences in the published documentation", () => {
  const pages = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir)) {
        const path = `${dir}/${entry}`;
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".md")) out.push(path);
      }
    };
    walk(`${import.meta.dir}/../../../docs`);
    return out;
  };

  test("no fence is left open", () => {
    const found = pages();
    expect(found.length).toBeGreaterThan(10);
    const odd = found.filter(
      (file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .filter((line) => line.trimStart().startsWith("```")).length %
          2 ===
        1,
    );
    expect(odd, `${odd.join(", ")} leaves a code fence open`).toEqual([]);
  });

  test("no paragraph is trapped inside one", () => {
    const trapped: string[] = [];
    for (const file of pages()) {
      let inside = false;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (line.trimStart().startsWith("```")) {
            inside = !inside;
            return;
          }
          if (inside && line.trimStart().startsWith("**")) {
            trapped.push(`${file}:${i + 1}  ${line.trim().slice(0, 80)}`);
          }
        });
    }
    expect(
      trapped,
      `markdown emphasis inside a code fence, which publishes as literal asterisks:\n  ${trapped.join("\n  ")}`,
    ).toEqual([]);
  });
});

/**
 * The extension guide's module imports from the SDK and nothing else.
 *
 * The module linking exception covers a module that reaches Core through
 * `@sentrello/module-sdk`, so the example a stranger copies to start one has to
 * stay inside it. It imported `requireSession` from `@sentrello/auth/hono` until
 * 9 October, which taught every reader to step outside the exception on the
 * first line they wrote. `@sentrello/module-sdk/server` hands those through.
 */
test("the extension guide's example imports only the module SDK", () => {
  const page = readFileSync(
    `${ROOT}/docs/site/03-platform/02-extensible.md`,
    "utf8",
  );
  const specs = [...page.matchAll(/```(?:ts|tsx)\n([\s\S]*?)```/g)].flatMap(
    ([, block]) =>
      [...(block ?? "").matchAll(/from\s*"([^"]+)"/g)].map(
        ([, spec]) => spec as string,
      ),
  );
  expect(specs.length, "the guide has no imports to check").toBeGreaterThan(0);
  expect(
    specs.filter(
      (spec) =>
        spec !== "@sentrello/module-sdk" &&
        !spec.startsWith("@sentrello/module-sdk/"),
    ),
  ).toEqual([]);
  expect(specs).toContain("@sentrello/module-sdk/server");
});
