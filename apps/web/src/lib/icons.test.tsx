import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { GROUP_ICONS } from "./app-shell";
import { FLEX_GRID } from "./icon-flex";
import { GLYPHS, Icon } from "./icons";

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

/**
 * The grid the drawings are on, and the box they are framed in.
 *
 * `Icon` rendered `viewBox="0 0 24 24"` and this file's header said the
 * artwork was 24x24. It is 14x14 — streamline-flex's own grid, which the
 * generator read from the API and threw away. So every icon in the product
 * was drawn at 58% of its size, anchored to the top-left of its own box,
 * with the rest of the box belonging to nothing.
 *
 * On a label that reads as a slightly small picture and you look past it. On
 * the navigation rail, where the icon is the only thing naming a section, it
 * put four drawings at four apparent sizes — which is what it took for
 * somebody to say the icons were off.
 *
 * Nothing threw and no test could see it: every check here read the markup,
 * and the markup was fine. What was wrong was the frame around it. So the
 * grid is recorded by the generator now, and this holds the two things that
 * can still drift apart.
 */
test("the frame is the grid the artwork says it is on", () => {
  expect(FLEX_GRID).toBe(14);
  const drawn = renderToStaticMarkup(<Icon name="wallet" />);
  expect(drawn).toContain(`viewBox="0 0 ${FLEX_GRID} ${FLEX_GRID}"`);
});

/**
 * And our own marks are on that same grid. They were drawn for 24, which is
 * the other half of the same mistake: one coordinate system, or a plus sign
 * lands off the edge of the box the pictures sit in.
 */
test("the marks we drew ourselves are on the set's grid", () => {
  for (const name of ["plus", "close", "tick", "panel", "more-horizontal"]) {
    const body = GLYPHS[name] ?? "";
    // Every coordinate our own markup carries, which — unlike the set's
    // compressed path data — is written out plainly enough to read back.
    const coords = [...body.matchAll(/(?:^|[ ,ML])(-?\d+(?:\.\d+)?)/g)].map(
      (m) => Number(m[1]),
    );
    const reach = Math.max(...coords.map(Math.abs), 0);
    expect([name, reach <= FLEX_GRID]).toEqual([name, true]);
  }
});
