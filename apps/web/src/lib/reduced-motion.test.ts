import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Somebody who has told their machine they want less movement should get it
 * from every moving thing, not from the ones we remembered.
 *
 * Nothing in the product honoured `prefers-reduced-motion` until 26 September
 * 2026 — two CSS transitions and two chart bars all animated regardless. The
 * fix was four lines; the reason it took a browser to find is that motion is
 * invisible to a test that only reads the DOM, and the preference is
 * invisible to a developer whose machine has never been asked for it.
 *
 * So this reads the source instead. Two rules, one per way we can animate:
 *
 *  - a `transition` in `index.css` is only allowed on a selector the
 *    reduced-motion block turns off;
 *  - a Tailwind motion utility in a component has to carry `motion-reduce:`
 *    on the same element.
 *
 * The block must also stay last in the stylesheet. Declared beside the panel
 * it was undoing, it lost to the caret's own later rule at equal specificity
 * — green in the file, still animating in the browser.
 */

const webSrc = join(import.meta.dir, "..");
const css = readFileSync(join(webSrc, "index.css"), "utf8");

const REDUCE = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/;

function reduceBlock(): { whole: string; inside: string } {
  const m = css.match(REDUCE);
  if (!m?.[1]) throw new Error("index.css has no prefers-reduced-motion block");
  return { whole: m[0], inside: m[1] };
}

test("every transition in the stylesheet is turned off under reduce", () => {
  const block = reduceBlock();
  // The selector list above `transition: none`, one name per line.
  const exempted = new Set(
    [...block.inside.matchAll(/^\s*(\.[\w-]+)\s*[,{]/gm)].map((m) => m[1]),
  );

  // Every `transition:` outside the block, paired with the last class named
  // in the selector that introduced it.
  const before = css.slice(0, css.indexOf(block.whole));
  const moving: string[] = [];
  let selector = "";
  for (const line of before.split("\n")) {
    const named = line.match(/^([.[][^{]*?)\s*\{\s*$/);
    if (named?.[1]) selector = named[1].trim();
    if (/^\s*transition:/.test(line) && !/:\s*none/.test(line)) {
      const cls = selector.match(/\.[\w-]+/g)?.at(-1);
      if (cls && !exempted.has(cls))
        moving.push(`${selector} — ${line.trim()}`);
    }
  }
  expect(moving).toEqual([]);
});

test("the reduce block is the last thing in the stylesheet", () => {
  const { whole } = reduceBlock();
  expect(css.slice(css.indexOf(whole) + whole.length).trim()).toBe("");
});

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
      out.push(path);
  }
  return out;
}

test("every Tailwind motion utility carries motion-reduce", () => {
  const CLASSNAME = /className=(?:"([^"]*)"|\{`([^`]*)`\})/g;
  const MOTION =
    /\b(?:transition(?:-\[[^\]]*\]|-[a-z]+)?|animate-(?!none)[a-z-]+)\b/;
  const unguarded: string[] = [];
  for (const path of sources(webSrc)) {
    const text = readFileSync(path, "utf8");
    for (const [i, line] of text.split("\n").entries()) {
      for (const attr of line.matchAll(CLASSNAME)) {
        const classes = attr[1] ?? attr[2] ?? "";
        if (MOTION.test(classes) && !classes.includes("motion-reduce:")) {
          unguarded.push(`${path.slice(webSrc.length + 1)}:${i + 1}`);
        }
      }
    }
  }
  expect(unguarded).toEqual([]);
});
