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

function field(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
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
    "content-disposition": `attachment; filename="${filename}"`,
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
