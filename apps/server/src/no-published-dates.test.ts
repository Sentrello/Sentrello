import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Nothing public promises a date except the launch.
 *
 * The README listed HR and Helpdesk as "Q1 2027" while neither had a line of
 * code, and the POS documentation planned table service "through 2027". Both
 * were written in good faith and neither was anything but a guess with a
 * quarter attached — and the README is the document the rest of the estate is
 * said to be traceable to, so a guess here is repeated everywhere downstream.
 *
 * The rule is the one the marketing site already follows: name the thing, say
 * it is being built, publish no date. One date exists — v1 on 1 October 2026 —
 * and it is the only future year these files may name.
 *
 * Deliberately narrow. Past dates are facts and are allowed: a withdrawal on
 * 15 September 2026, a regime in force since 2021, a retention period in
 * years. What is refused is a quarter of a year, and a year after the launch
 * year, which is the shape every promise we could not keep has taken.
 */
const ROOT = join(import.meta.dir, "../../..");
const LAUNCH_YEAR = 2026;

/** `Q1 2027`, `Q4 2026` — a quarter is a promise however it is dressed. */
const QUARTER = /\bQ[1-4]\s+20\d\d\b/g;
/** Any year after the launch year, in prose or in a date. */
const FUTURE_YEAR = /\b20\d\d\b/g;

function publicMarkdown(): string[] {
  const site = join(ROOT, "docs/site");
  const pages = readdirSync(site, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => relative(ROOT, join(e.parentPath, e.name)));
  return ["README.md", ...pages];
}

test("no public page publishes a quarter or a year beyond launch", () => {
  const offences: string[] = [];
  for (const page of publicMarkdown()) {
    const text = readFileSync(join(ROOT, page), "utf8");
    for (const [line, n] of text
      .split("\n")
      .map((l, i) => [l, i + 1] as const)) {
      for (const hit of line.match(QUARTER) ?? []) {
        offences.push(`${page}:${n}: ${hit}`);
      }
      for (const hit of line.match(FUTURE_YEAR) ?? []) {
        if (Number(hit) > LAUNCH_YEAR) offences.push(`${page}:${n}: ${hit}`);
      }
    }
  }
  expect(
    offences,
    "a public page names a date we have no basis for — say it is being built instead",
  ).toEqual([]);
});
