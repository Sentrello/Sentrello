import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A commit message in this repository is about the platform.
 *
 * Not the marketing site, not our own instance, not the demo, not a host. Those
 * are real work and belong in the repository where they were done — three of the
 * four are private, which is the point.
 *
 * It is not tidiness. Commit subjects from here are pasted verbatim onto a public
 * release page by a generator, from a subject somebody wrote a week earlier and
 * nobody re-reads. **"one sentence rewritten on the site" went out that way with
 * 1.1.0**, past a release-notes check whose own comment says "not the site" and
 * whose regex covered the hosts and not the site. Ten commits in this
 * repository's history name it, and nothing had ever read a commit message.
 *
 * The ten cannot be fixed: a public history is not rewritable, the tags point at
 * it and every clone has it. This stops the eleventh.
 */
const guard = join(import.meta.dir, "../../../scripts/public-commit-names.ts");

/** One commit per NUL, which is how the pre-push hook writes them. */
async function check(messages: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "msgs-"));
  const file = join(dir, "messages");
  writeFileSync(file, `${messages.join("\0")}\0`);
  const proc = Bun.spawn(["bun", "run", guard, "--messages", file], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, said: out + err };
}

test("a subject naming the site is refused, and quoted back", async () => {
  const { code, said } = await check([
    "docs(legal): one sentence rewritten on the site",
  ]);
  expect(code).toBe(1);
  // Quoted back, because "reword the commit" is not advice anybody can act on
  // without being told which one.
  expect(said).toContain("one sentence rewritten on the site");
  expect(said).toContain("about the platform");
});

/** The body counts too — a subject is not the only thing a generator reads. */
test("the site named in a body is refused", async () => {
  const { code } = await check([
    "fix(crm): a duplicate was found by address and not by name\n\nThe same correction was made on the site in September.",
  ]);
  expect(code).toBe(1);
});

/** And our own hosts, which were already forbidden in files and not in messages. */
test("our own instance and the demo are refused", async () => {
  for (const message of [
    "chore: deployed to bmp and checked the licence",
    "fix: the seed left barkerpawski without a contact form",
    "chore: pointed it at 10.124.0.4",
  ]) {
    const { code } = await check([message]);
    expect(code).toBe(1);
  }
});

/**
 * The words that read as the site and are not.
 *
 * "one call site", "the copy site" and "a call site now" are all in real
 * subjects in this repository. `the site` rather than `site` is what lets them
 * through, and this is the half of the pattern that is easy to lose.
 */
test("a call site is not the site", async () => {
  const { code } = await check([
    "fix(sbom): the version reached one of the two callers\n\nOne call site now, and the repair was checked at the copy site.",
    "feat(money): a credit note posts at the call site rather than twice",
  ]);
  expect(code).toBe(0);
});

/** An ordinary platform commit passes, which is most of them. */
test("a commit about the platform passes", async () => {
  const { code } = await check([
    "feat(pos): every Send reprinted the whole ticket",
    "fix(shop): a partial refund swallowed every refund after it",
  ]);
  expect(code).toBe(0);
});

/** Nothing to check is not a failure — a push can be tags only. */
test("no messages is not a refusal", async () => {
  const { code } = await check([]);
  expect(code).toBe(0);
});
