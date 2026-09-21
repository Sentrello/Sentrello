import { expect, test } from "bun:test";
import { DRAWN_GLYPHS } from "./icon-paths";
import { GLYPHS as SHAPES } from "./icon-shapes";

/**
 * The drawn set is what the application renders, and it is generated.
 *
 * `scripts/draw-icons.mjs` turns `icon-shapes.ts` into `icon-paths.ts`. Both
 * are committed, which means they can fall out of step: somebody draws a new
 * icon, does not run the script, and the application goes on drawing the old
 * set — or drawing nothing, because the name it was given is only in the file
 * nobody renders. Neither errors, and neither shows up in a review of the
 * diff, which is the whole family of bug this project keeps finding.
 */
test("every shape has been drawn, and nothing has been drawn twice", () => {
  const shaped = Object.keys(SHAPES).sort();
  const drawn = Object.keys(DRAWN_GLYPHS).sort();
  expect(drawn).toEqual(shaped);
});

test("each drawn glyph has the same number of strokes as its shape", () => {
  const off: string[] = [];
  for (const [name, shape] of Object.entries(SHAPES)) {
    const drawn = DRAWN_GLYPHS[name];
    if (!drawn) continue;
    if (
      drawn.d.length !== shape.d.length ||
      (drawn.faint?.length ?? 0) !== (shape.faint?.length ?? 0) ||
      (drawn.dots?.length ?? 0) !== (shape.dots?.length ?? 0)
    ) {
      off.push(name);
    }
  }
  expect(off).toEqual([]);
});

/**
 * A path that wandered outside the box crops against the viewport, and the
 * first place anybody sees it is a sidebar. The hand is allowed to run past
 * the drawing's own 3–21 guide; it is not allowed to leave 24.
 */
test("nothing drawn falls outside the grid", () => {
  const outside: string[] = [];
  for (const [name, glyph] of Object.entries(DRAWN_GLYPHS)) {
    for (const d of [...glyph.d, ...(glyph.faint ?? [])]) {
      for (const [, n] of d.matchAll(/(-?\d+\.?\d*)/g)) {
        const v = Number(n);
        if (v < -0.6 || v > 24.6) outside.push(`${name}: ${v}`);
      }
    }
  }
  expect(outside).toEqual([]);
});
