#!/usr/bin/env bun
/**
 * A commit message in this repository is about the platform.
 *
 * Not the marketing site, not our own instance, not the demo, not a host that
 * runs any of them. Those are real work and they belong in the repository where
 * they were done — three of the four are private, which is the point.
 *
 * **Why this is a push guard and not a note somewhere.** Commit subjects from
 * here are pasted verbatim onto a public release page by a generator, from a
 * subject somebody wrote a week earlier and nobody re-reads. "one sentence
 * rewritten on the site" went out that way with 1.1.0, past a release-notes
 * check whose own comment says "not the site" and whose regex covered the hosts
 * and not the site. Ten commits in this repository's history name it. Nothing
 * had ever read a commit message.
 *
 * It cannot fix the ten. A public history is not rewritable — the tags point at
 * it and every clone has it — so this stops the eleventh.
 *
 * Takes the same `--messages <file>` the trace guard does, from the same
 * pre-push hook, over the same commits: only what is being pushed, never
 * history. Messages only, never the diff — the files question is a different
 * one and `no-private-names.test.ts` answers it.
 */
import { readFileSync } from "node:fs";
import { FORBIDDEN_IN_MESSAGES } from "./private-names";

const args = process.argv.slice(2);
const at = args.indexOf("--messages");
if (at === -1 || !args[at + 1]) {
  console.error("usage: public-commit-names.ts --messages <file>");
  process.exit(2);
}

/*
 * One commit per NUL, which is how the hook writes them.
 *
 * Checked per commit rather than over the whole blob, so the message that is
 * refused can be quoted back — "reword the commit" is not advice anybody can
 * act on without being told which one.
 */
const messages = readFileSync(args[at + 1] as string, "utf8")
  .split("\0")
  .map((m) => m.trim())
  .filter(Boolean);

const found: string[] = [];
for (const message of messages) {
  const subject = message.split("\n")[0] ?? "";
  for (const { pattern, instead } of FORBIDDEN_IN_MESSAGES) {
    const hit = message.match(pattern);
    if (!hit) continue;
    // The line it is on, because a body is long and the word is one.
    const line =
      message
        .split("\n")
        .find((l) => pattern.test(l))
        ?.trim() ?? subject;
    found.push(
      `  "${hit[0]}" in: ${subject}\n      ${line}\n      say ${instead}`,
    );
  }
}

if (found.length === 0) process.exit(0);

console.error("");
console.error(
  found.length === 1
    ? "refusing to push: a commit message here names something that is not the platform"
    : `refusing to push: ${found.length} commit messages here name something that is not the platform`,
);
console.error("");
for (const one of found) console.error(one);
console.error("");
console.error("  This repository is public and its commit subjects are pasted");
console.error("  verbatim into the release notes. A commit here describes the");
console.error(
  "  platform, the modules and the plugins — not the site, not our",
);
console.error("  own instance, not the demo, not a host.");
console.error("");
console.error(
  "  Reword it:  git commit --amend     (or rebase, for an older one)",
);
console.error("");
process.exit(1);
