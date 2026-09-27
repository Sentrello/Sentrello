/**
 * Which character separates the columns of a spreadsheet somebody sent us.
 *
 * Its own file, with nothing imported, because both readers need it and one
 * of them runs in a browser: `csv.ts` reaches for `node:fs` through the
 * attachment helpers, and dragging that into the web bundle to answer a
 * question about punctuation would be a poor trade. Same shape as
 * `money-locale.ts`, and for the same reason.
 *
 * Excel and most European banks write a **semicolon** wherever the comma is
 * the decimal separator — Germany, France, the Netherlands, Spain, Italy. We
 * sell there. Read as commas, the whole file is one column: nothing throws
 * and nothing is flagged, so the import screen offers
 * `Datum;Betrag;Verwendungszweck` as a single heading to map, and a business
 * brings in a list of contacts named after their own rows.
 *
 * Decided from the first line only, and outside quotes, because that is the
 * line whose shape the rest of the file follows — counting the whole file
 * would let one note full of semicolons outvote the headings. A comma wins a
 * tie, so an ordinary file is read exactly as it always was.
 */
export function csvSeparator(text: string): string {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const end = src.search(/\r|\n/);
  const first = end === -1 ? src : src.slice(0, end);
  let quoted = false;
  const seen: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  for (const ch of first) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && ch in seen) seen[ch] = (seen[ch] ?? 0) + 1;
  }
  const [best] = Object.entries(seen).sort((a, b) => b[1] - a[1]);
  return best && best[1] > 0 ? best[0] : ",";
}
