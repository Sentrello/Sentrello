/**
 * What a screen built for itself that the platform already provides.
 *
 * Run over Core's screens and over every module's, so the answer to "why does
 * this module look different" stops being something somebody has to notice.
 * Text in, findings out — the file reading is the caller's, which is what lets
 * three repositories share one scanner.
 *
 * Deliberately blunt. It reads source as text rather than parsing it, so it can
 * be fooled by a string containing markup; a scanner that is wrong twice a year
 * and costs nothing beats a parser nobody maintains.
 */
const RULES: { pattern: RegExp; say: string }[] = [
  {
    pattern: /<h[23](?=[\s>])[^>]*(?:className|style)=/,
    say: "a section heading styled by hand — use SectionHeading, which also gets the level right",
  },
  {
    pattern: /<h[23]\s*>/,
    say: "an unstyled section heading, which renders at whatever size the browser picks — use SectionHeading",
  },
  {
    pattern: /\[\s*page\s*,\s*setPage\s*\]\s*=\s*useState/,
    say: "paging written by hand — use listUi.useListState, which Core's lists use",
  },
  {
    pattern: /\[\s*perPage\s*,\s*setPerPage\s*\]\s*=\s*useState/,
    say: "a page size written by hand — listUi.useListState carries PER_PAGE_CHOICES",
  },
];

/**
 * A tab strip that never became `ui.Tabs`.
 *
 * `setTab` names the state a hand-rolled strip needs to change tab; `<Tabs`
 * names the one primitive that already draws one. A screen with the first and
 * not the second is exactly the case two Core screens were found in — checked
 * against Core's own seven tab-bearing screens rather than assumed, because a
 * heuristic this blunt earns its keep only if it is right.
 */
const TAB_PATTERN = /\bsetTab\b/;
const HAS_TABS_COMPONENT = /<Tabs\b/;
const TAB_FINDING =
  "a tab strip built by hand — use ui.Tabs, which Core's own screens use";

/**
 * Excepts the line below it, with a reason — the only way to silence a
 * finding. A comment saying "leave it, note why" suppresses nothing on its
 * own; this does, and the reason sits on the line the next person editing it
 * will actually read.
 *
 *   // ui-drift-ignore: page resets elsewhere, a plain counter is safe here
 *   const [page, setPage] = useState(1);
 */
const IGNORE_ABOVE = /^\s*\/\/\s*ui-drift-ignore\b/;

export interface HandRolledFinding {
  line: number;
  say: string;
}

/**
 * Blanks out comments while keeping every line break, so a doc comment that
 * happens to contain `<h2>` or `setTab` cannot trip a rule — `ui.tsx`'s own
 * `SectionHeading` comment mentions exactly that example — and the line
 * numbers reported below still point at the original source.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (comment) => " ".repeat(comment.length));
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

export function findHandRolledUi(source: string): HandRolledFinding[] {
  const rawLines = source.split("\n");
  const clean = stripComments(source);
  const isExcepted = (line: number) =>
    IGNORE_ABOVE.test(rawLines[line - 2] ?? "");

  const findings: HandRolledFinding[] = [];

  // Every match, not just the first: one excepted line earlier in the file
  // must never hide a genuine violation later in it.
  const allMatches = (pattern: RegExp) =>
    clean.matchAll(new RegExp(pattern.source, `${pattern.flags}g`));

  for (const rule of RULES) {
    for (const match of allMatches(rule.pattern)) {
      const line = lineOf(clean, match.index);
      if (isExcepted(line)) continue;
      findings.push({ line, say: rule.say });
    }
  }

  if (!HAS_TABS_COMPONENT.test(clean)) {
    for (const match of allMatches(TAB_PATTERN)) {
      const line = lineOf(clean, match.index);
      if (!isExcepted(line)) findings.push({ line, say: TAB_FINDING });
    }
  }

  return findings.sort((a, b) => a.line - b.line);
}
