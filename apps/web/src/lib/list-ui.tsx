import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";
import { api } from "./api";
import { Icon, type IconName } from "./icons";
import { Button, Select, border, muted } from "./ui";

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
 */
export function useListQuery<T>(
  resource: string,
  state: ListState,
): {
  rows: T[];
  total: number;
  paginated: boolean;
  isLoading: boolean;
  error: unknown;
} {
  const query = listQueryString(state, true);
  const { data, isLoading, error } = useQuery({
    queryKey: [resource, query],
    queryFn: () =>
      api<Record<string, unknown> & { total: number }>(
        `/api/${resource}?${query}`,
      ),
    /**
     * The previous page stays on screen while the next one loads.
     *
     * Without it every page change and every keystroke blanks the table to a
     * spinner, which reads as "your search found nothing" for as long as the
     * request takes.
     */
    placeholderData: (previous) => previous,
  });

  const total = data?.total ?? 0;
  return {
    rows: ((data?.[resource] as T[] | undefined) ?? []) as T[],
    total,
    paginated: total > PAGINATION_THRESHOLD,
    isLoading,
    error,
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
    <aside className="w-52 shrink-0 space-y-4">
      <div className="relative">
        <span
          className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2"
          style={muted}
        >
          <Icon name="search" size={15} />
        </span>
        <input
          value={state.q}
          onChange={(e) => state.setQ(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="w-full rounded-md border py-1.5 pr-2 pl-7 text-sm"
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
        <Icon name={icon} size={14} />
        <span className="flex-1 text-left">{label}</span>
        <span className="nav-caret" data-open={open}>
          <Icon name="chevron-right" size={14} />
        </span>
      </button>
      {open ? <div className="mt-1 space-y-0.5">{children}</div> : null}
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
              background: "var(--color-brand-500)",
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
    <div className="flex flex-wrap items-center gap-3 text-sm">
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
