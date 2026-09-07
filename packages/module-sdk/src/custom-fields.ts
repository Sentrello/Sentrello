/**
 * The fields a business adds for itself, on anything.
 *
 * A plumber wants "boiler model" on a contact; a studio wants a link to the
 * brand guidelines; a builder wants "site access" on a deal; a bookkeeper
 * wants a purchase-order number on a bill. None of those is worth a migration,
 * and a product that cannot hold the one thing a business actually looks up is
 * a product they keep a spreadsheet beside.
 *
 * Definitions live in the settings of whichever module owns the record, and
 * values in a JSON column on the record itself. What matters here — and what
 * makes this worth one implementation rather than one per module — is that a
 * value is only ever written against a field somebody defined: the body of a
 * request is not a schema, and without this check any caller could write any
 * key onto any record for ever.
 *
 * **Moved here from the CRM, unchanged.** It was correct and tested there, and
 * a second copy in the accounting module would have been a second place for
 * the coercion rules to drift — which is exactly where a number field starts
 * holding the string a browser sent.
 */

export type FieldType = "text" | "number" | "date" | "select" | "checkbox";

/**
 * What a field can be attached to.
 *
 * A string rather than a closed union: the modules that own records know their
 * own subjects, and a shared list here would have to be edited every time a
 * module learned a new one. The caller says which subjects it allows.
 */
export type FieldSubject = string;

export interface CustomField {
  id: string;
  label: string;
  type: FieldType;
  options?: string[];
  appliesTo: FieldSubject;
}

const TYPES: FieldType[] = ["text", "number", "date", "select", "checkbox"];

/** Lowercase, no spaces: it is a key in a JSON object and in a CSV header. */
export function fieldId(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

/**
 * What a business is allowed to define.
 *
 * Refused rather than repaired: a field silently renamed loses the values
 * already stored under its old id, which looks to whoever typed it like the
 * CRM forgot what they wrote.
 */
export function parseCustomFields(
  input: unknown,
  /**
   * The subjects this module has records for.
   *
   * Checked rather than assumed: a field defined against a subject nothing
   * ever reads is a field somebody filled in and never saw again.
   */
  subjects: FieldSubject[],
): CustomField[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new RangeError("custom fields must be a list");
  }
  if (input.length > 40) {
    throw new RangeError("that is more custom fields than a form can hold");
  }

  const seen = new Set<string>();
  return input.map((raw) => {
    const entry = raw as Record<string, unknown>;
    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    if (!label) throw new RangeError("every custom field needs a label");

    const type = entry.type as FieldType;
    if (!TYPES.includes(type)) {
      throw new RangeError(`"${String(entry.type)}" is not a kind of field`);
    }
    const appliesTo = entry.appliesTo as FieldSubject;
    if (!subjects.includes(appliesTo)) {
      throw new RangeError(
        `a custom field belongs to ${subjects.join(", ")} — not "${String(appliesTo)}"`,
      );
    }

    const id =
      typeof entry.id === "string" && entry.id.trim() !== ""
        ? fieldId(entry.id)
        : fieldId(label);
    if (!id) throw new RangeError(`"${label}" cannot be used as a field name`);

    // Two fields with one id on the same record would overwrite each other.
    const key = `${appliesTo}:${id}`;
    if (seen.has(key)) {
      throw new RangeError(`"${label}" is defined twice`);
    }
    seen.add(key);

    const options =
      type === "select"
        ? (Array.isArray(entry.options) ? entry.options : [])
            .map((o) => String(o).trim())
            .filter((o) => o !== "")
        : undefined;
    if (type === "select" && (!options || options.length === 0)) {
      throw new RangeError(`"${label}" is a list and has nothing to choose`);
    }

    return {
      id,
      label: label.slice(0, 60),
      type,
      ...(options ? { options } : {}),
      appliesTo,
    };
  });
}

/**
 * The values on the way in.
 *
 * Anything without a definition is dropped — not stored "just in case" — and
 * each value is coerced to what its field says it is, so a number field never
 * holds the string a browser sent.
 */
export function coerceCustomValues(
  fields: CustomField[],
  subject: FieldSubject,
  input: unknown,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!input || typeof input !== "object") return out;
  const given = input as Record<string, unknown>;

  for (const field of fields.filter((f) => f.appliesTo === subject)) {
    if (!(field.id in given)) continue;
    const value = given[field.id];
    if (value === null || value === "") {
      out[field.id] = null;
      continue;
    }

    switch (field.type) {
      case "number": {
        const n = Number(value);
        // Not a number is not stored: "about 30" in a number field would come
        // back as NaN and take every total that touched it with it.
        if (Number.isFinite(n)) out[field.id] = n;
        break;
      }
      case "checkbox":
        out[field.id] = value === true || value === "true";
        break;
      case "date": {
        const date = new Date(String(value));
        if (!Number.isNaN(date.getTime())) {
          out[field.id] = date.toISOString().slice(0, 10);
        }
        break;
      }
      case "select": {
        const chosen = String(value);
        // Only what the business put on the list. A stale option left over
        // from an old form is not quietly accepted.
        if (field.options?.includes(chosen)) out[field.id] = chosen;
        break;
      }
      default:
        out[field.id] = String(value).slice(0, 2000);
    }
  }
  return out;
}
