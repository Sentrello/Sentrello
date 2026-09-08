import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sourceFiles, unregisteredRequests } from "@sentrello/module-sdk";

/**
 * Every request a screen makes reaches a route that exists.
 *
 * The opposite question to `module-reachable.test.ts`, and it catches what
 * that one cannot: not a feature nobody can get to, but a **button that
 * answers 404**. Two were found the day this was written, both in Shop and
 * both there since their screens were — the settings save sent PATCH to a
 * route registered only as PUT, and Remove on every discount sent a DELETE
 * that had never existed. Each had tests on the route and tests on the screen,
 * and each test used the verb its own side already used.
 *
 * Core's screens call Core's routes *and* the commercial ones: `pro-core` adds
 * a Pro field to the invoice page rather than a page of its own. So the answer
 * depends on repositories that may not be on this machine, and the check is
 * skipped rather than run half-blind — a guard that reports a live button as
 * broken is one somebody switches off.
 */
const root = join(import.meta.dir, "../../..");
const siblings = ["Pro", "Modules"].map((name) =>
  join(root, "..", name, "packages"),
);

const routeDirs = [
  join(root, "apps/server/src"),
  // Sign-up, bootstrap and the invite flow are ours; Better Auth's own tree is
  // mounted whole and registers nothing readable, which is why it is excused
  // below rather than scanned.
  join(root, "packages/auth/src"),
  ...readdirSync(join(root, "packages/modules-free"))
    .map((m) => join(root, "packages/modules-free", m, "src"))
    .filter(existsSync),
];

for (const base of siblings) {
  if (!existsSync(base)) continue;
  for (const m of readdirSync(base)) {
    const dir = join(base, m, "src");
    if (existsSync(dir)) routeDirs.push(dir);
  }
}

/** Requests answered by something other than a module of ours. */
const ANSWERED_ELSEWHERE: Record<string, string> = {
  // Better Auth mounts its own router; nothing here registers these paths.
  "api/auth/*": "Better Auth's own tree",
  "api/_meta": "the host itself, not a module",
};

test("no screen asks for a route nobody registered", () => {
  // Without the commercial repositories beside us, Pro's routes are missing
  // and every Pro field on a Core screen would look broken.
  if (!siblings.every(existsSync)) return;

  const screenFiles = sourceFiles(join(root, "apps/web/src"), [".ts", ".tsx"]);
  const routeFiles = routeDirs.flatMap((d) => sourceFiles(d, [".ts"]));

  // A sweep that found no routes would pass this without checking anything.
  expect(routeFiles.length).toBeGreaterThan(50);
  expect(screenFiles.length).toBeGreaterThan(20);

  expect(
    unregisteredRequests({
      routeFiles,
      screenFiles,
      answeredElsewhere: ANSWERED_ELSEWHERE,
    }),
  ).toEqual([]);
});
