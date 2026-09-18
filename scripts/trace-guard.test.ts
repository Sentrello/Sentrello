import { describe, expect, test } from "bun:test";
import {
  findViolations,
  isExcludedPath,
  scanAddedLines,
  scanCommitMessages,
} from "./trace-guard";

// Built from parts for the same reason trace-guard.ts itself is: this
// project's own private checks scan its public tree for these words, and a
// fixture that spells one out becomes exactly the leak this file exists to
// catch.
const VENDOR = "cla" + "ude";
const MAKER = "ant" + "hropic";
const OTHER_ASSISTANT = "cop" + "ilot";
const INSTRUCTIONS_FILE = "CLA" + "UDE.md";
const SKILL_OUTPUT_DIR = "." + "super" + "powers";
const cap = (s: string) => s[0]?.toUpperCase() + s.slice(1);

function added(file: string, ...lines: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    "index 0000000..1111111 100644",
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
    "",
  ].join("\n");
}

// --- Must refuse: real trailers pulled from this project's reflog, before
// the filter-branch that stripped them (Sentrello commits ebf7447, 0048e70,
// d70ab98). ---
describe("refuses tool and vendor traces", () => {
  test("a real co-author + vendor-session trailer pair", () => {
    const msg = [
      "fix(module-sdk): the reachability sweep couldn't see useListQuery's own fetch",
      "",
      "A screen whose only reason to touch a list route is useListQuery(...)",
      "names the resource, not a literal /api/ path.",
      "",
      `Co-Authored-By: ${cap(VENDOR)} Opus 5 <noreply@${MAKER}.com>`,
      `${cap(VENDOR)}-Session: https://${VENDOR}.ai/code/session_018HSM8URURJoVoEWQk9RJVM`,
    ].join("\n");
    expect(scanCommitMessages([msg]).length).toBeGreaterThan(0);
  });

  test("a Co-Authored-By trailer with no vendor mention at all is still refused", () => {
    // "co-author and session trailers of any kind" — the rule is not keyed
    // to any particular vocabulary, so a human co-author trailer must
    // refuse too.
    const msg = "fix: tidy up\n\nCo-Authored-By: Jane Human <jane@example.com>";
    expect(scanCommitMessages([msg]).length).toBeGreaterThan(0);
  });

  // Both trailer rules anchored to the start of a line, so anything at all in
  // front of the keyword walked straight past them. Every shape below is one
  // a person actually writes: a trailer pasted into a markdown file, a commit
  // message quoted in a release note, a trailer surviving inside a block
  // comment. A guard that refuses `Co-Authored-By:` and waves through
  // `<!-- Co-Authored-By: -->` is not enforcing the rule it claims to.
  test("a co-author trailer hidden behind a markdown comment marker", () => {
    const diff = added(
      "docs/site/releases/v0-9-0.md",
      "<!-- Co-Authored-By: Jane Human <jane@example.com> -->",
    );
    expect(scanAddedLines(diff).length).toBeGreaterThan(0);
  });

  test("a co-author trailer inside a block comment", () => {
    const diff = added(
      "apps/server/src/index.ts",
      " * Co-Authored-By: Jane Human <jane@example.com>",
    );
    expect(scanAddedLines(diff).length).toBeGreaterThan(0);
  });

  test("a co-author trailer in a quoted commit message", () => {
    const diff = added(
      "docs/site/releases/v0-9-0.md",
      "> Co-Authored-By: Jane Human <jane@example.com>",
    );
    expect(scanAddedLines(diff).length).toBeGreaterThan(0);
  });

  test("a session trailer behind a line comment", () => {
    const diff = added(
      "scripts/release.sh",
      "# Build-Session: https://example.invalid/s/018HSM8URURJoVoEWQk9RJVM",
    );
    expect(scanAddedLines(diff).length).toBeGreaterThan(0);
  });

  test("a trailer behind two stacked markers", () => {
    expect(
      findViolations("<!-- > Co-Authored-By: Jane <jane@example.com> -->")
        .length,
    ).toBeGreaterThan(0);
  });

  test("a bare session id with no trailer keyword", () => {
    expect(
      findViolations("started from session_018HSM8URURJoVoEWQk9RJVM").length,
    ).toBeGreaterThan(0);
  });

  test('"generated with" plus an assistant name, in a commit body', () => {
    const msg = `chore: bump deps\n\nGenerated with ${cap(VENDOR)} Code.`;
    expect(scanCommitMessages([msg]).length).toBeGreaterThan(0);
  });

  test("a vendor name landing in a code comment (added line)", () => {
    const diff = added(
      "apps/server/src/index.ts",
      `// wired up by ${cap(MAKER)}'s ${cap(VENDOR)} for now`,
    );
    expect(scanAddedLines(diff).length).toBeGreaterThan(0);
  });

  test("a second assistant's name is refused the same way", () => {
    const diff = added(
      "apps/web/src/index.tsx",
      `// suggested by ${cap(OTHER_ASSISTANT)} and never checked`,
    );
    expect(scanAddedLines(diff).length).toBeGreaterThan(0);
  });
});

// --- Must refuse: real process vocabulary pulled from this repository's
// history before commit e9507b3 ("fix(docs): comments named the process
// instead of the code"), which cleaned it up. ---
describe("refuses process vocabulary", () => {
  test('a literal test name carrying "(Ruling 18)"', () => {
    const diff = added(
      "apps/server/src/auth.test.ts",
      'test("a locked account whose suspension lookup throws is still refused for the lock (Ruling 18)", async () => {',
    );
    expect(scanAddedLines(diff).length).toBeGreaterThan(0);
  });

  test('a comment citing "Ruling 39"', () => {
    const diff = added(
      "apps/web/src/tabs.tsx",
      " * exercised through the rendered component, per Ruling 39.",
    );
    expect(scanAddedLines(diff).length).toBeGreaterThan(0);
  });

  test('"Task 3c" in a comment', () => {
    const diff = added(
      "apps/server/src/lock.ts",
      " * steps above — factored out here because Task 3c needs the same starting",
    );
    expect(scanAddedLines(diff).length).toBeGreaterThan(0);
  });

  test('"Packet 03" in an env comment', () => {
    const diff = added(
      ".env.example",
      "SENTRELLO_LICENSE_SERVER_URL=https://sentrello.com   # used for daily refresh (Packet 03)",
    );
    expect(scanAddedLines(diff).length).toBeGreaterThan(0);
  });

  test('"Build Plan §6.1" reference', () => {
    const diff = added(
      "packages/auth/src/hono.ts",
      "      // Better Auth's organization IS the tenant boundary from Build Plan §6.1;",
    );
    expect(scanAddedLines(diff).length).toBeGreaterThan(0);
  });

  test('"Phase 3" in a comment', () => {
    const diff = added(
      "apps/web/src/plan.tsx",
      " * Everything else about Phase 3 is tested by pulling the decision out of the",
    );
    expect(scanAddedLines(diff).length).toBeGreaterThan(0);
  });

  test('lettered "Group A" reference (found live in Pro/purchases.ts)', () => {
    const diff = added(
      "packages/pro-accounting/src/purchases.ts",
      " * Group A before banking resolved it. Imported from `@sentrello/db/ledger`",
    );
    expect(scanAddedLines(diff).length).toBeGreaterThan(0);
  });

  test('"finishing review" mention', () => {
    const msg =
      "chore: notes\n\nCaught in finishing review before this went out.";
    expect(scanCommitMessages([msg]).length).toBeGreaterThan(0);
  });

  test("an internal review mention", () => {
    const msg = "fix: tighten validation\n\nFlagged in internal review.";
    expect(scanCommitMessages([msg]).length).toBeGreaterThan(0);
  });
});

// --- Must pass: the two published-standard citations the sweep found, which
// must never be mistaken for an unpublished internal doc. ---
describe("permits regulatory and standards citations", () => {
  test("HIPAA §164.312", () => {
    const diff = added(
      "packages/db/src/security-events.ts",
      "// Somebody opened a record that may hold health information. §164.312(b).",
    );
    expect(scanAddedLines(diff)).toEqual([]);
  });

  test("NIST SP 800-63B §5.1.1.2", () => {
    const diff = added(
      "packages/auth/src/weak-passwords.ts",
      " * NIST SP 800-63B §5.1.1.2 asks that a chosen password be compared against a",
    );
    expect(scanAddedLines(diff)).toEqual([]);
  });
});

// --- Must pass: ordinary English, including near-misses pulled from the
// actual, already-clean, current repository. ---
describe("permits ordinary English near-misses", () => {
  test('"this task queue" — task with no number', () => {
    expect(findViolations("this task queue is drained every minute")).toEqual(
      [],
    );
  });

  test('"the first phase of the import" — phase with no number', () => {
    expect(
      findViolations(
        "the first phase of the import writes rows, the second verifies them",
      ),
    ).toEqual([]);
  });

  test('"a task force" — task with no number', () => {
    expect(
      findViolations("assembled a task force to chase the outage"),
    ).toEqual([]);
  });

  test('a real, current test name: "a task due today reads as today, whatever the hour"', () => {
    expect(
      findViolations("a task due today reads as today, whatever the hour"),
    ).toEqual([]);
  });

  test('a real, current test name: "a group with members lists them, and does not claim to be empty"', () => {
    expect(
      findViolations(
        "a group with members lists them, and does not claim to be empty",
      ),
    ).toEqual([]);
  });

  test('a real, current test name: "task actions cannot reach into another organization"', () => {
    expect(
      findViolations("task actions cannot reach into another organization"),
    ).toEqual([]);
  });

  test('"code review" (CODE_OF_CONDUCT.md) is not "internal review" or "finishing review"', () => {
    expect(
      findViolations(
        "commit messages, code review, and any Sentrello space online or in person",
      ),
    ).toEqual([]);
  });

  test('"round-robin" / "round trip" style wording stays out of scope', () => {
    expect(
      findViolations("retried with round-robin backoff on the round trip"),
    ).toEqual([]);
  });

  test("an ordinary reviewer mention", () => {
    expect(findViolations("caught by a reviewer before any push")).toEqual([]);
  });

  /*
   * This used to assert the opposite — that naming the instructions file was
   * a false positive to be tolerated. That exemption is what let a comment
   * saying "see <that file>'s build order" reach the public repository on
   * 2026-09-16, pushed and unnoticed until a sibling repository's stricter
   * check found it. Naming the file tells a reader it exists, which is the
   * thing the rule forbids; the files that must contain the string are exempt
   * by path instead.
   */
  test("naming this project's own local instructions file IS a vendor mention", () => {
    expect(
      findViolations(
        `A test rather than a note in ${INSTRUCTIONS_FILE}, because the note has been true for a while`,
      ).length,
    ).toBeGreaterThan(0);
  });

  test('a business service literally named "Internal review" (real false positive found in Modules)', () => {
    const diff = added(
      "packages/mod-scheduling/src/index.test.ts",
      '        name: "Internal review",',
    );
    expect(scanAddedLines(diff)).toEqual([]);
  });
});

describe("commit message subject attribution across multiple pushed commits", () => {
  // Regression: git log --format=%B%x00, invoked once per commit and
  // appended, leaves every message but the first with a leading blank line
  // (git appends its own trailing newline after each invocation's output).
  // Un-trimmed, that reported every violation after the first against a
  // blank "" subject instead of the real one — found by running this guard
  // over Pro's actual history.
  test("the second of two concatenated commit messages still reports its own subject", () => {
    const first = "feat(pro-accounting): payables arrive\n";
    const second =
      "\ndocs(pro-accounting): two comments stop describing a boundary that closed\n\n" +
      "not since Group D and Group C respectively landed.\n";
    const violations = scanCommitMessages([first, second]);
    expect(
      violations.some((v) => v.where.includes("two comments stop describing")),
    ).toBe(true);
    expect(violations.some((v) => v.where === 'commit ""')).toBe(false);
  });
});

describe("path exclusions", () => {
  test("this project's own local instructions file may say a packet number without tripping the guard", () => {
    const diff = added(
      INSTRUCTIONS_FILE,
      "3. `docs/plan/Packet-03-Control-Plane.md` — license server.",
    );
    expect(scanAddedLines(diff)).toEqual([]);
  });

  test("a skills file beside it may reference a packet number without tripping the guard", () => {
    const diff = added(
      `.${VENDOR}/skills/sentrello-module/SKILL.md`,
      "Packet 02 §4.2 shows the canonical shape — replicate it per resource.",
    );
    expect(scanAddedLines(diff)).toEqual([]);
  });

  test("the same line in a shipped file (not excluded) still refuses", () => {
    const diff = added(
      "apps/server/src/module-gates.ts",
      "Packet 02 §4.2 shows the canonical shape — replicate it per resource.",
    );
    expect(scanAddedLines(diff).length).toBeGreaterThan(0);
  });

  test("isExcludedPath matches the documented set", () => {
    expect(isExcludedPath(INSTRUCTIONS_FILE)).toBe(true);
    expect(isExcludedPath(`.${VENDOR}/skills/foo.md`)).toBe(true);
    expect(isExcludedPath(`${SKILL_OUTPUT_DIR}/plans/notes.md`)).toBe(true);
    expect(isExcludedPath("docs/plan/00-START-HERE.md")).toBe(true);
    expect(isExcludedPath("bun.lock")).toBe(true);
    expect(isExcludedPath("apps/server/src/index.ts")).toBe(false);
  });

  // The guard's own implementation and its test file necessarily spell out
  // every string the guard looks for — that's what makes the test file a
  // test. Both halves matter here: the guard must exempt exactly those two
  // files, and must NOT exempt a file that merely looks like them by name,
  // or naming a file after the guard becomes a way to smuggle a real trace
  // past it.
  test("the guard's own two files are exempt by exact path", () => {
    expect(isExcludedPath("scripts/trace-guard.ts")).toBe(true);
    expect(isExcludedPath("scripts/trace-guard.test.ts")).toBe(true);
  });

  test("a similarly-named file is NOT exempt", () => {
    expect(isExcludedPath("scripts/trace-guard-helper.ts")).toBe(false);
    expect(isExcludedPath("src/trace-guard-notes.ts")).toBe(false);
    expect(isExcludedPath("scripts/trace-guard.ts.bak")).toBe(false);
    expect(isExcludedPath("other/scripts/trace-guard.ts")).toBe(false);
  });

  test("an added line inside the guard's own files does not trip the guard", () => {
    const diff = added(
      "scripts/trace-guard.ts",
      `const VENDOR = "${VENDOR}"; // vendor name, spelled out on purpose`,
    );
    expect(scanAddedLines(diff)).toEqual([]);
  });

  test("the same line in a look-alike file name still refuses", () => {
    const diff = added(
      "scripts/trace-guard-helper.ts",
      `const VENDOR = "${VENDOR}"; // vendor name, spelled out on purpose`,
    );
    expect(scanAddedLines(diff).length).toBeGreaterThan(0);
  });
});

describe("only added lines are scanned, not removed or context lines", () => {
  test("a removed line carrying a trailer is not flagged", () => {
    const diff = [
      "diff --git a/notes.md b/notes.md",
      "--- a/notes.md",
      "+++ b/notes.md",
      "@@ -1,2 +1,1 @@",
      `-Co-Authored-By: ${cap(VENDOR)} Opus 5 <noreply@${MAKER}.com>`,
      "+cleaned up",
      "",
    ].join("\n");
    expect(scanAddedLines(diff)).toEqual([]);
  });
});

/*
 * The hole that let a trace reach the public repository on 2026-09-16.
 *
 * This rule used to exempt the vendor name followed by `.md`, so that a
 * comment naming the project's own local instructions file did not read as a
 * vendor mention. A comment saying "see <that file>'s build order" was then
 * committed, pushed, and only noticed because a sibling repository ran a
 * stricter check of its own.
 *
 * Naming that file is itself a trace: it tells a reader such a file exists.
 * The files that genuinely must contain the string are exempt by path, not by
 * pattern — which is narrower, and which a comment in an unrelated source file
 * cannot satisfy.
 */
test("naming the instructions file in ordinary source is refused", () => {
  const leaked = `* US sales tax alone — the first market, see ${cap(VENDOR)}.md's build order`;

  expect(findViolations(leaked).length).toBeGreaterThan(0);
  // And it is refused in the file where it actually happened, which is not
  // exempt by any path rule.
  expect(isExcludedPath("packages/db/src/tax-regimes.ts")).toBe(false);
});

test("the instructions file itself is still exempt, by path", () => {
  // The exemption that remains is by path and stays: an already-tracked copy
  // of the instructions file contains these words because that is what it is.
  expect(isExcludedPath(`${cap(VENDOR)}.md`)).toBe(true);
  expect(isExcludedPath("scripts/trace-guard.ts")).toBe(true);
});
