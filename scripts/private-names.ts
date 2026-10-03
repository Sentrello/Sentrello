import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The names this public repository does not carry, in one place.
 *
 * Two readers, two scopes, one list — because the question "what may be named"
 * has to have a single answer. `apps/server/src/no-private-names.test.ts`
 * checks the repository's *files*; `scripts/public-commit-names.ts` checks the
 * *messages* of the commits being pushed. Before this module they were one
 * list and none: the file check existed, and nothing had ever read a commit
 * message, which is how ten commits naming the marketing site reached a public
 * history and one of them reached a published release note.
 *
 * `get.sentrello.com` is deliberately absent from both. It is the address
 * inside every customer's install command and belongs in a README and in a
 * release note — product surface, not infrastructure.
 */

export interface ForbiddenName {
  pattern: RegExp;
  instead: string;
}

/**
 * In the repository's files.
 *
 * Three kinds of thing leaked in, all in comments and fixtures written by
 * somebody making a point concrete by naming the machine it happened on —
 * normally the right instinct and exactly wrong here. A public repository is
 * the one place where "the instance we saw this on" has to stay anonymous.
 */
export const FORBIDDEN_IN_SOURCE: ForbiddenName[] = [
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

/**
 * In the messages of commits being pushed. Everything above, and the site.
 *
 * **A commit message in this repository describes the platform.** Not the
 * marketing site, not our own instance, not the demo, not a host that runs any
 * of it. Those are real work and they belong in the repository where they were
 * done — three of the four are private, and that is the point.
 *
 * It is not a tidiness rule. Commit subjects from this repository are pasted
 * verbatim into the release notes on a page anybody can read, by a generator,
 * from a subject somebody wrote a week earlier and nobody re-reads. "one
 * sentence rewritten on the site" went out that way with 1.1.0.
 *
 * **Why the site is only checked in messages and not in files.** `websentrello`
 * — the private repository's name — is forbidden in both and always was. The
 * phrase "the marketing site" appears forty-four times in this repository's
 * source, much of it legitimate: a design comment pointing at where an idiom
 * came from, and this module's own documentation. A file rule would be a
 * forty-four-line argument with itself. A message rule has none: the same
 * pattern over the whole of this repository's history flags ten commits and
 * every one of them is a genuine mention.
 *
 * `the site` rather than `site`, so "one call site", "the copy site" and "a
 * call site now" — all of which are in real subjects here — pass untouched.
 */
export const FORBIDDEN_IN_MESSAGES: ForbiddenName[] = [
  ...FORBIDDEN_IN_SOURCE,
  {
    pattern: /\b(the site|marketing site|stage\.sentrello)\b/i,
    instead:
      "nothing — a commit here is about the platform. Put it in the site's own repository",
  },
  {
    // A page on the marketing site, named from here.
    pattern: /sentrello\.com\/(blog|docs|modules|pricing)\b/i,
    instead: "nothing — link it from the site, not from this repository",
  },
];

/**
 * The file scan, as a script.
 *
 * It lived in `apps/server/src/no-private-names.test.ts` and walked the tree
 * there. Importing the list from this module broke `tsc -b`: the server
 * project's `rootDir` is its own `src`, so a repository-root module is not a
 * file it is allowed to compile. Two guards already answer that the same way —
 * `sbom.test.ts` and `public-commit-names.test.ts` both spawn the script they
 * are testing — so the scan comes here and the test spawns it.
 *
 * Exemptions are named, not matched. Each of these has to hold the words it
 * forbids: this module, the file test, and the message guard's test, whose
 * fixtures are the names themselves — a fixture reading "a private host" would
 * prove nothing. A fourth file claiming the exemption has to be added here
 * deliberately.
 */
const EXEMPT = [
  "scripts/private-names.ts",
  "no-private-names.test.ts",
  "public-commit-names.test.ts",
  // A lockfile is a hash soup and matches things by accident.
  "bun.lock",
];

const SKIP = new Set(["node_modules", "dist", ".git", "build", "coverage"]);

export function namesInFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx|md|mjs|json|css|ya?ml)$/.test(entry)) continue;
      if (EXEMPT.some((name) => path.endsWith(name))) continue;
      const source: string = readFileSync(path, "utf8");
      for (const { pattern, instead } of FORBIDDEN_IN_SOURCE) {
        const hit = source.match(pattern);
        if (!hit) continue;
        const line = source.slice(0, source.indexOf(hit[0])).split("\n").length;
        found.push(
          `${path.slice(root.length + 1)}:${line}: "${hit[0]}" — say ${instead}`,
        );
      }
    }
  };
  walk(root);
  return found;
}

if (import.meta.main) {
  const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  const found = namesInFiles(root);
  for (const line of found) console.log(line);
  process.exit(found.length === 0 ? 0 : 1);
}
