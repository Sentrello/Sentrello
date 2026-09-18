import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every colour pairing the app actually puts on screen, measured against
 * WCAG 2.1 AA — 4.5:1 for text, 3:1 for meaningful non-text — in both themes.
 *
 * This exists because the dark theme shipped with the status colours failing
 * on every screen that showed one: the same token was doing two jobs, fill
 * and text, and a value dark enough to read *on* light paper cannot also be
 * read *as* text on a near-black ground. The split is `--color-*` for fills
 * and `--text-*` for text; this test is what keeps the values on the right
 * side of the line when someone tunes a colour by eye.
 *
 * The numbers are computed, not asserted from memory: oklch through OKLab to
 * linear sRGB, then WCAG relative luminance. If a token here fails to parse,
 * that is a failure too — an unparsed colour is an unmeasured one.
 */

const css = readFileSync(join(import.meta.dir, "..", "index.css"), "utf8");

// ---- colour math: oklch -> linear sRGB -> WCAG relative luminance ----

function luminance(spec: string): number {
  if (spec === "white") return 1;
  const m = spec.match(/^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/);
  if (!m) throw new Error(`not a colour this test can measure: "${spec}"`);
  const [l, c, hDeg] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const L = l_ ** 3;
  const M = m_ ** 3;
  const S = s_ ** 3;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const r = clamp(4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S);
  const g = clamp(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S);
  const bl = clamp(-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S);
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}

function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// ---- reading the stylesheet the way the browser will ----

function stripCssComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** The declarations of the first block whose header matches. */
function block(header: RegExp): Record<string, string> {
  const clean = stripCssComments(css);
  const match = clean.match(new RegExp(`${header.source}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`no block matching ${header} in index.css`);
  const out: Record<string, string> = {};
  for (const decl of (match[1] ?? "").split(";")) {
    const [name, ...rest] = decl.split(":");
    if (name === undefined || rest.length === 0) continue;
    /*
     * Whitespace collapsed, because the formatter wraps a long value and
     * wraps it to a different column in the media query than in the
     * attribute block — which read as two themes disagreeing when the only
     * difference was an indent.
     */
    out[name.trim()] = rest.join(":").trim().replace(/\s+/g, " ");
  }
  return out;
}

const invariant = block(/@theme/);
const light = block(/:root(?!\[)/);
const lightExplicit = block(/:root\[data-theme="light"\]/);
const darkExplicit = block(/:root\[data-theme="dark"\]/);
const darkSystem = block(/@media \(prefers-color-scheme: dark\) \{\s*:root/);

/** `var(--x)` chased down to a literal colour, theme tokens first. */
function resolve(value: string, theme: Record<string, string>): string {
  const name = value.match(/^var\((--[a-z0-9-]+)\)$/)?.[1];
  if (name === undefined) return value;
  const next = theme[name] ?? invariant[name];
  if (next === undefined) throw new Error(`token ${name} is not defined`);
  return resolve(next, theme);
}

// ---- the pairings the app uses, and what each must measure ----

const TEXT = 4.5;
const GRAPHIC = 3;

/**
 * [foreground, background, threshold]. Foregrounds and backgrounds are token
 * names or literals; each is checked in both themes. Adding a colour to a
 * screen means adding its pairing here — that is the point.
 */
const PAIRINGS: [string, string, number][] = [
  // Body and muted text, on every surface text sits on.
  ["--text", "--surface", TEXT],
  ["--text", "--surface-raised", TEXT],
  ["--text", "--surface-sunken", TEXT],
  ["--text-muted", "--surface", TEXT],
  ["--text-muted", "--surface-raised", TEXT],
  ["--text-muted", "--surface-sunken", TEXT],
  /*
   * The overlay surface: the ground under a menu, a dropdown, a dialog, a
   * bottom sheet, the command palette. It exists because the dark theme lifts
   * a panel by making it lighter rather than by casting a shadow at it, which
   * means it is a *third* ground text sits on and has to be measured like the
   * other two.
   */
  ["--text", "--surface-overlay", TEXT],
  ["--text-muted", "--surface-overlay", TEXT],
  ["--link", "--surface-overlay", TEXT],
  ["--text-success", "--surface-overlay", TEXT],
  ["--text-warning", "--surface-overlay", TEXT],
  ["--text-danger", "--surface-overlay", TEXT],
  ["--text-info", "--surface-overlay", TEXT],
  ["--text-brand", "--surface-overlay", TEXT],
  // Links, both states.
  ["--link", "--surface", TEXT],
  ["--link", "--surface-raised", TEXT],
  ["--link-hover", "--surface", TEXT],
  ["--link-hover", "--surface-raised", TEXT],
  // Status words — "Paid", "Overdue", the figure that went the wrong way.
  ["--text-success", "--surface", TEXT],
  ["--text-success", "--surface-raised", TEXT],
  ["--text-warning", "--surface", TEXT],
  ["--text-warning", "--surface-raised", TEXT],
  ["--text-danger", "--surface", TEXT],
  ["--text-danger", "--surface-raised", TEXT],
  ["--text-info", "--surface", TEXT],
  ["--text-info", "--surface-raised", TEXT],
  // The brand where it is a word rather than a fill.
  ["--text-brand", "--surface", TEXT],
  ["--text-brand", "--surface-raised", TEXT],
  // Fixed text on fixed fills: the primary button, the danger button.
  ["--color-neutral-50", "--brand-on-white-text", TEXT],
  ["white", "--color-danger", TEXT],
  // Fills as graphics: chart bars and the selected chip's edge. Warning and
  // info are not here because nothing draws them as a fill — a status border
  // beside status text uses the text token, so the pair stays one colour.
  ["--color-success", "--surface", GRAPHIC],
  ["--color-success", "--surface-raised", GRAPHIC],
  ["--color-danger", "--surface", GRAPHIC],
  ["--color-danger", "--surface-raised", GRAPHIC],
  ["--color-brand-500", "--surface", GRAPHIC],
  ["--color-brand-500", "--surface-raised", GRAPHIC],
];

function failures(theme: Record<string, string>): string[] {
  const found: string[] = [];
  for (const [fg, bg, min] of PAIRINGS) {
    const ratio = contrast(
      resolve(theme[fg] ?? invariant[fg] ?? fg, theme),
      resolve(theme[bg] ?? invariant[bg] ?? bg, theme),
    );
    if (ratio < min) {
      found.push(`${fg} on ${bg}: ${ratio.toFixed(2)}:1, needs ${min}:1`);
    }
  }
  return found;
}

test("every pairing the light theme uses meets WCAG AA", () => {
  expect(failures(light)).toEqual([]);
});

test("every pairing the dark theme uses meets WCAG AA", () => {
  expect(failures(darkExplicit)).toEqual([]);
});

/**
 * Dark is written twice — once for the system preference, once for the
 * explicit choice — and the two must be the same theme. A value tuned in one
 * block and not the other is exactly the kind of drift nobody sees until a
 * visitor with the other setting does.
 */
test("the two dark blocks and the two light blocks agree", () => {
  expect(darkSystem).toEqual(darkExplicit);
  expect(lightExplicit).toEqual(light);
});

/**
 * The checker itself has to be able to fail, or a green run means nothing.
 * A fill dark enough for light paper, read as text on the dark ground, is
 * the exact mistake that shipped — the measurement must reject it.
 */
test("the measurement rejects a fill used as text on the dark ground", () => {
  const broken = { ...darkExplicit, "--text-danger": "var(--color-danger)" };
  expect(failures(broken)).not.toEqual([]);
});
