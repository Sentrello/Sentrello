/**
 * Give every icon the same drawn-by-hand line.
 *
 * Set by James on 21 September 2026, against a folder of samples: the icons
 * are to look drawn rather than drafted, and — this is the part that matters
 * — they are all to look drawn *the same way*. Wobbling each path by hand
 * would give fifty-eight different hands.
 *
 * So the geometry is authored clean in `icon-shapes.ts` and put through one
 * pass here. What the application renders is `icon-paths.ts`, which this
 * writes. Both are committed: a checkout must draw icons without running a
 * browser, and a reviewer should be able to read the shape that was meant.
 *
 *   bunx playwright install chromium   # once, for the browser itself
 *   node apps/web/scripts/draw-icons.mjs
 *
 * **It never reads its own output.** Roughening a rough line compounds — two
 * runs and a document looks like a crumpled bag — which is the whole reason
 * the clean shapes live in a separate file.
 *
 * The measuring is done by a real browser rather than by a path parser
 * written here. The set uses arcs, relative commands and shorthand curves,
 * and a parser for those is a second implementation of SVG to get subtly
 * wrong; `getPointAtLength` is the one that is already correct.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Either package will do — the script needs one browser and one method on it.
 * `@playwright/test` is what this repository already has; `playwright` is what
 * a machine that installed it for something else will have.
 */
const { chromium } = await import("playwright").catch(
  () => import("@playwright/test"),
);

const here = dirname(fileURLToPath(import.meta.url));
const shapesFile = join(here, "../src/lib/icon-shapes.ts");
const outFile = join(here, "../src/lib/icon-paths.ts");

/** How hard the hand shakes. Tuned by looking at the set at 18 and 40 pixels. */
const HAND = {
  /** Sideways wander, in grid units. Past ~0.45 a gear stops meshing. */
  amp: 0.42,
  /** How far along the line one wobble runs. Short is jitter, long is a bend. */
  wave: 7,
  /** Sampling step. Finer than the wobble, coarser than a pixel. */
  step: 1.6,
  /** How far a stroke runs past its end, as a pen does. Closed shapes: none. */
  overshoot: 0.55,
};

const source = readFileSync(shapesFile, "utf8");

/*
 * Every path literal in the file, in order.
 *
 * Deliberately not a TypeScript parse: the file is a flat object of string
 * arrays, and the strings that are paths are the ones that start with a
 * command letter. `dots` are numbers and are left alone — a circle is round
 * whoever draws it, and wobbling a 1.2-unit dot makes a blot.
 */
const PATH_LITERAL = /"([MmLlHhVvCcSsQqAaZz][^"]*)"/g;
const literals = [...source.matchAll(PATH_LITERAL)].map((m) => m[1]);
if (literals.length < 100) {
  throw new Error(
    `only ${literals.length} paths found in icon-shapes.ts — the file's shape has changed and this script would write a set with holes in it`,
  );
}

const browser = await chromium.launch();
const page = await browser.newPage();
const drawn = await page.evaluate(
  ({ literals, HAND }) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    document.body.appendChild(svg);
    const el = document.createElementNS("http://www.w3.org/2000/svg", "path");
    svg.appendChild(el);

    /** Catmull-Rom through the wobbled points: a drawn line, not a polygon. */
    const smooth = (pts) => {
      let d = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i - 1] ?? pts[i];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const p3 = pts[i + 2] ?? p2;
        const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
        const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
        d += `C${c1[0].toFixed(2)} ${c1[1].toFixed(2)} ${c2[0].toFixed(2)} ${c2[1].toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
      }
      return d;
    };

    return literals.map((d) => {
      el.setAttribute("d", d);
      const len = el.getTotalLength();
      // Nothing to wander along: a zero-length path is a dot somebody drew
      // with a path, and it survives untouched.
      if (len < 0.5) return d;

      /*
       * Seeded by the path itself, so the same shape is always drawn the same
       * way. A random seed would mean every run produced a different set and
       * every commit a diff nobody could review.
       */
      let s = 17;
      for (const c of d) s = (s * 31 + c.charCodeAt(0)) >>> 0;
      const rand = () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
      };

      // Three waves at different lengths. One wave that repeats is a spring.
      const phase = [rand() * 6.283, rand() * 6.283, rand() * 6.283];
      const closed = /z\s*$/i.test(d.trim());
      const ends = closed ? 0 : HAND.overshoot * (0.4 + rand() * 0.6);
      const pts = [];
      for (let t = -ends; t <= len + ends; t += HAND.step) {
        const at = Math.min(Math.max(t, 0), len);
        const p = el.getPointAtLength(at);
        const q = el.getPointAtLength(Math.min(len, at + 0.6));
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const m = Math.hypot(dx, dy) || 1;
        const wobble =
          Math.sin((t / HAND.wave) * 6.283 + phase[0]) * 0.6 +
          Math.sin((t / (HAND.wave * 2.3)) * 6.283 + phase[1]) * 0.3 +
          Math.sin((t / (HAND.wave * 0.55)) * 6.283 + phase[2]) * 0.12;
        // Past either end the pen keeps going in the direction it was headed.
        const beyond = t < 0 ? -t : t > len ? t - len : 0;
        const along = t < 0 ? -beyond : beyond;
        pts.push([
          p.x + (-dy / m) * wobble * HAND.amp + (dx / m) * along,
          p.y + (dx / m) * wobble * HAND.amp + (dy / m) * along,
        ]);
      }
      if (pts.length < 2) return d;
      return smooth(pts) + (closed ? "Z" : "");
    });
  },
  { literals, HAND },
);
await browser.close();

/*
 * The generated file is the shapes file with each path swapped for its drawn
 * one, in order — so the comments, the grouping and the glyph names all come
 * through, and a diff shows a line moving rather than a file rewritten.
 */
let i = 0;
const body = source.replace(PATH_LITERAL, () => `"${drawn[i++]}"`);
if (i !== literals.length) {
  throw new Error(`replaced ${i} paths of ${literals.length}`);
}

/* The type lives with the shapes; the generated file imports it. */
const withoutInterface = body
  .replace(/export interface Glyph \{[\s\S]*?\n\}\n\n/, "")
  // The shapes file explains that it is the source and this is generated from
  // it. Carried into the generated file that paragraph says the opposite of
  // the truth, so it goes.
  .replace(
    /\n \* \*\*This file is the drawing[\s\S]*?two files exist: this one never changes under the script\.\n/,
    "\n",
  );

writeFileSync(
  outFile,
  withoutInterface
    .replace(
      "/**\n * The platform's own icons, drawn clean.",
      "/**\n * The platform's own icons, as drawn. **Generated — do not edit.**\n *\n * `apps/web/scripts/draw-icons.mjs` writes this from `icon-shapes.ts`,\n * which is where the geometry is authored. Editing a path here is work the\n * next run throws away.\n *\n * The original header follows, because everything it says about the grid\n * still holds. What changed is that every line now wanders the way a hand\n * does.",
    )
    .replace(
      "export const GLYPHS: Record<string, Glyph> =",
      'import type { Glyph } from "./icon-shapes";\n\nexport const DRAWN_GLYPHS: Record<string, Glyph> =',
    ),
);
/*
 * Formatted here rather than left for the next person's `lint` to complain
 * about. A generator whose output fails the gate is a generator nobody runs.
 */
try {
  execFileSync("bunx", ["biome", "check", "--write", outFile], {
    cwd: join(here, "../../.."),
    stdio: "ignore",
  });
} catch {
  console.warn("biome could not format the output; run the linter yourself");
}

console.log(`drew ${literals.length} paths into ${outFile}`);
