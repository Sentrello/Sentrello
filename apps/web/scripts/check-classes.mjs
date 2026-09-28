/**
 * Every class a screen asks for, against the stylesheet actually built.
 *
 * A Tailwind class that does not exist is a valid class *name*. Nothing
 * errors: the compiler emits no rule, the element gets no style, and the
 * screen is wrong only on a monitor. Three of these shipped in one day.
 *
 *   `gap-[--gap-stack]`      v4 dropped the bare shorthand; it compiled to
 *                            `gap:--gap-stack`, an invalid value, and the gap
 *                            was simply absent.
 *   `border-line`            a name Core declared and a module's build had
 *                            never heard of, so an uncoloured border fell back
 *                            to `currentColor` — a white box on the dark theme.
 *   `text-muted-foreground`  a shadcn name declared nowhere in this product at
 *                            all. The VIES verdict on a company rendered at
 *                            full body strength instead of muted.
 *
 * None of the three was caught by typecheck, lint, or any test, because a
 * string is a string. They are caught by asking the built CSS whether the
 * class is in it, which is the only question that actually decides.
 *
 * Only `className="…"` literals are read, and only outside comments. A class
 * assembled at runtime cannot be checked from source, and guessing at template
 * literals would report things that are fine — a guard nobody trusts is a
 * guard nobody keeps. The same goes for prose: this fired on a doc comment
 * describing the markup it was replacing, and a guard that punishes
 * documentation is one people route around by writing less of it.
 *
 *   bun run --cwd apps/web build && node apps/web/scripts/check-classes.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const here = join(import.meta.dirname, "..");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(path) && !path.includes(".test.")) out.push(path);
  }
  return out;
}

const assets = join(here, "dist", "assets");
let css;
try {
  css = readdirSync(assets)
    .filter((f) => f.endsWith(".css"))
    .map((f) => readFileSync(join(assets, f), "utf8"))
    .join("\n");
} catch {
  console.error(
    "check-classes: no built stylesheet — run `bun run --cwd apps/web build` first",
  );
  process.exit(1);
}

/**
 * Comments out, newlines kept.
 *
 * Replacing a block comment with the same number of lines means a finding
 * still names the line the class is really on. `//` is only stripped when it
 * does not follow a colon, so `https://…` inside a string survives.
 */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const asked = new Map();
for (const file of walk(join(here, "src"))) {
  const source = withoutComments(readFileSync(file, "utf8"));
  for (const match of source.matchAll(/className="([^"]*)"/g)) {
    for (const name of match[1].split(/\s+/)) {
      if (name && !asked.has(name))
        asked.set(name, file.slice(here.length + 1));
    }
  }
}

/** The selector Tailwind writes: every character outside [A-Za-z0-9_-] escaped. */
const selector = (name) =>
  `.${name.replace(/[^A-Za-z0-9_-]/g, (ch) => `\\${ch}`)}`;

const missing = [...asked].filter(([name]) => !css.includes(selector(name)));

if (missing.length) {
  console.error("check-classes FAILED — these classes emit no rule:");
  for (const [name, file] of missing.sort()) {
    console.error(`  ${name}  (${file})`);
  }
  process.exit(1);
}

console.log(
  `check-classes passed — all ${asked.size} classes resolve in the built stylesheet.`,
);
