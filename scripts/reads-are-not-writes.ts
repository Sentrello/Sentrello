/**
 * Every origin check says whether it is guarding a read or a write.
 *
 * `originAllowed(origin, list)` refuses a caller with no `Origin` header once
 * a list exists — right for a write, wrong for a read, and wrong four separate
 * times. A browser sends no `Origin` on a top-level navigation and none on a
 * same-origin GET: the header goes on cross-origin requests and on writes. So
 * every one of these answered 404 to the one site it had been told it serves:
 *
 *   - Booking's two public GETs, found 2026-09-29 when the demo's own reseed
 *     could not read its own services. `kind: "read"` was added for it.
 *   - The shop's storefront, found 2026-10-02 by the browser walk. Naming the
 *     website a business also sells from closed the pages the instance serves
 *     itself, in a browser.
 *   - The newsletter's embedded form, which could not read its own
 *     description on the site it was embedded in.
 *   - A CRM form's definition, the same.
 *
 * Nothing is protected by refusing those. They answer what a public page shows
 * anybody, and a script can send whatever `Origin` it likes. The list is what
 * makes a *write* with a page-source key worth something.
 *
 * **So every argument is required here, and that is the whole rule.** Not
 * "a GET passes read": the first version of this guard said that, and it
 * missed two of the four — the shop and Booking both ask through a helper that
 * is nowhere near the route, so there is no method to read. A default is what
 * made this invisible each time, and the fix is that nobody gets a default.
 *
 * Four arguments now, because the fourth went the same way as the third. The
 * rule has always said "an empty list means same-origin only", and with an
 * explicit same-origin header it refused for being exactly that — the shop
 * carried its own check outside the rule to compensate and three other public
 * surfaces carried none. The request's address is what makes that half of the
 * rule true, so it is passed rather than assumed: `c.req.url`.
 *
 * Shared by the four repositories and checked for drift, like the other
 * guards: the mistake is available in every one of them.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SKIP = new Set(["node_modules", "dist", ".git", "build", "coverage"]);

function sources(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (entry.endsWith(".ts") && !entry.includes(".test.")) out.push(path);
  }
  return out;
}

/**
 * How many arguments this call was given. `-1` when the call is not closed
 * within the window, which is long enough for any of these and short enough
 * not to run away.
 *
 * Arguments that hold something, not commas. Counting commas read a trailing
 * one as a third argument, so the first version of this guard passed the
 * OPTIONS handler it was looking straight at — this codebase's formatter puts
 * a trailing comma on every multi-line call, which is most of them.
 */
function argumentsGiven(source: string, open: number): number {
  let depth = 0;
  let given = 0;
  let filled = false;
  for (let i = open; i < Math.min(source.length, open + 600); i++) {
    const ch = source[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return given + (filled ? 1 : 0);
    } else if (ch === "," && depth === 1) {
      if (filled) given++;
      filled = false;
    } else if (depth >= 1 && ch && !/\s/.test(ch)) filled = true;
  }
  return -1;
}

/** Each `originAllowed(...)` that did not say which kind of call it guards. */
export function readsJudgedAsWrites(root: string): string[] {
  const found: string[] = [];
  for (const file of sources(root)) {
    // The definition itself, which is where the default lives — and this
    // file, which has to spell the call out to look for it.
    if (file.endsWith("public-endpoints.ts")) continue;
    if (file.endsWith("reads-are-not-writes.ts")) continue;
    const source = readFileSync(file, "utf8");
    const call = /\boriginAllowed\s*\(/g;
    let hit = call.exec(source);
    while (hit) {
      const open = hit.index + hit[0].length - 1;
      const given = argumentsGiven(source, open);
      if (given >= 0 && given < 4) {
        const line = source.slice(0, hit.index).split("\n").length;
        found.push(
          `${file.slice(root.length + 1)}:${line}: originAllowed with ${given} arguments — it takes four. Say "read" or "write", and pass c.req.url so "same-origin only" can be true. Both of those were defaults once, and each one hid the same bug in four places`,
        );
      }
      hit = call.exec(source);
    }
  }
  return found;
}

if (import.meta.main) {
  const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  const found = readsJudgedAsWrites(root);
  for (const line of found) console.log(line);
  process.exit(found.length === 0 ? 0 : 1);
}
