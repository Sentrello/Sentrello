import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * This repository is public, and some names are not.
 *
 * Three kinds of thing leaked into it, all in comments and test fixtures
 * written by somebody explaining a real case:
 *
 *   - the marketing site's repository, named in three legal files;
 *   - `bmp.sentrello.com`, the instance that mints every customer's licence,
 *     in five comments and a test fixture;
 *   - the demo's own domain as a worked example in the cookie-scope rules,
 *     twenty-four times, and the web host's real IP address as the vendor
 *     address in an HMRC fraud-header fixture.
 *
 * None of it was carelessness. Each one was somebody making a comment concrete
 * by naming the machine it actually happened on, which is normally the right
 * instinct and is exactly wrong here: a public repository is the one place
 * where "the instance we saw this on" has to stay anonymous. Naming the
 * control plane points at the one host worth attacking, from a page anybody
 * can read.
 *
 * `get.sentrello.com` is deliberately allowed. It is the address inside every
 * customer's install command and appears in the README on purpose — product
 * surface, not infrastructure.
 *
 * A comment can be concrete without being identifying: "our own instance",
 * "a real instance", `example.com`, and the documentation address ranges.
 */
const FORBIDDEN: { pattern: RegExp; instead: string }[] = [
  {
    pattern: /websentrello/i,
    instead: "the marketing site's own source — it is a private repository",
  },
  {
    pattern: /\bbmp(\.sentrello\.com)?\b/i,
    instead: '"our own instance" or "the control plane"',
  },
  {
    pattern: /barkerpawski/i,
    instead: "example.com, or another domain nobody owns",
  },
  {
    // The web host, the installer host and the private VPC range.
    pattern: /\b(143\.244\.185\.\d+|209\.38\.158\.\d+|10\.124\.0\.\d+)\b/,
    instead: "203.0.113.0/24, which exists for documentation",
  },
];

const SKIP = new Set(["node_modules", "dist", ".git", "build", "coverage"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|md|mjs|json|css|ya?ml)$/.test(entry)) out.push(path);
  }
  return out;
}

test("nothing in the public repository names a host or a private repository", () => {
  const root = join(import.meta.dir, "../../..");
  const found: string[] = [];
  for (const file of walk(root)) {
    // This file has to hold the words it forbids.
    if (file.endsWith("no-private-names.test.ts")) continue;
    // A lockfile is a hash soup and matches things by accident.
    if (file.endsWith("bun.lock")) continue;
    const source = readFileSync(file, "utf8");
    for (const { pattern, instead } of FORBIDDEN) {
      const hit = source.match(pattern);
      if (!hit) continue;
      const line = source.slice(0, source.indexOf(hit[0])).split("\n").length;
      found.push(
        `${file.slice(root.length + 1)}:${line}: "${hit[0]}" — say ${instead}`,
      );
    }
  }
  expect(found).toEqual([]);
});
