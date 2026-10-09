import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { defaultStatements } from "better-auth/plugins/organization/access";
import { statement } from "./permissions";

/**
 * Every resource in the statement is one something checks.
 *
 * `hr`, `inventory`, `make-deal` and `time` sat in the statement for weeks
 * after their modules were withdrawn, guarded by nothing. Two of them were
 * offered as tick boxes on the access screen, where granting one did nothing,
 * and the compiled `admin` did not carry them, so a default policy that named
 * one was silently never seeded. A resource leaves the statement in the same
 * change its module does.
 *
 * The modules that guard most of these live in two private repositories, so
 * this reads them when they are cloned beside this one and skips, saying so,
 * when they are not. CI for this repository does not depend on them.
 */
const root = join(import.meta.dir, "../../..");
const siblings = [
  join(root, "../Pro/packages"),
  join(root, "../Modules/packages"),
];
const present = siblings.every(existsSync);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (["node_modules", "dist", "drizzle", ".git"].includes(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(name) && !name.includes(".test.")) out.push(path);
  }
  return out;
}

/*
 * The shapes a need is written in: at the route, through `mayAccess`, as a
 * nav entry's or widget's `requires`, and lifted into a constant first
 * (`const MANAGE = { crm: ["manage"] }`, then `requirePermission(MANAGE)`).
 */
const NEED =
  /(?:requirePermission\(|mayAccess\([^,()]+,|\brequires\s*:|\bneeds?\s*[:=]|const\s+[A-Z_][A-Z0-9_]*\s*=)\s*\{\s*"?([a-z][\w-]*)"?\s*:\s*\[/g;

test.skipIf(!present)(
  "the statement holds no resource that nothing checks",
  () => {
    const files = [
      ...sources(join(root, "packages")),
      ...sources(join(root, "apps")),
      ...siblings.flatMap((dir) => sources(dir)),
    ].filter((path) => !path.endsWith("packages/auth/src/permissions.ts"));

    const checked = new Set<string>();
    for (const path of files) {
      for (const m of readFileSync(path, "utf8").matchAll(NEED)) {
        checked.add(m[1] as string);
      }
    }
    // A pattern that matched nothing would pass this for ever.
    expect(checked.size).toBeGreaterThan(10);

    const ours = Object.keys(statement).filter(
      (resource) => !(resource in defaultStatements),
    );
    expect(ours.filter((resource) => !checked.has(resource))).toEqual([]);
  },
);

if (!present) {
  console.log(
    `  Pro and Modules are not cloned beside ${root}; the statement was not compared with what they guard`,
  );
}
