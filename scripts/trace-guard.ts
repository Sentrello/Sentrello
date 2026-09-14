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

// Every pattern here was matched against real leaks found in this project's
// history (see the audit) before being kept. Keywords that read as ordinary
// English on their own (model, agent, assistant, review, cursor, sonnet,
// opus, haiku, round) are deliberately left out — they collide with normal
// product and business vocabulary far too often to gate a push on.
const RULES: Rule[] = [
  // --- 1. Tool and vendor traces ---
  {
    name: "co-author trailer",
    pattern: /^[ \t]*co-authored-by[ \t]*:/im,
  },
  {
    name: "session trailer",
    pattern: /^[ \t]*[a-z][a-z-]*-session[ \t]*:/im,
  },
  {
    name: "vendor session link or id",
    pattern: new RegExp(
      `\\b${VENDOR_SESSION_HOST}\\b|\\bsession_[a-z0-9]{10,}\\b`,
      "i",
    ),
  },
  {
    // The negative lookahead keeps a comment that merely names this
    // project's own local instructions file (e.g. "a test rather than a
    // note in <that file>") from reading as a vendor mention — found as a
    // real false positive when this guard was run over history that
    // referenced that filename.
    name: "coding-assistant, model or vendor name",
    pattern: new RegExp(
      `\\b${VENDOR_1}\\b(?!\\.md)(\\s+(${AGENT_MODEL_WORDS}))?` +
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

export function findViolations(text: string): Violation[] {
  const hits: Violation[] = [];
  for (const rule of RULES) {
    const m = text.match(rule.pattern);
    if (m) hits.push({ rule: rule.name, match: m[0], where: text });
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

export function isExcludedPath(path: string): boolean {
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

  for (const rawLine of diff.split("\n")) {
    if (rawLine.startsWith("diff --git")) {
      skip = false;
      continue;
    }
    if (rawLine.startsWith("+++ ")) {
      currentFile = rawLine.slice(4).replace(/^b\//, "").trim();
      skip = isExcludedPath(currentFile);
      continue;
    }
    if (!rawLine.startsWith("+") || rawLine.startsWith("+++")) continue;
    if (skip) continue;

    const content = rawLine.slice(1);
    for (const v of findViolations(content)) {
      violations.push({ ...v, where: `${currentFile}: ${content.trim()}` });
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
      violations.push({ ...v, where: `commit "${subject}"` });
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
  for (const v of violations) {
    console.error(`  [${v.rule}] ${v.where}`);
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
