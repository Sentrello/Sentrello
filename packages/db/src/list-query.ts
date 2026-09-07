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
  const direction =
    params.sort && spec.sortable[params.sort]
      ? params.order
      : spec.defaultSort.order;
  return direction === "asc" ? asc(column) : desc(column);
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
