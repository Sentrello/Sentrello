/**
 * The platform's own icons.
 *
 * Two files stand behind this one. `icon-shapes.ts` holds the geometry, drawn
 * clean on a 24-unit grid — that is the file to edit. `icon-paths.ts` is what
 * this renders: the same set with every line put through one wobble, so they
 * look drawn by hand and, more to the point, drawn by the *same* hand.
 * `scripts/draw-icons.mjs` turns the first into the second.
 *
 * Set by James on 21 September 2026, against a folder of samples: the icons
 * should look drawn rather than drafted.
 */
import { DRAWN_GLYPHS } from "./icon-paths";
import type { Glyph } from "./icon-shapes";

export type { Glyph };

/** What the application draws. The geometry behind it is in `icon-shapes.ts`. */
export const GLYPHS = DRAWN_GLYPHS;

/**
 * Names a module may ask for that mean the same thing as a drawn one.
 *
 * A module in another repository was built against whatever name it was
 * built against, and a picture is not worth breaking somebody's nav over.
 * Kept small and deliberate rather than growing into a synonym dictionary:
 * each line is a name that shipped before this set existed.
 */
const ALIASES: Record<string, string> = {
  shop: "shopping-cart",
  contacts: "contact-round",
  "calendar-days": "calendar",
  "id-card": "id-badge",
  icon: "layout",
  "check-circle": "check-square",
};

export type IconName = keyof typeof GLYPHS;

/**
 * An unknown name draws the fallback rather than throwing.
 *
 * A module built against a later host will ask for icons this one has never
 * heard of, and a missing picture must never be why a sidebar fails to
 * render. It is deliberately a plain grid: it should look like a thing
 * nobody drew, so it is noticed and fixed, not mistaken for a decision.
 */
export function Icon({
  name,
  size = 18,
}: {
  name: IconName | (string & {});
  size?: number;
}) {
  const fallback: Glyph = { d: ["M4.5 4.5h15v15h-15z"] };
  const glyph =
    GLYPHS[name] ?? GLYPHS[ALIASES[name] ?? ""] ?? GLYPHS.layout ?? fallback;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <title>{name}</title>
      {glyph.d.map((d) => (
        <path key={d} d={d} />
      ))}
      {glyph.faint?.map((d) => (
        <path key={d} d={d} opacity={0.5} />
      ))}
      {glyph.dots?.map(([cx, cy, r]) => (
        <circle
          key={`${cx}-${cy}`}
          cx={cx}
          cy={cy}
          r={r}
          fill="currentColor"
          stroke="none"
        />
      ))}
    </svg>
  );
}
