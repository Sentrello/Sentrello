/**
 * Reading somebody else's spreadsheet.
 *
 * Hand-written rather than pulled in, because the rules are small and the
 * failure modes are specific to what people actually export: a note containing
 * a comma, an address with a line break in it, a file saved by Excel with a
 * byte-order mark that turns the first column name into something no mapping
 * will match.
 *
 * Not a full RFC 4180 implementation. It handles quoted fields, doubled quotes
 * inside them, CRLF or LF, and a trailing newline — which between them covers
 * what Excel, Numbers, Google Sheets and every CRM export produce.
 */

export interface Sheet {
  headers: string[];
  rows: string[][];
}

/** Excel writes a BOM. Left in, it becomes part of the first column's name. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function parseCsv(text: string): Sheet {
  const src = stripBom(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    // A trailing newline would otherwise add a row of one empty field, which
    // imports as a contact with no name.
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

    if (ch === '"' && field === "") {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
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

  const [headers = [], ...body] = rows;
  return {
    headers: headers.map((h) => h.trim()),
    // Short rows are padded rather than dropped: a spreadsheet whose last
    // column is empty often omits it entirely, and losing those rows would be
    // silent.
    rows: body.map((r) => headers.map((_, index) => (r[index] ?? "").trim())),
  };
}

/**
 * A first guess at which column is which.
 *
 * Matching is loose on purpose — "First Name", "first_name" and "Given name"
 * all mean the same thing, and a mapping screen that starts empty makes
 * somebody do work a computer can do badly but instantly, and then correct.
 */
export function guessMapping(
  headers: string[],
  fields: { key: string; label: string; aliases?: string[] }[],
): Record<string, string> {
  const normalise = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  const out: Record<string, string> = {};
  const taken = new Set<string>();

  for (const field of fields) {
    const candidates = [field.label, field.key, ...(field.aliases ?? [])].map(
      normalise,
    );
    const match = headers.find(
      (h) => !taken.has(h) && candidates.includes(normalise(h)),
    );
    if (match) {
      out[field.key] = match;
      taken.add(match);
    }
  }
  return out;
}
