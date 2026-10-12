import { csvSeparator } from "./csv-separator";

/**
 * Reading somebody else's spreadsheet, once, for the browser and the server.
 *
 * There were two readers. The one the contacts screen used was right; the
 * one the bank import and the newsletter import used opened a quote wherever
 * it met one, so a statement line reading `12" PIPE,40.00` swallowed the next
 * row whole and a payment vanished without an error. It also ignored a lone
 * carriage return, which is how a file from an old Mac ends its lines. One
 * reader now, with nothing imported that a browser cannot load, which is why
 * it is its own file rather than part of `csv.ts`.
 *
 * Not a full RFC 4180 implementation. It handles quoted fields, doubled quotes
 * inside them, CRLF, LF or a lone CR, a trailing newline, a byte-order mark,
 * and a separator that is not a comma — which between them covers what Excel,
 * Numbers, Google Sheets and every CRM export produce.
 */
export function csvRows(text: string): string[][] {
  // Excel writes a BOM. Left in, it becomes part of the first column's name.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const separator = csvSeparator(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;

  const endField = () => {
    row.push(unguarded(field));
    field = "";
  };
  const endRow = () => {
    endField();
    // A blank line is not a row: imported, it is a contact with no name.
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };

  while (i < src.length) {
    const ch = src[i];

    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    // Only a quote that opens a field starts quoting. One inside a field is
    // an inch mark, and is kept as written.
    if (ch === '"' && field === "") {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === separator) {
      endField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      // CRLF and a lone CR both end the row.
      if (src[i + 1] === "\n") i += 1;
      endRow();
      i += 1;
      continue;
    }
    if (ch === "\n") {
      endRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== "" || row.length) endRow();
  return rows;
}

/**
 * The apostrophe our own export put in front of a cell, taken off again.
 *
 * `toCsv` writes `'+44 1248 555 0123` and `'-Ann` so a spreadsheet shows the
 * text rather than running it as a formula, and a spreadsheet hides the
 * apostrophe for the same reason. Read back as written, an export did not
 * survive its own import: every phone number came in with an apostrophe on
 * the front. Only the exact inverse is undone — an apostrophe before one of
 * the characters a formula starts with.
 */
function unguarded(cell: string): string {
  return /^'[=+\-@\t\r]/.test(cell) ? cell.slice(1) : cell;
}

/**
 * The bytes of an uploaded spreadsheet, as text, whatever saved them.
 *
 * Read as UTF-8 regardless, a file from Excel's "Unicode text" (UTF-16) came
 * in as headings with a NUL between every letter, so nothing mapped, and one
 * saved by Windows in its own code page turned "Müller £5" into "M�ller �5"
 * with no warning at all. UTF-16 announces itself with a byte-order mark;
 * anything else is UTF-8 if it is valid UTF-8, and Windows-1252 if it is not,
 * because that is what every spreadsheet that is not UTF-8 in our four
 * markets is.
 */
export function decodeSpreadsheet(bytes: ArrayBuffer | Uint8Array): string {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data[0] === 0xff && data[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(data.subarray(2));
  }
  if (data[0] === 0xfe && data[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(data.subarray(2));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return new TextDecoder("windows-1252").decode(data);
  }
}
