/**
 * A shared helper written out again by hand.
 *
 * Four of these turned up in one afternoon, and every one had drifted in a
 * different direction from the original:
 *
 * - **Pro's CSV builder** wrote bare newlines, which Excel reads as part of a
 *   field so the file opens as one long row, and had no guard against a cell
 *   beginning `=` — which a spreadsheet runs rather than reads.
 * - **The CRM's attachment headers** had the neutral content type and
 *   `nosniff` but never picked up `default-src 'none'`.
 * - **The documents module's `Content-Disposition`** was the *good* one, with
 *   RFC 5987 encoding the SDK's own lacked — in a paid module, where Core and
 *   the free modules could not reach it.
 * - **The SDK's own**, which is the one the other three should have been.
 *
 * None was a mistake anybody made carelessly. A helper is easier to write
 * than to find, especially across four repositories where the shared package
 * is a dependency rather than a folder, and none of the four copies was
 * *wrong* on the day it was written — they were wrong by the time somebody
 * fixed the original.
 *
 * So this looks for the shapes rather than the names: a header line or a
 * comma-joined file assembled where a helper already exists. It reports the
 * file and the line, and says which helper to call.
 */

export interface CopiedHelper {
  line: number;
  /** What it appears to be building. */
  what: string;
  /** The sentence for whoever meets the failure. */
  say: string;
}

/** The helper's own definitions, which are not copies of themselves. */
const DEFINITIONS =
  /export function (contentDisposition|toCsv|attachmentHeaders)\b/;

/**
 * A `Content-Disposition` built by hand.
 *
 * The quoting is the least of it. A name that reaches a header carries
 * whatever the uploader's computer called the file, a value with a control
 * character in it is refused by the runtime, and a non-ASCII name needs the
 * second `filename*` or it arrives with a hole in it.
 */
export function findCopiedDisposition(source: string): CopiedHelper[] {
  const out: CopiedHelper[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!/content-disposition/i.test(line)) continue;
    // A literal filename with nothing interpolated is a constant, and a
    // constant cannot carry anybody's control characters.
    if (!line.includes("${")) continue;
    if (line.includes("contentDisposition(")) continue;
    out.push({
      line: i + 1,
      what: "a Content-Disposition header",
      say: "build it with `contentDisposition(kind, name)` from the SDK — it keeps an ASCII filename for every client and a `filename*` for the real one, and takes out the control characters that make a header the runtime refuses",
    });
  }
  return out;
}

/**
 * A comma-separated file assembled by hand.
 *
 * Found by the pair that has to agree: a `text/csv` answer and a `join(",")`
 * in the same file. Either alone is ordinary.
 */
export function findCopiedCsv(source: string): CopiedHelper[] {
  if (DEFINITIONS.test(source)) return [];
  const lines = source.split("\n");
  const servesCsv = lines.some((l) => /text\/csv/.test(l));
  if (!servesCsv) return [];
  const out: CopiedHelper[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/\.join\(",""?\)|\.join\(','\)/.test(lines[i] ?? "")) continue;
    out.push({
      line: i + 1,
      what: "a CSV file",
      say: "build it with `toCsv(headers, rows)` from the SDK — it ends lines the way Excel needs them and stops a cell that begins `=` running as a formula in whoever's spreadsheet opens it",
    });
  }
  return out;
}

/** Every copy this file knows how to recognise. */
export function findCopiedHelpers(source: string): CopiedHelper[] {
  return [...findCopiedDisposition(source), ...findCopiedCsv(source)];
}
