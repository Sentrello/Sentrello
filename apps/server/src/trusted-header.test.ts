import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sourceFiles } from "@sentrello/module-sdk";
import { findRawTrustedHeader } from "@sentrello/module-sdk/trusted-header";

/**
 * Nobody reads the caller's address out of a header by hand.
 *
 * `x-real-ip` is written by our own nginx from `$remote_addr`, so behind the
 * documented deployment a caller cannot forge it. Behind anything else — Caddy,
 * Traefik, a load balancer with its own header, an instance reached directly — the
 * caller sets it, and a fresh value per request is a fresh rate-limit budget per
 * request. `SENTRELLO_TRUSTED_PROXIES` exists for that case and only
 * `callerAddress` honours it.
 *
 * Twelve places read the header raw instead, and two of them were the shared
 * helpers themselves: `callerKey` in the SDK and `clientAddress` in
 * `@sentrello/auth`. That is why setting the variable applied it to sign-in
 * attempts and to nothing else — every public rate limit in every module, the
 * CRM's forms and inbound mail, invoicing's share links and logo endpoint, the
 * newsletter's six doors, the buy page and the welcome flow all asked the header
 * directly. One answer now, and this is what stops a thirteenth copy.
 */
const ROOT = join(import.meta.dir, "..", "..", "..");

const TREES = [
  join(ROOT, "apps", "server", "src"),
  join(ROOT, "apps", "web", "src"),
  join(ROOT, "packages"),
];

test("there is a tree to read", () => {
  // A scan over nothing passes the assertion below it, which is how this whole
  // family of checks goes quietly green.
  const files = TREES.flatMap((tree) => sourceFiles(tree, [".ts", ".tsx"]));
  expect(files.length).toBeGreaterThan(200);
});

test("nobody reads the caller's address out of a header by hand", () => {
  const raw: string[] = [];
  for (const tree of TREES) {
    for (const path of sourceFiles(tree, [".ts", ".tsx"])) {
      // The scanner's own definition names the headers it looks for.
      if (path.endsWith("module-sdk/src/trusted-header.ts")) continue;
      for (const found of findRawTrustedHeader(readFileSync(path, "utf8"))) {
        raw.push(`${path.slice(ROOT.length + 1)}:${found.line}: ${found.say}`);
      }
    }
  }
  expect(raw, `\n    ${raw.join("\n    ")}`).toEqual([]);
});
