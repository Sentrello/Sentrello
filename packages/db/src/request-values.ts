/**
 * A number taken from a request body, with the shapes `Number()` says yes to.
 *
 * `Number.isInteger(Number(x))` reads like a type check and is not one.
 * `Number([])` is **0**, so an empty array sent where a price belongs passed
 * every guard in the repository and bought a subscription for nothing;
 * `Number(["500"])` is 500, and `Number(true)` is 1. The range checks beside
 * these reads were all correct and all asking the wrong question — they
 * measured the *result* of a coercion that had already thrown the input away.
 *
 * Found on 6 October, straight after the same hole on the text side, where
 * `String({})` had been storing the words "[object Object]" in books. The two
 * are one bug: a coercion is not a check, and a type annotation on a body is a
 * claim about what a caller sends.
 *
 * A number or a string of digits, then. Anything else is refused by name, and
 * the server's error handler answers 400 — so a route keeps its own range
 * rules and stops having to wonder what it is ranging over.
 */

/** The one class the error handler maps, for both kinds of bad field. */
export class RequestFieldError extends Error {
  readonly field: string;
  /**
   * The answer it deserves, said on the error itself. The host matches this
   * class by name; the module test harness reads `status` and nothing else,
   * so without it a refusal the host answers 400 was a 500 in every module's
   * tests — and a test written against that asserts the wrong thing.
   */
  readonly status = 400;
  constructor(field: string, says: string) {
    super(says);
    this.name = "RequestFieldError";
    this.field = field;
  }
}

/**
 * A whole number, or a refusal naming the field.
 *
 * @param fallback what an absent value means. Without one, absent is refused.
 */
export function asWholeNumber(
  value: unknown,
  field: string,
  fallback?: number,
): number {
  if (value === undefined || value === null || value === "") {
    if (fallback === undefined) {
      throw new RequestFieldError(field, `${field} is required`);
    }
    return fallback;
  }
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^-?\d+$/.test(value.trim())
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(n)) {
    throw new RequestFieldError(
      field,
      `${field} has to be a whole number, and what arrived was ${describe(value)}.`,
    );
  }
  return n;
}

/**
 * The most one stored figure can be: 2,147,483,647, the largest 32-bit
 * integer, which is what every cents column in Core is.
 *
 * A figure past it was a 500 from Postgres ("integer out of range") wherever
 * it arrived — a $30M invoice line, a journal entry, a CSV row — and the
 * person who typed it was told the software had broken. Whether the columns
 * widen is a decision still open; until it is made, every way in refuses the
 * figure by name instead.
 */
export const MOST_A_COLUMN_HOLDS = 2_147_483_647;

/**
 * `n`, or a refusal naming `field` when no column could keep it.
 *
 * For a figure the server worked out — a line's price times its quantity, a
 * document's total — where the field to blame is the one that produced it.
 */
export function fits(n: number, field: string): number {
  if (Math.abs(n) > MOST_A_COLUMN_HOLDS) {
    throw new RequestFieldError(
      field,
      `${field} comes to ${n}, and the most one record can hold is 2,147,483,647.`,
    );
  }
  return n;
}

/**
 * A whole number of cents from a request, or a refusal naming the field when
 * it is not one or no column could keep it.
 *
 * @param fallback what an absent value means. Without one, absent is refused.
 */
export function asStoredCents(
  value: unknown,
  field: string,
  fallback?: number,
): number {
  return fits(asWholeNumber(value, field, fallback), field);
}

/** The same, or nothing (absent, null or ""). */
export function asStoredCentsOrNothing(
  value: unknown,
  field: string,
): number | null {
  if (value === undefined || value === null || value === "") return null;
  return asStoredCents(value, field);
}

/**
 * The same, for a value that may have a fractional part — a rate, a quantity
 * in units rather than thousandths. Money never comes through here: money is
 * integer cents.
 */
export function asNumber(
  value: unknown,
  field: string,
  fallback?: number,
): number {
  if (value === undefined || value === null || value === "") {
    if (fallback === undefined) {
      throw new RequestFieldError(field, `${field} is required`);
    }
    return fallback;
  }
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(n)) {
    throw new RequestFieldError(
      field,
      `${field} has to be a number, and what arrived was ${describe(value)}.`,
    );
  }
  return n;
}

/**
 * True or false, or a refusal naming the field.
 *
 * `body.x === true` reads like a check and is a default: anything that is not
 * literally `true` is `false`. A list's "ask for a name", on by default, was
 * switched off by `{}` on 9 October — accepted, stored, and nothing said.
 *
 * @param fallback what an absent value means. Without one, absent is refused.
 */
export function asFlag(
  value: unknown,
  field: string,
  fallback?: boolean,
): boolean {
  if (value === undefined || value === null) {
    if (fallback === undefined) {
      throw new RequestFieldError(field, `${field} is required`);
    }
    return fallback;
  }
  if (typeof value === "boolean") return value;
  throw new RequestFieldError(
    field,
    `${field} has to be true or false, and what arrived was ${describe(value)}.`,
  );
}

/**
 * One of a fixed set of words, or a refusal naming the field and the set.
 *
 * `body.x === "public" ? "public" : "private"` reads like a check and is a
 * default: "pubic", `{}` and `["public"]` all became "private", answered 201,
 * and nobody was told the list they had just made was not the one they asked
 * for. Found on 9 October on a list's visibility and opt-in and a site's
 * device, and then in a dozen more places of the same shape.
 *
 * @param fallback what an absent value means. Without one, absent is refused.
 */
export function asChoice<const T extends string>(
  value: unknown,
  field: string,
  choices: readonly T[],
  fallback?: T,
): T {
  if (value === undefined || value === null || value === "") {
    if (fallback === undefined) {
      throw new RequestFieldError(field, `${field} is required`);
    }
    return fallback;
  }
  if (
    typeof value === "string" &&
    (choices as readonly string[]).includes(value)
  ) {
    return value as T;
  }
  throw new RequestFieldError(
    field,
    `${field} has to be one of ${choices.join(", ")}, and what arrived was ${describe(value)}.`,
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A record's id, or nothing (null or ""), or a refusal naming the field.
 *
 * `typeof body.x === "string" && UUID.test(body.x) ? body.x : null` is the
 * id-shaped default: `{}` sent for a product's category cleared it and
 * answered 200. Whether the id is this business's is still the route's
 * question; this only says it is an id.
 */
export function asIdOrNothing(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string" && UUID.test(value)) return value;
  throw new RequestFieldError(
    field,
    `${field} has to be an id, or null for none, and what arrived was ${describe(value)}.`,
  );
}

/**
 * Text, or nothing (absent or null), or a refusal naming the field.
 *
 * `typeof body.x === "string" ? body.x : null` reads like a check and is a
 * default: `{}`, `[]` and `5` all become "nothing", and on an edit nothing is
 * what gets stored — a contact's email sent as a list cleared the email and
 * answered 200. A string is the only text; anything else that is present is
 * refused, so a route keeps its own rule for what an empty string means.
 */
export function asTextOrNothing(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  throw new RequestFieldError(
    field,
    `${field} has to be text, and what arrived was ${describe(value)}.`,
  );
}

/**
 * A whole number, or nothing (absent, null or ""), or a refusal naming the
 * field. `Number.isInteger(body.x) ? body.x : 1` is the numeric default:
 * "three" and `[3]` became 1 and the caller was told it worked. Write
 * `asWholeNumberOrNothing(body.x, "x") ?? 1` and keep the default for the
 * case it was meant for.
 */
export function asWholeNumberOrNothing(
  value: unknown,
  field: string,
): number | null {
  if (value === undefined || value === null || value === "") return null;
  return asWholeNumber(value, field);
}

/** The same for a number that may have a fractional part. */
export function asNumberOrNothing(
  value: unknown,
  field: string,
): number | null {
  if (value === undefined || value === null || value === "") return null;
  return asNumber(value, field);
}

/** What the caller sent, said in words rather than printed back at them. */
function describe(value: unknown): string {
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "an object";
  if (typeof value === "boolean") return "true or false";
  return `"${String(value).slice(0, 40)}"`;
}

/**
 * A field an edit does not write, refused by name.
 *
 * An edit reads the fields it knows and nothing else, so anything else in the
 * body was answered 200 and changed nothing, and the caller had every reason
 * to think it had changed. Each entry says where the value comes from
 * instead, which is the thing the caller needs to know next.
 */
export function refuseUnwritable(
  body: Record<string, unknown>,
  unwritable: Record<string, string>,
): void {
  for (const [field, instead] of Object.entries(unwritable)) {
    if (body[field] !== undefined) {
      throw new RequestFieldError(field, `${field} ${instead}`);
    }
  }
}
