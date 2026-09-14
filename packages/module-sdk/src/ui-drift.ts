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

export function findHandRolledUi(source: string): string[] {
  const findings = RULES.filter((rule) => rule.pattern.test(source)).map(
    (r) => r.say,
  );

  /**
   * A tab strip that never became `ui.Tabs`.
   *
   * `setTab` names the state a hand-rolled strip needs to change tab; `<Tabs`
   * names the one primitive that already draws one. A screen with the first
   * and not the second is exactly the case two Core screens were found in —
   * checked against Core's own seven tab-bearing screens rather than assumed,
   * because a heuristic this blunt earns its keep only if it is right.
   */
  if (/\bsetTab\b/.test(source) && !/<Tabs\b/.test(source)) {
    findings.push(
      "a tab strip built by hand — use ui.Tabs, which Core's own screens use",
    );
  }

  return findings;
}
