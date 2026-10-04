/**
 * Which columns one person hides, on which lists.
 *
 * It lived in `localStorage`, with a `ponytail:` note saying to move it here
 * the day somebody asked why their columns did not follow them to a second
 * machine. Three things make that day worth not waiting for: a person who works
 * on a laptop and a desk is two sets of columns, clearing site data is a
 * silently reset screen, and a saved view — a filter and a sort and a set of
 * columns under one name — cannot be shared out of a browser's storage.
 *
 * **One row, not one per list.** The whole map lives under a single preference
 * key: a list is a handful of field names, somebody has opinions about four
 * lists rather than forty, and one row means one request on the first screen
 * rather than one per list as a reader moves around.
 *
 * **Hidden rather than shown, which matters when a column is added.** A list
 * that stored what to show would quietly hide every column added after
 * somebody last touched it — so a new figure would be invisible to exactly the
 * people who care enough to have arranged their columns. Storing what is hidden
 * means a new column arrives visible, which is the only safe default.
 */

export type Columns = Record<string, string[]>;

/** A list key, and a field name. Both are ours, so both are narrow. */
const NAME = /^[a-z0-9][a-z0-9:_-]{0,63}$/i;

/** Enough for anybody, and a bound on what one row can grow to. */
const MAX_LISTS = 60;
const MAX_FIELDS = 80;

/**
 * Whatever came in, reduced to something that cannot surprise a screen.
 *
 * Anything unrecognisable is dropped rather than refused, the same bargain the
 * rest of this module's preferences make: a save that fails because one field
 * name is odd is a column menu people stop using.
 */
export function normalizeColumns(input: unknown): Columns {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out: Columns = {};
  for (const [list, fields] of Object.entries(
    input as Record<string, unknown>,
  ).slice(0, MAX_LISTS)) {
    if (!NAME.test(list) || !Array.isArray(fields)) continue;
    const hidden = [
      ...new Set(
        fields.filter(
          (field): field is string =>
            typeof field === "string" && NAME.test(field),
        ),
      ),
    ].slice(0, MAX_FIELDS);
    // An empty list is the same as no entry, and keeping it would grow the row
    // every time somebody pressed "Show them all".
    if (hidden.length > 0) out[list] = hidden;
  }
  return out;
}
