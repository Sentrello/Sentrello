import type { SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { and, asc, desc, ilike, or, sql } from "./orm";

/**
 * Searching, filtering, sorting and paging any list screen.
 *
 * Written once rather than once per module. Contacts, companies, deals,
 * invoices and quotes all need the same four things, and each of them started
 * as a route that returned every row in the table — fine at ten records, and
 * the reason none of those screens had a sort, a filter or a page.
 *
 * It lives in `db` rather than in whichever module needed it first: it knows
 * about columns and query builders and nothing about any particular record.
 *
 * The rules that matter here:
 *
 * - Sorting is by allow-list. A sort field arriving from the browser is
 *   attacker-controlled, and interpolating it into SQL is the oldest hole
 *   there is; anything not in the list is ignored rather than refused, so an
 *   old bookmark still shows the list.
 * - Paging is opt-in. Callers that do not ask for a page still get everything,
 *   which is what the invoicing customer picker and the deal board expect —
 *   a board that silently showed the first 25 cards would be worse than one
 *   with no paging at all.
 */

export interface ListSpec {
  /** Columns a free-text search looks through. */
  search?: PgColumn[];
  /** Sortable columns, by the name the browser sends. */
  sortable: Record<string, PgColumn>;
  /** Used when the request names no sort, or names one that does not exist. */
  defaultSort: { field: string; order: "asc" | "desc" };
}

export interface ListParams {
  q: string | null;
  sort: string | null;
  order: "asc" | "desc";
  page: number | null;
  perPage: number;
}

/** The default page size, matching what the list screens offer. */
export const DEFAULT_PER_PAGE = 25;

/** How large a page a caller may ask for, so one request cannot ask for the lot. */
const MAX_PER_PAGE = 200;

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * The paging and ordering a request asked for.
 *
 * `page` stays null when the caller never mentioned paging, which is what
 * keeps the unpaged callers working.
 */
export function listParams(
  query: Record<string, string | undefined>,
): ListParams {
  const q = (query.q ?? "").trim();
  const wantsPaging = query.page !== undefined || query.perPage !== undefined;
  return {
    q: q.length ? q : null,
    sort: query.sort ?? null,
    order:
      query.order === "asc" ? "asc" : query.order === "desc" ? "desc" : "desc",
    page: wantsPaging ? positiveInt(query.page, 1) : null,
    perPage: Math.min(
      positiveInt(query.perPage, DEFAULT_PER_PAGE),
      MAX_PER_PAGE,
    ),
  };
}

/**
 * A free-text condition across the spec's searchable columns.
 *
 * `ilike` with the term escaped: a customer called "50% Ltd" is a real name,
 * and without escaping the `%` it matches every row in the table.
 */
export function searchCondition(
  spec: ListSpec,
  q: string | null,
): SQL | undefined {
  if (!q || !spec.search?.length) return undefined;
  const term = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const parts = spec.search.map((column) => ilike(column, term));
  return parts.length === 1 ? parts[0] : or(...parts);
}

/**
 * Which way a list is actually being ordered.
 *
 * Separate from `orderBy` because a paged list needs a second column to break
 * ties on — two rows sharing a date must not swap places between page one and
 * page two, which hides one of them from whoever is reading — and that
 * tiebreaker has to run the same way as the column in front of it. A
 * tiebreaker pinned to `desc` while the list is ascending is the same bug in
 * a quieter form: the ties come out in the wrong order and page boundaries
 * still move.
 *
 * Asked here rather than worked out again at each call site, because the rule
 * includes the part that is easy to forget: a sort field the browser named
 * that is not on the allow-list falls back to the spec's *default direction*,
 * not to the direction that arrived with the unknown field.
 */
export function orderDirection(
  spec: ListSpec,
  params: ListParams,
): "asc" | "desc" {
  return params.sort && spec.sortable[params.sort]
    ? params.order
    : spec.defaultSort.order;
}

/** The ordering, from the allow-list, falling back to the spec's default. */
export function orderBy(spec: ListSpec, params: ListParams): SQL {
  const column =
    (params.sort ? spec.sortable[params.sort] : undefined) ??
    spec.sortable[spec.defaultSort.field];
  if (!column) {
    throw new Error(
      `list spec's default sort "${spec.defaultSort.field}" is not sortable`,
    );
  }
  return orderDirection(spec, params) === "asc" ? asc(column) : desc(column);
}

/**
 * The same ordering, with a column to break ties on.
 *
 * Every paged list needs one. Without it the database is free to return two
 * rows sharing a sort value in either order, and it does — so a row can sit
 * on page one, then on page two after the next request, and never be read.
 */
export function orderByWith(
  spec: ListSpec,
  params: ListParams,
  tiebreaker: PgColumn,
): SQL[] {
  const direction = orderDirection(spec, params);
  return [
    orderBy(spec, params),
    direction === "asc" ? asc(tiebreaker) : desc(tiebreaker),
  ];
}

/** Everything a request asked to narrow by, as one condition. */
export function allConditions(
  conditions: (SQL | undefined)[],
): SQL | undefined {
  const present = conditions.filter((c): c is SQL => c !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return and(...present);
}

/** `{ limit, offset }` for the page asked for, or nothing when unpaged. */
export function pageWindow(
  params: ListParams,
): { limit: number; offset: number } | null {
  if (params.page === null) return null;
  return {
    limit: params.perPage,
    offset: (params.page - 1) * params.perPage,
  };
}

/**
 * How many rows match, before paging.
 *
 * Asked for only when the caller is paging: it is a second query, and the
 * unpaged callers already know the total from the rows they were handed.
 */
export const countExpression = sql<number>`count(*)::int`;

/**
 * The most rows a caller that never asked for a page is given.
 *
 * "Callers that do not ask for a page still get everything" was the
 * documented behaviour, and everything is a number that grows. At 100,000
 * contacts the customer picker stopped opening at all — not slowly, but with
 * a wire-protocol error from binding one parameter per row on the way out —
 * and before that it was 8 MB of JSON to fill a dropdown.
 *
 * A thousand, so the next screen that forgets to page degrades into a short
 * list rather than taking the instance down with it, and says it has been cut
 * rather than quietly lying about the size of the business.
 */
export const UNPAGED_MAX = 1000;

/**
 * A ceiling on an unpaged result, and an honest word about it.
 *
 * Select `UNPAGED_MAX + 1` rows: one more than the ceiling is how the caller
 * knows there were more without a second count.
 */
export function capUnpaged<T>(rows: T[]): { rows: T[]; truncated: boolean } {
  if (rows.length <= UNPAGED_MAX) return { rows, truncated: false };
  return { rows: rows.slice(0, UNPAGED_MAX), truncated: true };
}

/**
 * One query per thousand ids, rather than one query with a hundred thousand
 * parameters.
 *
 * The Postgres wire protocol counts a statement's parameters in a *signed
 * 16-bit* field, so an `in (...)` of more than about 32,767 ids cannot be
 * sent at all: the bind message fails before the database sees the query.
 * That is how the contact list died above 32,000 rows — not on the rows, on
 * the tags hung off them.
 *
 * A thousand keeps the statement small enough to plan well and leaves the
 * ceiling four hundred times away. The chunks are run in order rather than at
 * once: this is housekeeping on the way out of a list, not the thing anybody
 * is waiting for, and a hundred simultaneous statements would take the pool.
 */
export async function inChunks<T>(
  ids: string[],
  run: (chunk: string[]) => Promise<T[]>,
  size = 1000,
): Promise<T[]> {
  if (ids.length <= size) return ids.length ? await run(ids) : [];
  const out: T[] = [];
  for (let at = 0; at < ids.length; at += size) {
    out.push(...(await run(ids.slice(at, at + size))));
  }
  return out;
}
