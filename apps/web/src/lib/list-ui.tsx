import { type Query, useQuery } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";
import { api } from "./api";
import { Icon, type IconName } from "./icons";
import { Button, Select, border, formatMoney, muted } from "./ui";

/**
 * The furniture every list screen needs: search, filters, sort, pages.
 *
 * Contacts, companies and invoices are the same screen with different columns
 * — something to narrow by, a sort and an export across the top, and pages
 * underneath once there are enough rows to need them. Written once here
 * rather than once per module; the deals board borrows the search and filter
 * parts without the pagination.
 *
 * The state lives in this hook and the query string goes to the server, so
 * filtering is a database question rather than a slice of an array the
 * browser already downloaded. That distinction stops mattering at about two
 * hundred contacts and never stops mattering after that.
 */

export interface ListState {
  q: string;
  setQ: (value: string) => void;
  sort: string;
  order: "asc" | "desc";
  setSort: (field: string, order: "asc" | "desc") => void;
  /** The named filters currently applied, as the server's query parameters. */
  filters: Record<string, string>;
  /** Apply or clear one filter. Passing undefined removes it. */
  setFilter: (values: Record<string, string | undefined>) => void;
  /** Whether every parameter in `values` is currently applied. */
  isFilterActive: (values: Record<string, string | undefined>) => boolean;
  /** Turn a filter on if it is off, and off if it is on. */
  toggleFilter: (values: Record<string, string | undefined>) => void;
  clearFilters: () => void;
  hasFilters: boolean;
  page: number;
  setPage: (page: number) => void;
  perPage: number;
  setPerPage: (perPage: number) => void;
}

/**
 * How many rows before the screen offers pages at all.
 *
 * Below this a business can see everything it has in one screen, and a pager
 * under eleven contacts is furniture that only gets in the way.
 */
export const PAGINATION_THRESHOLD = 25;

export const PER_PAGE_CHOICES = [25, 50, 100];

export function useListState(defaults: {
  sort: string;
  order: "asc" | "desc";
}): ListState {
  const [q, setQRaw] = useState("");
  const [sort, setSortField] = useState(defaults.sort);
  const [order, setOrder] = useState<"asc" | "desc">(defaults.order);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);
  const [perPage, setPerPageRaw] = useState(PAGINATION_THRESHOLD);

  /**
   * Any change to what is being looked for goes back to page one.
   *
   * Without this, searching while on page four asks for the fourth page of a
   * result set that now has one page, and the screen goes blank on a search
   * that actually matched something.
   */
  function setQ(value: string) {
    setQRaw(value);
    setPage(1);
  }

  function setSort(field: string, nextOrder: "asc" | "desc") {
    setSortField(field);
    setOrder(nextOrder);
    setPage(1);
  }

  function setPerPage(value: number) {
    setPerPageRaw(value);
    setPage(1);
  }

  function setFilter(values: Record<string, string | undefined>) {
    setFilters((current) => {
      const next = { ...current };
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete next[key];
        else next[key] = value;
      }
      return next;
    });
    setPage(1);
  }

  function isFilterActive(values: Record<string, string | undefined>) {
    return Object.entries(values).every(([key, value]) =>
      value === undefined ? filters[key] === undefined : filters[key] === value,
    );
  }

  return {
    q,
    setQ,
    sort,
    order,
    setSort,
    filters,
    setFilter,
    isFilterActive,
    toggleFilter(values) {
      if (isFilterActive(values)) {
        setFilter(
          Object.fromEntries(
            Object.keys(values).map((key) => [key, undefined]),
          ),
        );
      } else {
        setFilter(values);
      }
    },
    clearFilters() {
      setFilters({});
      setPage(1);
    },
    hasFilters: Object.keys(filters).length > 0,
    page,
    setPage,
    perPage,
    setPerPage,
  };
}

/** The query string this state asks the server for. */
export function listQueryString(state: ListState, paginate: boolean): string {
  const params = new URLSearchParams();
  if (state.q.trim()) params.set("q", state.q.trim());
  params.set("sort", state.sort);
  params.set("order", state.order);
  for (const [key, value] of Object.entries(state.filters)) {
    params.set(key, value);
  }
  if (paginate) {
    params.set("page", String(state.page));
    params.set("perPage", String(state.perPage));
  }
  return params.toString();
}

/**
 * The rows for a list screen.
 *
 * Always asks for a page, and lets the total that comes back decide whether
 * the pager is worth drawing. The first version asked twice — once with
 * `perPage=1` to learn the total, then again for the rows — which doubled
 * every keystroke in the search box to find out something the paged response
 * already carries.
 *
 * Some endpoints answer with more than rows and a total — an orders list
 * with a money summary above the table, say. `response` is the whole body,
 * so a screen that needs one of those extra fields reads it off what was
 * already fetched rather than standing up a second query against the same
 * endpoint to get at it.
 *
 * The cache key is `[resource, query]`, not `[resource]` — a mutation that
 * invalidates a list built on this hook has to invalidate `[resource]`
 * (e.g. `["shop/products"]`), not the resource's leading path segment split
 * into parts (`["shop", "products"]`). TanStack Query matches a partial key
 * against element 0 onward, so the split form silently misses every list
 * this hook fetches.
 *
 * `refetchInterval` is for the rare list whose rows change from a background
 * job rather than from anything the viewer did — a campaign a send job is
 * still working through, say. Most lists only change when the viewer edits
 * something, and TanStack Query already refetches after a mutation settles,
 * so leave it unset unless a screen is watching something that moves on its
 * own. It takes a function as well as a fixed number, so a screen can poll
 * only while its own last-fetched rows say there is something to watch — no
 * second request needed to decide.
 */
type ListResponse = Record<string, unknown> & { total: number };

export function useListQuery<T>(
  resource: string,
  state: ListState,
  options?: {
    refetchInterval?:
      | number
      | false
      | ((query: Query<ListResponse>) => number | false | undefined);
  },
): {
  rows: T[];
  total: number;
  paginated: boolean;
  isLoading: boolean;
  error: unknown;
  response: ListResponse | undefined;
} {
  const query = listQueryString(state, true);
  const { data, isLoading, error } = useQuery({
    // The full path, not just its rows key: two modules can each have an
    // "orders" resource, and the cache is keyed on where the request went,
    // not on what its response happens to be called.
    queryKey: [resource, query],
    queryFn: () => api<ListResponse>(`/api/${resource}?${query}`),
    /**
     * The previous page stays on screen while the next one loads.
     *
     * Without it every page change and every keystroke blanks the table to a
     * spinner, which reads as "your search found nothing" for as long as the
     * request takes.
     */
    placeholderData: (previous) => previous,
    refetchInterval: options?.refetchInterval,
  });

  // The URL is the whole path, but a namespaced module route — `shop/orders`
  // — still answers with its rows under the bare noun, `{ orders, total }`,
  // the same way `contacts` answers under `contacts`. The two are the same
  // word only for Core's own flat resources, so the row key is the last
  // path segment, not the path itself. A trailing slash would otherwise
  // leave that segment empty and the list silently, permanently empty.
  const trimmed = resource.replace(/\/+$/, "");
  const rowsKey = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  const total = data?.total ?? 0;
  return {
    rows: ((data?.[rowsKey] as T[] | undefined) ?? []) as T[],
    total,
    paginated: total > PAGINATION_THRESHOLD,
    isLoading,
    error,
    response: data,
  };
}

// ---------------------------------------------------------------------------
// The filter rail
// ---------------------------------------------------------------------------

export function FilterPanel({
  state,
  placeholder,
  children,
}: {
  state: ListState;
  placeholder: string;
  children: ReactNode;
}) {
  return (
    <aside className="w-52 shrink-0 flex flex-col gap-(--gap-stack)">
      <div className="relative">
        <input
          value={state.q}
          onChange={(e) => state.setQ(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="w-full rounded-md border px-2 py-1.5 text-sm"
          style={{ ...border, background: "var(--surface-raised)" }}
        />
      </div>

      {state.hasFilters ? (
        <button
          type="button"
          className="text-xs link-muted"
          onClick={state.clearFilters}
        >
          Clear all filters
        </button>
      ) : null}

      {children}
    </aside>
  );
}

/**
 * One heading in the rail, with its choices under it.
 *
 * Open by default and collapsible, because a business that never uses tags
 * should not scroll past them to reach the filter it does use.
 */
export function FilterGroup({
  label,
  icon,
  children,
}: {
  label: string;
  icon: IconName;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button
        type="button"
        className="flex w-full items-center gap-1.5 py-1 text-xs uppercase tracking-wide"
        style={muted}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="flex-1 text-left">{label}</span>
        <span className="nav-caret" data-open={open} aria-hidden="true" />
      </button>
      {open ? (
        <div className="mt-1 flex flex-col gap-(--gap-tight)">{children}</div>
      ) : null}
    </div>
  );
}

/** One filter, on or off. */
export function FilterToggle({
  label,
  active,
  onClick,
  count,
}: {
  label: ReactNode;
  active: boolean;
  onClick: () => void;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-sm"
      style={
        active
          ? {
              background: "var(--brand-on-white-text)",
              color: "var(--color-neutral-50)",
            }
          : undefined
      }
    >
      <span className="truncate">{label}</span>
      {count !== undefined ? (
        <span
          className="text-xs tabular-nums"
          style={active ? undefined : muted}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Which columns are worth the width
// ---------------------------------------------------------------------------

/**
 * One column a person may turn off.
 *
 * `fixed` is for the ones a list stops making sense without — the invoice
 * number, the row's own actions. Offering to hide those is offering somebody a
 * way to break their own screen.
 */
/**
 * A column a module worked out, drawn beside the record it belongs to.
 *
 * The values arrive on the rows the list already loaded — the server computes
 * them on read, for the whole page at once — so this is only ever formatting.
 *
 * A cell with no value is a dash and the reason it could not be worked out,
 * never an empty space: an empty cell reads as a number somebody forgot to
 * type, and "no value for Value" is the sentence that tells them which field
 * to fill in.
 */
export interface ComputedColumn {
  key: string;
  label: string;
  kind?: "money" | "whole" | "days" | "text";
}

export interface ComputedValue {
  value: number | string | null;
  reason?: string;
}

export function ComputedCells({
  columns,
  row,
}: {
  columns: ComputedColumn[] | undefined;
  row: { computed?: Record<string, ComputedValue> };
}) {
  if (!columns?.length) return null;
  return (
    <>
      {columns.map((column) => {
        const cell = row.computed?.[column.key];
        return (
          <span
            key={column.key}
            className="shrink-0 whitespace-nowrap"
            title={cell?.reason}
          >
            {column.label}{" "}
            <span className="font-medium">{computedText(cell, column)}</span>
          </span>
        );
      })}
    </>
  );
}

function computedText(
  cell: ComputedValue | undefined,
  column: ComputedColumn,
): string {
  if (!cell || cell.value === null || cell.value === undefined) return "—";
  if (typeof cell.value === "string") return cell.value;
  // Money stays in cents all the way here, and is formatted in the reader's
  // own currency rather than the server's.
  if (column.kind === "money") return formatMoney(cell.value);
  if (column.kind === "days") {
    return `${cell.value} day${cell.value === 1 ? "" : "s"}`;
  }
  return cell.value.toLocaleString();
}

export interface ListColumn {
  field: string;
  label: string;
  fixed?: boolean;
}

export interface ColumnState {
  columns: ListColumn[];
  shown: (field: string) => boolean;
  toggle: (field: string) => void;
  /** Back to every column, for a screen somebody has hidden their way out of. */
  reset: () => void;
  hiddenCount: number;
}

/**
 * Which columns this person wants to see, remembered.
 *
 * Personal rather than the business's: two people working the same list want
 * different things in front of them, and one of them turning a column off for
 * everybody is worse than neither being able to.
 *
 * ponytail: kept in localStorage, so it is per browser rather than per person.
 * Move it to `user_preferences` beside the profile's own settings if somebody
 * asks why their columns did not follow them to a second machine.
 */
export function useColumns(key: string, columns: ListColumn[]): ColumnState {
  const storageKey = `sentrello:columns:${key}`;
  const [hidden, setHidden] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
      return Array.isArray(saved)
        ? saved.filter((f) => typeof f === "string")
        : [];
    } catch {
      return [];
    }
  });

  const remember = (next: string[]) => {
    setHidden(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // A browser with storage refused is a browser that shows every column,
      // which is the right thing to do rather than the reason to fail.
    }
  };

  const optional = columns.filter((c) => !c.fixed);
  return {
    columns,
    // A fixed column is shown whatever is remembered, so a stale entry from
    // before a column became fixed cannot hide it.
    shown: (field) =>
      columns.find((c) => c.field === field)?.fixed === true ||
      !hidden.includes(field),
    toggle: (field) =>
      remember(
        hidden.includes(field)
          ? hidden.filter((f) => f !== field)
          : [...hidden, field],
      ),
    reset: () => remember([]),
    hiddenCount: optional.filter((c) => hidden.includes(c.field)).length,
  };
}

/**
 * The control that turns them on and off.
 *
 * `details`/`summary` rather than a popover built out of state and an outside
 * click handler: the browser already closes it, already handles the keyboard,
 * and already tells a screen reader what it is.
 */
export function ColumnsMenu({ state }: { state: ColumnState }) {
  const optional = state.columns.filter((c) => !c.fixed);
  if (optional.length === 0) return null;
  return (
    <details className="relative">
      <summary
        className="flex cursor-pointer items-center gap-1.5 rounded border px-2 py-1 text-sm"
        style={{ ...border, ...muted }}
      >
        Columns
        {state.hiddenCount > 0 ? (
          <span className="text-xs tabular-nums">
            {optional.length - state.hiddenCount}/{optional.length}
          </span>
        ) : null}
      </summary>
      <div
        className="overlay-panel absolute right-0 z-20 mt-1 w-52 rounded-md border p-2"
        style={border}
      >
        {optional.map((column) => (
          <label
            key={column.field}
            className="flex items-center gap-2 rounded px-1 py-1 text-sm"
          >
            <input
              type="checkbox"
              checked={state.shown(column.field)}
              onChange={() => state.toggle(column.field)}
            />
            {column.label}
          </label>
        ))}
        {state.hiddenCount > 0 ? (
          <button
            type="button"
            className="mt-1 px-1 text-xs link-muted"
            onClick={state.reset}
          >
            Show them all
          </button>
        ) : null}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Sorting and paging
// ---------------------------------------------------------------------------

export interface SortField {
  field: string;
  label: string;
  /** Which way round is the useful default for this column. */
  order?: "asc" | "desc";
}

export function SortMenu({
  state,
  fields,
}: {
  state: ListState;
  fields: SortField[];
}) {
  const current = fields.find((f) => f.field === state.sort);
  return (
    // A span, not a label: this wraps two controls — which column, and which
    // way round — and a label may only name one. Both carry their own
    // `aria-label` instead.
    <span className="flex items-center gap-1.5 text-sm" style={muted}>
      Sort by
      <Select
        value={state.sort}
        aria-label="Sort by"
        onChange={(e) => {
          const chosen = fields.find((f) => f.field === e.target.value);
          state.setSort(e.target.value, chosen?.order ?? "asc");
        }}
        className="w-auto"
      >
        {fields.map((f) => (
          <option key={f.field} value={f.field}>
            {f.label}
          </option>
        ))}
      </Select>
      {/* Reversing the order is its own control: which column to sort by and
          which way round are two questions, and folding them into one list
          doubles its length for no gain. */}
      <button
        type="button"
        className="rounded border px-1.5 py-1 text-xs"
        style={border}
        aria-label={
          state.order === "asc" ? "Sorted ascending" : "Sorted descending"
        }
        title={current ? `${current.label}, ${state.order}ending` : undefined}
        onClick={() =>
          state.setSort(state.sort, state.order === "asc" ? "desc" : "asc")
        }
      >
        {state.order === "asc" ? "↑" : "↓"}
      </button>
    </span>
  );
}

/**
 * Pages, and how many to a page.
 *
 * Only rendered once there are more rows than fit comfortably — see
 * `PAGINATION_THRESHOLD`. Both controls appear together because choosing
 * "100 per page" is usually how somebody makes the pager go away.
 */
export function Pagination({
  state,
  total,
}: {
  state: ListState;
  total: number;
}) {
  const pages = Math.max(1, Math.ceil(total / state.perPage));
  const from = (state.page - 1) * state.perPage + 1;
  const to = Math.min(state.page * state.perPage, total);

  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
      <span style={muted}>
        {from}–{to} of {total}
      </span>

      <span className="flex items-center gap-1.5" style={muted}>
        Rows per page
        <Select
          value={String(state.perPage)}
          aria-label="Rows per page"
          onChange={(e) => state.setPerPage(Number(e.target.value))}
          className="w-auto"
        >
          {PER_PAGE_CHOICES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      </span>

      <div className="ml-auto flex items-center gap-2">
        <Button
          variant="secondary"
          onClick={() => state.setPage(state.page - 1)}
          disabled={state.page <= 1}
        >
          Previous
        </Button>
        <span style={muted}>
          Page {state.page} of {pages}
        </span>
        <Button
          variant="secondary"
          onClick={() => state.setPage(state.page + 1)}
          disabled={state.page >= pages}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// "Last seen" buckets
// ---------------------------------------------------------------------------

/**
 * The five ranges the contact filter offers, as the server's parameters.
 *
 * Computed here rather than named on the server: "this week" depends on the
 * reader's clock and their idea of when a week starts, and a server in UTC
 * deciding that for somebody in Denver gets it wrong every Sunday evening.
 */
export function lastSeenRanges(now = new Date()): {
  label: string;
  values: { lastSeenAfter?: string; lastSeenBefore?: string };
}[] {
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  const startOfWeek = new Date(startOfDay);
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  return [
    { label: "Today", values: { lastSeenAfter: startOfDay.toISOString() } },
    {
      label: "This week",
      values: { lastSeenAfter: startOfWeek.toISOString() },
    },
    {
      label: "Before this week",
      values: { lastSeenBefore: startOfWeek.toISOString() },
    },
    {
      label: "Before this month",
      values: { lastSeenBefore: startOfMonth.toISOString() },
    },
    {
      label: "Before last month",
      values: { lastSeenBefore: startOfLastMonth.toISOString() },
    },
  ];
}

/** Somewhere to hang a memo so the ranges do not move mid-render. */
export function useLastSeenRanges() {
  return useMemo(() => lastSeenRanges(), []);
}

/**
 * The picker that answers the capped list, re-exported here so modules get it.
 *
 * It lives in `record-picker.tsx` and is what `findUnpagedList` tells a screen
 * to reach for: the list endpoint is capped at a thousand rows, so the way to
 * choose one record out of however many a business has is to let the server
 * search. A module could not reach it, and the first one that needed a picker
 * hand-built an `Input` and a `Select` instead — which is the seventh copy of
 * the bug that primitive was written to end.
 *
 * Here rather than in `ui.tsx` for two reasons: this is list machinery, not a
 * plain control — it takes a list endpoint and pages it — and `ui.tsx` is what
 * `record-picker.tsx` itself imports, so re-exporting there would be a cycle.
 */
export { RecordPicker } from "./record-picker";
export type { PickableRecord } from "./record-picker";

/**
 * Saved views, re-exported so a module can mount them.
 *
 * They live in their own file because they are a screen's worth of state and
 * three mutations, not a list primitive — but a module reaches the list
 * machinery through this namespace and nothing else, so a module's list could
 * not offer them at all. Type-only in the other direction, so the two files
 * do not form a runtime cycle.
 */
export { SavedViews } from "./saved-views";
