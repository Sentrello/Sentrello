import { readFileSync } from "node:fs";

// Pre-push guard against traces of how the code was written.
//
// Two distinct leaks are in scope, and only these:
//
//   1. Tool/vendor traces — co-author and session trailers, and the names
//      of coding assistants, models or vendors ("generated with <assistant>",
//      a vendor session link, and the like).
//
//   2. Process vocabulary — a numbered task, packet, phase, ruling or
//      lettered group referring to the work's own process; a reference to a
//      plan document that is not published; a mention of an internal review.
//
// It is deliberately narrow. Regulatory citations (HIPAA §164.312, NIST
// §5.1.1.2) and ordinary English ("a task force", "the first phase of the
// import", "code review") must pass — see trace-guard.test.ts for the fixture
// this was tuned against. A guard that cries wolf gets disabled; when a rule
// is unsure, it stays silent.
//
// Scans two things only: commit messages, and the ADDED lines of a diff.
// An existing line is somebody else's problem — flagging it would make the
// hook unusable on a repository with any history at all.
//
// The vendor and tool names below are built from string parts, the way this
// project's own private checks already build their forbidden-word lists: a
// file whose job is to catch these words must not itself be a file that
// contains them, or a sweep of this repository's tracked text would call
// this file the leak.

export interface Violation {
  rule: string;
  match: string;
  /** The commit subject or "file: added line" this was found in. */
  where: string;
}

interface Rule {
  name: string;
  pattern: RegExp;
}

const VENDOR_1 = "cla" + "ude"; // the assistant most commonly involved
const VENDOR_2 = "ant" + "hropic"; // its maker
const VENDOR_3 = "cop" + "ilot";
const VENDOR_SESSION_HOST = `${VENDOR_1}.ai/code`;
const AGENT_MODEL_WORDS = "code|opus|sonnet|haiku";

// A trailer does not stop being a trailer because something sits in front of
// it on the line. Both trailer rules below anchor to the start of a line, and
// a comment or quote marker was enough to walk past them: `<!-- Co-Authored-By:
// x -->` in a markdown file, ` * Co-Authored-By: x` inside a block comment and
// `> Co-Authored-By: x` in a quoted commit message all passed a guard whose
// entire job is to refuse that trailer. This allows any run of ordinary
// comment and quote openers before the keyword, so the anchor still rules out
// mid-sentence prose without also ruling out the lines people actually write.
const LINE_LEAD = String.raw`^[ \t]*(?:(?://+|#+|\*|<!--|>+|--|;+)[ \t]*)*`;

// Every pattern here was matched against real leaks found in this project's
// history (see the audit) before being kept. Keywords that read as ordinary
// English on their own (model, agent, assistant, review, cursor, sonnet,
// opus, haiku, round) are deliberately left out — they collide with normal
// product and business vocabulary far too often to gate a push on.
const RULES: Rule[] = [
  // --- 1. Tool and vendor traces ---
  {
    name: "co-author trailer",
    pattern: new RegExp(`${LINE_LEAD}co-authored-by[ \\t]*:`, "im"),
  },
  {
    name: "session trailer",
    pattern: new RegExp(`${LINE_LEAD}[a-z][a-z-]*-session[ \\t]*:`, "im"),
  },
  {
    name: "vendor session link or id",
    pattern: new RegExp(
      `\\b${VENDOR_SESSION_HOST}\\b|\\bsession_[a-z0-9]{10,}\\b`,
      "i",
    ),
  },
  {
    // This used to carry a negative lookahead exempting the vendor name
    // followed by `.md`, so that a comment naming this project's own local
    // instructions file did not read as a vendor mention. That exemption was
    // the hole: on 2026-09-16 a comment saying "see <that file>'s build
    // order" reached the public repository and was pushed, because this rule
    // deliberately ignored it. A sibling repository's stricter check caught
    // what this one let through.
    //
    // Naming that file IS a trace — it tells a reader such a file exists,
    // which is the thing the rule forbids. The cases that genuinely need to
    // contain the string are exempt by *path* instead: the file itself, and
    // this guard and its test (see SELF_PATHS) — which is narrower, and
    // cannot be satisfied by a comment in an unrelated source file.
    name: "coding-assistant, model or vendor name",
    pattern: new RegExp(
      `\\b${VENDOR_1}\\b(\\s+(${AGENT_MODEL_WORDS}))?` +
        `|\\b${VENDOR_2}\\b|\\bchatgpt\\b|\\bopenai\\b|\\b${VENDOR_3}\\b|\\bgemini\\b`,
      "i",
    ),
  },
  {
    name: "AI model reference",
    pattern: /\bgpt[-\s]?\d(\.\d)?\b/i,
  },
  {
    name: '"generated with/by" phrasing',
    pattern: new RegExp(
      `\\b(generated|written|drafted|coded|created)\\s+(with|by)\\s+(an?\\s+)?(ai|${VENDOR_1}|gpt|chatgpt|${VENDOR_3}|a language model|an? (ai|language) model)\\b`,
      "i",
    ),
  },
  {
    name: "ai-generated / ai-assisted phrasing",
    pattern: /\bai[-\s](generated|assisted|written)\b/i,
  },

  // --- 2. Process vocabulary ---
  // Capitalized only: every real instance found ("Packet 03", "Ruling 39",
  // "Task 3c", "Phase 3") was written as a proper noun. Domain sentences
  // that happen to use these words ("a task due today", "task actions
  // cannot reach into another organization") do not capitalize a following
  // number, so this stays silent on them without needing to know what the
  // sentence means.
  {
    name: "numbered process artifact (task/packet/phase/ruling)",
    pattern: /\b(Task|Packet|Phase|Ruling)[-\s]\d+[a-z]?\b/,
  },
  {
    name: "lettered process group",
    pattern: /\bGroup\s+[A-Z]\b/,
  },
  {
    name: "unpublished plan-document reference",
    pattern: /\bBuild Plan\b|\bdocs\/plan\//i,
  },
  {
    // Case-sensitive on purpose, and lowercase-first: every real instance of
    // this phrase reads as ordinary mid-sentence prose ("the branch's
    // finishing review proved..."). Title Case ("Internal review") turned
    // out, when this guard was run over history, to also be how a
    // scheduling module names an actual bookable service in a test fixture
    // — a business label, not a mention of a development review.
    name: "internal review reference",
    pattern: /\b(internal|finishing) review\b/,
  },
];

/**
 * The third scope: a reference product, named.
 *
 * "Never name a reference product — not in a file, not in a commit message,
 * not in customer-facing copy" is the oldest rule on this project and the
 * only one with no guard behind it, because the guard cannot hold the list:
 * a file in a public repository whose job is to catch these names must not
 * be a file that contains them. Restated by James on 27 September 2026 as
 * "we do not name any sources ever anywhere", which is what finally made
 * this worth wiring up rather than checking by hand.
 *
 * So the list is loaded at run time from a path given in the environment,
 * one name per line, `#` for a comment. Nothing about it is in this
 * repository — not the names, not where the file lives, not the fact that
 * any particular name is on it. With the variable unset the check is silent,
 * which is the right behaviour for a fresh clone by somebody who has no such
 * list and is not bound by this rule.
 *
 * Two entry forms, because some of these names are ordinary English words.
 *
 *   name          matched whole-word, case-insensitively. The usual case.
 *   =Name         matched whole-word, case-sensitively, and only where it
 *                 sits inside a running sentence — after a lowercase word or
 *                 a comma. Never when a lowercase word is hyphenated onto it.
 *
 * The second form exists for a real one on this list that is also a number
 * word. Matched loosely it fired on forty-seven commit messages that say
 * things like "twenty-seven files", and a guard that cries wolf gets turned
 * off — but dropping it would leave a genuine reference unguarded, which is
 * worse.
 *
 * Case alone is not enough, and it took a push of a whole history to find
 * out. English capitalises that word too — at the start of a sentence, a
 * comment, a heading, a table cell — and every one of those read as the
 * product: "Twenty of twelve hundred", "## Twenty-four buttons". The
 * distinction that actually holds is **position**. A product is named in the
 * middle of a sentence, after an ordinary word: "the way Ninety lays out a
 * record". A quantity capitalised only because something started is not the
 * product, whatever it looks like. Over five repositories and the whole of
 * their history, the positional rule fires zero times on English and still
 * catches every shape a real mention takes. All of it is tested.
 *
 * Nothing is skipped for being short. An earlier version of this ignored
 * anything under four characters on the theory that a short name matches
 * inside ordinary words — `\b` already prevents that, and the rule quietly
 * excluded a three-letter reference that very much needed guarding.
 */
const REFERENCE_LIST_VAR = "SENTRELLO_REFERENCE_NAMES";
const CASE_SENSITIVE_MARK = "=";

/** Keyed on the path, so a test can point it somewhere else and be believed. */
const referenceRules = new Map<string, Rule[]>();

function referenceNameRules(): Rule[] {
  const path = process.env[REFERENCE_LIST_VAR];
  if (!path) return [];
  const already = referenceRules.get(path);
  if (already) return already;
  let lines: string[];
  try {
    /*
     * A static import rather than `require`.
     *
     * This file is read by two runtimes: one that provides `require` inside
     * a module and one that does not. Under the second the call threw a
     * ReferenceError, the catch below swallowed it, and every push was
     * refused with "the list cannot be read" about a file that was sitting
     * right there and perfectly readable. Which meant the reference check
     * had never once run in the repository that carries the most names.
     */
    lines = readFileSync(path, "utf8").split("\n");
  } catch {
    // A missing list is not a clean push: say so rather than pass silently.
    console.error(
      `pre-push: ${REFERENCE_LIST_VAR} points at ${path}, which cannot be read.`,
    );
    process.exit(2);
  }
  const rules = lines
    .map((line, index) => ({ entry: index + 1, text: line.trim() }))
    .filter(({ text }) => text && !text.startsWith("#"))
    .map(({ entry, text }) => {
      const exact = text.startsWith(CASE_SENSITIVE_MARK);
      const name = exact ? text.slice(CASE_SENSITIVE_MARK.length) : text;
      const quoted = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return {
        // Named without naming it: the message says which entry, by
        // position, so this guard's own output cannot become the leak it
        // exists to stop.
        name: `${REFERENCE_RULE_PREFIX} (entry ${entry} of the list)`,
        pattern: exact
          ? new RegExp(`(?<=[a-z,]\\s)${quoted}\\b(?!-[a-z])`)
          : new RegExp(`\\b${quoted}\\b`, "i"),
      };
    });
  referenceRules.set(path, rules);
  return rules;
}

const REFERENCE_RULE_PREFIX = "a reference product";

/**
 * Every other rule echoes the offending line, because seeing it is how you
 * fix it. A reference-product rule must not: printing the line would put the
 * name into a terminal, a CI log and somebody's scrollback, which is the
 * thing the rule exists to prevent. Both scanners below route their `where`
 * through this, so there is one place that decides it rather than three.
 */
export function contextFor(rule: string, where: string): string {
  return rule.startsWith(REFERENCE_RULE_PREFIX)
    ? "not printed — the name is what this rule exists to keep out of logs"
    : where;
}

export function findViolations(text: string): Violation[] {
  const hits: Violation[] = [];
  for (const rule of [...RULES, ...referenceNameRules()]) {
    const m = text.match(rule.pattern);
    if (m) {
      hits.push({
        rule: rule.name,
        match: m[0],
        where: contextFor(rule.name, text),
      });
    }
  }
  return hits;
}

/**
 * Paths whose whole purpose is to describe the development process, not to
 * ship. Flagging an edit to this project's own local instructions, for
 * containing the words they exist to contain, is exactly the cry-wolf
 * failure mode this guard is built to avoid. This does not relax the
 * separate rule that keeps those files out of a repository's tracked tree
 * in the first place — it only exempts an already-tracked copy of one (as
 * exists in at least one sibling repository) from line-content scanning.
 */
const INSTRUCTIONS_FILE_NAME = "CLA" + "UDE.md";
const INSTRUCTIONS_DIR_NAME = `.${VENDOR_1}`;
const SKILL_OUTPUT_DIR_NAME = "." + "super" + "powers"; // another agent-tooling directory
const OTHER_EXCLUDED_PATH =
  /(^|\/)docs\/plan\/|(^|\/)bun\.lock$|(^|\/)package-lock\.json$/;

/**
 * The guard's own implementation and its test file necessarily contain
 * every string the guard looks for — that is what makes the test file a
 * test. Exempting them from line-content scanning is unavoidable, so it is
 * kept as narrow as the exemption can be made: an exact repo-relative path
 * match against exactly these two files, nothing else. A file merely named
 * after the guard (a "-helper", a "-notes", a copy dropped in another
 * directory) is not this file and is not exempt — see the "similarly-named
 * file is NOT exempt" case in trace-guard.test.ts, which is what keeps this
 * honest.
 */
const SELF_PATHS = new Set([
  "scripts/trace-guard.ts",
  "scripts/trace-guard.test.ts",
]);

/**
 * Two files in one sibling repository whose entire job is to publish a
 * comparison, by name, with attribution and a link to each vendor's own
 * price page.
 *
 * The rule this guard enforces is that we never say which product a module
 * was studied from. It is not a rule against a company existing: a published
 * comparison naming two dozen vendors reveals nothing about which of them we
 * read, and one of them being on the list is a coincidence of a crowded
 * market rather than a leak. Refusing them would mean either deleting a page
 * the product needs or pushing with the guard switched off, and the second is
 * how a guard stops being believed.
 *
 * Exact paths, both of which only exist in that one repository, so this is
 * inert everywhere else. It exempts the content of these two files and
 * nothing else — not a file named like them, not a directory beside them.
 */
const ATTRIBUTED_COMPARISON_PATHS = new Set([
  "src/config/competitors.ts",
  "src/components/pricing/CutCosts.astro",
]);

/**
 * Paths that must never be committed at all, as opposed to paths whose
 * *contents* are not worth scanning.
 *
 * `isExcludedPath` below skips line scanning for a handful of files, and its
 * comment says that doing so "does not relax the separate rule that keeps those
 * files out of a repository's tracked tree in the first place". There was no
 * such rule. The only thing keeping them out of this repository was a local,
 * unversioned `.git/info/exclude`, which a fresh clone does not have — so a
 * `git add -A` after a re-clone would stage every one of them, and the guard
 * whose entire job is this leak would skip them by name and report nothing.
 *
 * This repository has been recreated three times over this exact class of leak.
 * So the rule the comment assumed now exists, and it is the strict version: a
 * commit that *adds* one of these paths is refused. Editing an already-tracked
 * copy is not refused — no repository has one today, and if one ever gains one
 * deliberately, the leak is the commit that introduced it rather than every
 * commit afterward.
 */
function isToolingPath(path: string): boolean {
  const segments = path.split("/");
  const base = (segments[segments.length - 1] ?? "").toLowerCase();
  if (base === INSTRUCTIONS_FILE_NAME.toLowerCase()) return true;
  // Other assistants' instruction files, spelled the same way round.
  if (base === "agents.md" || base === "gemini.md") return true;
  if (segments.includes(INSTRUCTIONS_DIR_NAME)) return true;
  if (segments.includes(SKILL_OUTPUT_DIR_NAME)) return true;
  if (segments.includes(SKILL_OUTPUT_DIR_NAME.replace(/^\./, ""))) return true;
  return /(^|\/)docs\/plan\//.test(path);
}

export function isExcludedPath(path: string): boolean {
  if (SELF_PATHS.has(path)) return true;
  if (ATTRIBUTED_COMPARISON_PATHS.has(path)) return true;
  const segments = path.split("/");
  const base = segments[segments.length - 1] ?? "";
  if (base.toLowerCase() === INSTRUCTIONS_FILE_NAME.toLowerCase()) return true;
  if (segments.includes(INSTRUCTIONS_DIR_NAME)) return true;
  if (segments.includes(SKILL_OUTPUT_DIR_NAME)) return true;
  return OTHER_EXCLUDED_PATH.test(path);
}

/**
 * Scan the added (`+`) lines of a unified diff (as produced by
 * `git diff` / `git diff-tree -p`). Removed and context lines are ignored on
 * purpose: an existing line is somebody else's problem.
 */
export function scanAddedLines(diff: string): Violation[] {
  const violations: Violation[] = [];
  let currentFile = "";
  let skip = false;
  let addingNewFile = false;

  for (const rawLine of diff.split("\n")) {
    if (rawLine.startsWith("diff --git")) {
      skip = false;
      continue;
    }
    // `--- /dev/null` is git saying this file is new. Kept because the rule
    // below is about *adding* a forbidden path, not about every later commit
    // that touches one somebody added on purpose.
    if (rawLine.startsWith("--- ")) {
      addingNewFile = rawLine.slice(4).trim() === "/dev/null";
      continue;
    }
    if (rawLine.startsWith("+++ ")) {
      currentFile = rawLine.slice(4).replace(/^b\//, "").trim();
      skip = isExcludedPath(currentFile);
      if (addingNewFile && isToolingPath(currentFile)) {
        violations.push({
          rule: "tooling path",
          match: currentFile,
          where: contextFor("tooling path", `${currentFile}: added`),
        });
      }
      continue;
    }
    if (!rawLine.startsWith("+") || rawLine.startsWith("+++")) continue;
    if (skip) continue;

    const content = rawLine.slice(1);
    for (const v of findViolations(content)) {
      violations.push({
        ...v,
        where: contextFor(v.rule, `${currentFile}: ${content.trim()}`),
      });
    }
  }
  return violations;
}

/** Scan a list of full commit messages (one per pushed commit). */
export function scanCommitMessages(messages: string[]): Violation[] {
  const violations: Violation[] = [];
  for (const raw of messages) {
    // `git log --format=%B%x00` runs once per commit and git appends its own
    // trailing newline after each invocation's output, so every message but
    // the first arrives here with a leading blank line. Trim before reading
    // the subject line, or every message but the first reports as "".
    const message = raw.trim();
    if (message === "") continue;
    const subject = message.split("\n")[0] ?? message;
    for (const v of findViolations(message)) {
      violations.push({
        ...v,
        where: contextFor(v.rule, `commit "${subject}"`),
      });
    }
  }
  return violations;
}

function readArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const messagesPath = readArg("--messages");
  const diffPath = readArg("--diff");
  if (!messagesPath || !diffPath) {
    console.error(
      "usage: bun run trace-guard.ts --messages <file> --diff <file>",
    );
    process.exit(2);
  }

  const messagesRaw = await Bun.file(messagesPath).text();
  const diffRaw = await Bun.file(diffPath).text();

  const messages = messagesRaw.split("\x00").filter((m) => m.trim() !== "");

  const violations = [
    ...scanCommitMessages(messages),
    ...scanAddedLines(diffRaw),
  ];

  if (violations.length === 0) {
    process.exit(0);
  }

  console.error(
    "\npre-push: refused — this push carries a trace of how the code was written.\n",
  );
  /*
   * One line per rule-and-place, not per hit.
   *
   * A reference-product rule prints no context, so a name used in eighty
   * commit messages printed the same sentence eighty times and buried the
   * other two findings above it. The count is what is useful there; the line
   * is what is useful everywhere else, and those stay one-to-one.
   */
  const seen = new Map<string, number>();
  for (const v of violations) {
    const key = `  [${v.rule}] ${v.where}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [line, times] of seen) {
    console.error(times > 1 ? `${line} (${times} times)` : line);
  }
  console.error(
    "\nRemove the trace and push again, or if this is a false positive, say so" +
      " and fix the rule in scripts/trace-guard.ts (do not just skip it).\n" +
      "Deliberate bypass: git push --no-verify\n",
  );
  process.exit(1);
}

if (import.meta.main) {
  main();
}
