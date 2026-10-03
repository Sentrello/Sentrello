import { expect, test } from "bun:test";
import { join } from "node:path";

/**
 * This repository is public, and some names are not.
 *
 * Three kinds of thing leaked into it, all in comments and test fixtures
 * written by somebody explaining a real case:
 *
 *   - the marketing site's repository, named in three legal files;
 *   - the instance that mints every customer's licence, in five comments and a
 *     test fixture;
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
 *
 * The list, the scan and the named exemptions live in
 * `scripts/private-names.ts`, which the push guard for commit *messages*
 * shares — one answer to "what may be named", two scopes. This test spawns it
 * rather than importing it, because the server project compiles only its own
 * `src`; `sbom.test.ts` and `public-commit-names.test.ts` reach their scripts
 * the same way.
 */
test("nothing in the public repository names a host or a private repository", () => {
  const scan = join(import.meta.dir, "../../../scripts/private-names.ts");
  const run = Bun.spawnSync(["bun", "run", scan]);
  const found = new TextDecoder()
    .decode(run.stdout)
    .split("\n")
    .filter(Boolean);
  expect(found).toEqual([]);
  expect(run.exitCode).toBe(0);
});
