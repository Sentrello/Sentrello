import { expect, test } from "bun:test";
import { join } from "node:path";

/**
 * No public GET is judged by the rule written for a write.
 *
 * The reasoning, the four times it went wrong and the one deliberate
 * exception are in `scripts/reads-are-not-writes.ts`. Spawned rather than
 * imported, because the server project compiles only its own `src`.
 */
test("a public read does not refuse a caller for having no Origin", () => {
  const scan = join(
    import.meta.dir,
    "../../../scripts/reads-are-not-writes.ts",
  );
  const run = Bun.spawnSync(["bun", "run", scan]);
  const found = new TextDecoder()
    .decode(run.stdout)
    .split("\n")
    .filter(Boolean);
  expect(found).toEqual([]);
  expect(run.exitCode).toBe(0);
});
