import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { findUntimedFetch } from "@sentrello/module-sdk";

/**
 * No server-side call that a request is waiting on may hang for ever.
 *
 * `fetch` has no timeout of its own. A call that is refused fails in
 * milliseconds; a call that is accepted and never answered waits until the
 * socket closes, which on a blackholing firewall is never — and the handler
 * holds its database connection the whole time. The pool is ten. Ten hung
 * requests and the instance answers nothing at all, on every screen of every
 * module, with Postgres perfectly healthy and nothing in any log.
 *
 * Found on 27 September 2026 after two licensed walks were cancelled at
 * their time limit: the SEO settings screen asks the control plane for a
 * balance on every load, on a runner that cannot always reach it. Twelve
 * other calls in this repository had the same shape — PayPal, Plaid, Teller,
 * the mail adapter, HMRC.
 *
 * A call that genuinely wants to wait says so on the line above with
 * `// outbound-ignore:` and a reason. The point is that it is a decision.
 */
const ROOTS = ["packages", "apps/server/src"];

/** The browser's own code, which aborts its own calls when a page goes. */
const NOT_THE_SERVER = /\/ui\/|apps\/web\//;

/**
 * And the script this server writes for somebody else's website.
 *
 * `forms-loader.ts` is a string of JavaScript served to a visitor's browser
 * — the calls in it are made from that page and hold nothing of ours. Named
 * rather than pattern-matched, because a second file like this should be a
 * decision somebody writes down rather than a wildcard that quietly covers
 * the next real one.
 */
const A_SCRIPT_FOR_A_BROWSER = new Set([
  "packages/modules-free/crm/src/forms-loader.ts",
]);

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith("."))
      continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      sources(path, out);
      continue;
    }
    if (!path.endsWith(".ts") && !path.endsWith(".tsx")) continue;
    if (path.includes(".test.")) continue;
    if (NOT_THE_SERVER.test(path)) continue;
    out.push(path);
  }
  return out;
}

test("every outbound call a request waits on has a deadline", () => {
  const root = join(import.meta.dir, "../../..");
  const found: string[] = [];
  for (const dir of ROOTS) {
    for (const file of sources(join(root, dir))) {
      const relative = file.slice(root.length + 1);
      if (A_SCRIPT_FOR_A_BROWSER.has(relative)) continue;
      for (const call of findUntimedFetch(readFileSync(file, "utf8"))) {
        found.push(`${relative}:${call.line}`);
      }
    }
  }
  expect(
    found,
    `these can wait for ever, and a request waiting on one holds a database connection while it does:\n    ${found.join("\n    ")}`,
  ).toEqual([]);
});
