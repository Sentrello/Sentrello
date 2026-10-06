/**
 * A class name with an interpolation stuck to it generates no rule.
 *
 * Tailwind finds classes by scanning these files for candidates, and a
 * candidate ends where its run of characters ends. Written as
 *
 *     className={`grid lg:grid-cols-[2fr_minmax(0,1fr)]${open ? "" : " hidden"}`}
 *
 * the scanner reads `lg:grid-cols-[2fr_minmax(0,1fr)]${open` as one token,
 * fails to parse it, and emits **no rule for that class at all**. The class
 * name still reaches the browser, because the markup is built at runtime — so
 * the source is right, the DOM is right, and the stylesheet is missing one
 * line.
 *
 * On 6 October that took the till's two columns down to one: the menu, with the
 * sale panel underneath it and `lg:sticky` holding it over the top, so every
 * product on the menu was behind it. Nothing in the source was wrong. No unit
 * test could see it. The browser walk caught it, and only because the step that
 * rebuilds the screens had been fixed an hour earlier.
 *
 * The rule is one character: a space before every `${`. This asks for it, and
 * has no exclusions — there is no case where a class name wants an
 * interpolation welded to its end.
 */
import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** This repository's screens: the web app, which is all of them here. */
const ROOTS = ["."];

function sources(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name.startsWith("."))
      continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (name.endsWith(".tsx")) out.push(path);
  }
  return out;
}

const files = ROOTS.flatMap((root) =>
  sources(join(import.meta.dir, "..", root)),
);

test("the screens were read, so this is checking something", () => {
  expect(files.length).toBeGreaterThan(5);
});

test("no class name has an interpolation welded to it", () => {
  const welded: string[] = [];
  for (const path of files) {
    const text = readFileSync(path, "utf8");
    // Every `className={` … `}` holding a template literal, then every `${`
    // inside it whose previous character is neither a space nor the backtick
    // that opened it.
    for (const match of text.matchAll(/className=\{`([^`]*)`/g)) {
      const body = match[1] ?? "";
      for (const at of [...body.matchAll(/\$\{/g)]) {
        const before = body[(at.index ?? 0) - 1];
        if (before === undefined || before === " ") continue;
        const line = text.slice(0, match.index).split("\n").length;
        welded.push(
          `${path.slice(path.indexOf("/src/") + 1)}:${line} — …${before}\${`,
        );
      }
    }
  }
  expect(
    welded,
    `a class name ends where its characters end, so Tailwind emits no rule for one with \${ stuck to it. Put a space before it:\n    ${welded.join("\n    ")}`,
  ).toEqual([]);
});
