/**
 * An object sent where text belongs, refused before the driver flattens it.
 *
 * The database does not catch this one. A `name` of `{}` is *accepted* — the
 * driver stringifies it — so the row is stored as the literal text
 * `[object Object]`, every list draws it, and nothing anywhere failed. The only
 * sign is a record in somebody's book that cannot be searched for or corrected
 * by name. An array is the same shape: `["a","b"]` is saved as `a,b`.
 *
 * Only objects and arrays, and only text columns. A number or a boolean where
 * text belongs reads back as "123" or "true", which is usually what somebody
 * meant; `{}` and `[]` never are. A `jsonb` column takes an object by design,
 * so asking the table which is which is the whole of the check — no list of
 * field names to keep, and a column added next month is covered.
 *
 * Written for the CRM's generic CRUD, which has refused this since September.
 * It is here because the hand-written routes did not: on 6 October a probe sent
 * `{"name": {}}` to the groups route and a group called `[object Object]`
 * appeared on four screens.
 */
import { getTableColumns } from "drizzle-orm";
import type { Table } from "drizzle-orm";
import { RequestFieldError } from "./request-values";

export type TextCheck = { ok: true } | { ok: false; field: string };

export function checkedText(
  table: Table,
  value: Record<string, unknown>,
): TextCheck {
  const columns = getTableColumns(table) as Record<
    string,
    { columnType?: string } | undefined
  >;
  for (const [field, raw] of Object.entries(value)) {
    if (raw === null || typeof raw !== "object") continue;
    if (raw instanceof Date) continue;
    const kind = columns[field]?.columnType;
    if (kind === "PgText" || kind === "PgVarchar" || kind === "PgChar") {
      return { ok: false, field };
    }
  }
  return { ok: true };
}

/** What the caller is told, naming the field so it can be corrected. */
export function notText(field: string): string {
  return `${field} has to be text, and what arrived was an object. Sent as it is, it would be stored as the words "[object Object]".`;
}

/**
 * The same rule, for every write in the platform rather than route by route.
 *
 * `checkedText` above is the polite version: a route that calls it answers 400
 * and names the field. The trouble is that it has to be *called*, and an audit
 * on 6 October found 27 hand-written routes that did not call it — a form's
 * name, an invoice's notes, every line description on an invoice or a quote,
 * a contact arriving through a public form, an inbound email's subject. Three
 * of them were the un-converted sibling of a converted route, which is the
 * shape of a rule that lives in the callers: it is right wherever somebody
 * remembered and silently absent everywhere else.
 *
 * So the floor goes under all of them, where every write already passes. The
 * schema says which columns are text, so there is no list to keep; a column
 * added next month is covered, in this repository and in the two commercial
 * ones, because they all write through this handle.
 *
 * Only a *plain* object or array is refused. A `sql` expression is an object
 * too and is a perfectly good thing to set a column to, so the test is the
 * prototype rather than `typeof`.
 */
export class TextColumnError extends RequestFieldError {
  constructor(field: string) {
    super(field, notText(field));
    this.name = "TextColumnError";
  }
}

function tableColumns(
  table: Table,
): Record<string, { columnType?: string } | undefined> | null {
  try {
    return getTableColumns(table) as Record<
      string,
      { columnType?: string } | undefined
    >;
  } catch {
    return null;
  }
}

function plain(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function refuseObjects(table: Table, value: unknown): void {
  // Asking a thing that is not a table throws rather than answering, and a
  // guard that can crash the write it is protecting is worse than no guard.
  const columns = tableColumns(table);
  if (!columns) return;
  for (const row of Array.isArray(value) ? value : [value]) {
    if (!plain(row)) continue;
    for (const [field, raw] of Object.entries(row as Record<string, unknown>)) {
      if (!plain(raw)) continue;
      const kind = columns[field]?.columnType;
      if (kind === "PgText" || kind === "PgVarchar" || kind === "PgChar") {
        throw new TextColumnError(field);
      }
    }
  }
}

/** One method of a builder checked, everything after it the real thing. */
function watchOne<T extends object>(
  builder: T,
  name: "values" | "set" | "onConflictDoUpdate",
  table: Table,
): T {
  return new Proxy(builder, {
    get(target, key, receiver) {
      const got = Reflect.get(target, key, receiver);
      if (key !== name || typeof got !== "function") return got;
      return (...args: unknown[]) => {
        const first = args[0];
        if (key === "onConflictDoUpdate") {
          const set = (first as { set?: unknown } | undefined)?.set;
          if (set !== undefined) refuseObjects(table, set);
        } else {
          refuseObjects(table, first);
        }
        const next = (got as (...a: unknown[]) => unknown).apply(target, args);
        // An insert's `values()` answers a builder that can still take an
        // `onConflictDoUpdate`, and that is a second write.
        return name === "values" && next && typeof next === "object"
          ? watchOne(next as object, "onConflictDoUpdate", table)
          : next;
      };
    },
  });
}

/**
 * Wrap a database handle so its writes are checked. Applied to the one handle
 * this package exports, and to every transaction opened on it.
 *
 * Two methods replaced on the handle itself, rather than a `Proxy` around it.
 * A proxy was the first version and it broke the driver: every function read
 * through it came back `bind`-ed, and `bind` does not carry a function's own
 * properties — so `$client` lost `unsafe`, and the one report that streams a
 * cursor stopped working while twelve tests said something vague about a
 * profit and loss. A handle has two write methods and one transaction method;
 * replacing three things is smaller than standing between a caller and
 * everything.
 */
export function guardWrites<T>(handle: T): T {
  /*
   * Typed loosely in here and exactly on the way out. The callers want
   * Drizzle's own types — a declared return of anything narrower turns every
   * `.values().returning()` in the repository into `{}`.
   */
  const h = handle as GuardableHandle;
  const insert = h.insert.bind(h);
  const update = h.update.bind(h);
  h.insert = (table: Table) => watchOne(insert(table), "values", table);
  h.update = (table: Table) => watchOne(update(table), "set", table);
  const open = h.transaction;
  if (typeof open === "function") {
    const transaction = open.bind(h);
    h.transaction = (fn: (tx: unknown) => unknown, ...rest: unknown[]) =>
      transaction((tx: unknown) => fn(guardWrites(tx)), ...rest);
  }
  return handle;
}

interface GuardableHandle {
  insert: (table: Table) => object;
  update: (table: Table) => object;
  transaction?: (fn: (tx: unknown) => unknown, ...rest: unknown[]) => unknown;
}

/**
 * `String(body.x)` with the one case it gets wrong taken out.
 *
 * The floor below catches an object that reaches the database. It cannot catch
 * one that was flattened on the way: `String(body.name ?? "")` hands over the
 * nine characters `[object` and the rest, and by then there is nothing to
 * refuse — the value is a perfectly ordinary string that happens to be
 * nonsense. The first version of this guard went in at the database and a test
 * through the real server proved it did nothing for the commonest shape in the
 * repository, which is this one.
 *
 * So the coercion refuses instead, and the error handler turns it into a 400
 * naming the field. A number or a boolean still becomes "123" or "true",
 * because that is usually what somebody meant.
 *
 * @param fallback what an absent value means, where a route has a default.
 */
export function asText(value: unknown, field: string, fallback = ""): string {
  if (value === undefined || value === null) return fallback;
  if (plain(value)) throw new TextColumnError(field);
  return String(value);
}
