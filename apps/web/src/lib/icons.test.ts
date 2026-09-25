import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { GROUP_ICONS } from "./app-shell";
import { GLYPHS } from "./icons";

/**
 * Asserted against `GLYPHS`, not the fetched set. `GLYPHS` is what the
 * application actually draws — the fetched set with our own marks over the
 * top, for the three that are geometry rather than pictures — and "can this
 * name be drawn" is the only question any of this is asking.
 *
 * `icon-flex.ts` is generated, and the map behind it lives in a script
 * nobody runs by accident. So the way this set goes wrong is not a bad path —
 * it is a name: somebody adds a nav entry asking for an icon that was never
 * fetched, and the rail quietly draws the fallback. Nothing errors, nothing
 * shows in the diff, and the first person to notice is looking at a sidebar.
 * The last test here is the one that catches it.
 */
test("every group the rail draws has a drawing", () => {
  const missing = Object.entries(GROUP_ICONS)
    .filter(([, icon]) => !GLYPHS[icon])
    .map(([group]) => group);
  expect(missing).toEqual([]);
});

test("every drawing is markup, and only markup", () => {
  const bad: string[] = [];
  for (const [name, body] of Object.entries(GLYPHS)) {
    if (typeof body !== "string" || !body.trim()) bad.push(`${name}: empty`);
    // `<circle>` as well as `<path>`: an ellipsis is three dots and drawing
    // them as paths to satisfy a regex would be worse than the regex.
    else if (!/<(path|circle|rect)/.test(body)) bad.push(`${name}: no shape`);
    else if (/<script|http/i.test(body)) bad.push(`${name}: reaches outside`);
  }
  expect(bad).toEqual([]);
});

/**
 * The aliases exist so a module built against an older name still draws. One
 * pointing at a name we no longer fetch draws nothing, which is worse than
 * the name it was meant to rescue.
 */
test("every alias points at a drawing", () => {
  const source = readFileSync(join(import.meta.dir, "icons.tsx"), "utf8");
  const block = source.match(/const ALIASES[^{]*\{([^}]*)\}/)?.[1] ?? "";
  const targets = [...block.matchAll(/:\s*"([a-z0-9-]+)"/g)].map(
    (m) => m[1] ?? "",
  );
  expect(targets.length).toBeGreaterThan(0);
  expect(targets.filter((t) => !GLYPHS[t])).toEqual([]);
});

/**
 * Every name anybody asks for, anywhere in the repository — a route rendering
 * `<Icon name="…" />`, a module registering nav with `icon: "…"`. This is the
 * test that fails when a nav entry names an icon we never fetched.
 */
test("every icon the repository asks for is one the app can draw", () => {
  const root = join(import.meta.dir, "../../../..");
  const skip = new Set(["node_modules", "dist", ".git", "build", "coverage"]);
  const asked = new Set<string>();

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.tsx?$/.test(entry) || entry.endsWith(".d.ts")) continue;
      const source = readFileSync(path, "utf8");
      for (const m of source.matchAll(/<Icon\s+name="([a-z0-9-]+)"/g)) {
        if (m[1]) asked.add(m[1]);
      }
      for (const m of source.matchAll(/\bicon:\s*"([a-z0-9-]+)"/g)) {
        if (m[1]) asked.add(m[1]);
      }
    }
  };
  walk(join(root, "apps"));
  walk(join(root, "packages"));

  expect(asked.size).toBeGreaterThan(20);
  expect([...asked].filter((name) => !GLYPHS[name]).sort()).toEqual([]);
});
