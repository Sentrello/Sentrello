import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A design token reached the wrong way compiles to nothing, and says nothing.
 *
 * Tailwind v4 dropped the bare `[--var]` shorthand. `gap-[--gap-stack]` is
 * still a valid *class name*, so nothing errors — it compiles to
 * `gap:--gap-stack`, which is not a CSS value, so the rule is dropped and the
 * gap is simply absent. The build is green, the test suite is green, and the
 * screen has no spacing on it.
 *
 * Found on 25 September, an hour after the tokens landed, by reading the
 * generated stylesheet rather than trusting the class name. Three files in
 * core had it and four agents were writing more of it at the time.
 *
 * The correct form is parentheses: `gap-(--gap-stack)`.
 */
const WRONG = /-\[--[a-z-]+\]/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

test("no file reaches a token with square brackets", () => {
  const root = join(import.meta.dir, "../../../..");
  const offenders: string[] = [];
  for (const file of [
    ...walk(join(root, "apps")),
    ...walk(join(root, "packages")),
  ]) {
    if (file.endsWith("token-syntax.test.ts")) continue;
    const source = readFileSync(file, "utf8");
    for (const hit of source.match(WRONG) ?? []) {
      offenders.push(`${file.slice(root.length + 1)}: ${hit}`);
    }
  }
  expect(offenders).toEqual([]);
});
