/**
 * What every screen scanner that reads source as text, rather than parsing
 * it, needs and would otherwise reimplement slightly differently: blanking
 * out comments without moving anything else, turning an index back into a
 * line number, and the one marker that excepts a finding.
 *
 * Lifted out of `ui-drift.ts` when `list-invalidation.ts` needed the same
 * three things — a second copy of a comment stripper is a copy that goes out
 * of sync with the first the day someone fixes a bug in only one of them.
 */

/**
 * Blanks out comments while keeping every line break, so a doc comment that
 * happens to contain a pattern a scanner is looking for cannot trip it, and
 * the line numbers reported still point at the original source.
 *
 * One pass, strings and comments together, because two passes were the bug:
 * stripping block comments first meant a `/*` inside a `//` comment — or
 * inside any string, and `accept="image/*"` sits in every upload form —
 * opened a phantom block comment that swallowed the code after it. A blinded
 * scanner reads exactly like a clean one, which is the worst way to fail.
 * Strings are matched so their contents cannot open a comment, and kept;
 * comments are blanked. Regex literals are still not understood — a slash is
 * ambiguous without parsing — but a comment marker inside one now costs at
 * most that line, not the rest of the file.
 */
export function stripComments(source: string): string {
  return source.replace(
    // A quoted string ('…', "…", or `…`, escapes honoured, the first two
    // ending at a newline like the language says), or a comment.
    /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\[\s\S]|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (match, quoted) =>
      quoted === undefined ? match.replace(/[^\n]/g, " ") : match,
  );
}

export function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/**
 * Whether a `// <marker>-ignore: reason` comment sits directly on the line
 * above `line` — the only way to silence a finding. The reason is required in
 * spirit, not in the regex: it sits on the line the next person editing the
 * code will actually read, which is the point.
 *
 *   // ui-drift-ignore: page resets elsewhere, a plain counter is safe here
 *   const [page, setPage] = useState(1);
 */
export function exceptedAbove(
  rawLines: string[],
  line: number,
  marker: string,
): boolean {
  const pattern = new RegExp(`^\\s*//\\s*${marker}-ignore\\b`);
  return pattern.test(rawLines[line - 2] ?? "");
}
