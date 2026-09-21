import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./api";
import { Icon } from "./icons";
import type { ListState } from "./list-ui";
import { Button, ConfirmButton, Input, Select, muted } from "./ui";

/**
 * The list's state, named and kept.
 *
 * "My open deals over five thousand" is a question somebody asks every
 * Monday; a view is the filters, search, sort and grouping that answer it,
 * saved under a name and replayed with one click. The state is exactly what
 * the list machinery already sends the server, so applying a view is
 * indistinguishable from setting everything by hand — including the
 * `groupBy` filter, which rides in `state.filters` like any other
 * parameter.
 *
 * Views are personal: the server scopes them to the signed-in user inside
 * the organization, so this menu only ever shows your own.
 *
 * Every list, not only the CRM's three. The machinery was built for contacts,
 * companies and deals and the invoice and quote lists were left without it —
 * which is to say the two lists a business looks at most on a Monday morning
 * were the two it could not save a question against. The journal joined them
 * when it learned to be searched: a view of it is "what hit the fuel account
 * last quarter", which is the question an accountant asks every quarter.
 */

export interface SavedView {
  id: string;
  name: string;
  resource: string;
  view: {
    q?: string;
    sort?: string;
    order?: "asc" | "desc";
    filters?: Record<string, string>;
  };
}

export function SavedViews({
  resource,
  state,
  defaults,
}: {
  resource:
    | "contacts"
    | "companies"
    | "deals"
    | "invoices"
    | "quotes"
    | "journal"
    | "bills"
    | "banking";
  state: ListState;
  /** What "no view" means for this screen, so applying nothing restores it. */
  defaults: { sort: string; order: "asc" | "desc" };
}) {
  const qc = useQueryClient();
  const [activeId, setActiveId] = useState("");
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  const views = useQuery({
    queryKey: ["views", resource],
    queryFn: () =>
      api<{ views: SavedView[] }>(`/api/views?resource=${resource}`),
  });

  /** The screen's current state, as the server stores it. */
  const stateNow = () => ({
    q: state.q,
    sort: state.sort,
    order: state.order,
    filters: state.filters,
  });

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["views", resource] });

  const create = useMutation({
    mutationFn: () =>
      api<{ view: SavedView }>("/api/views", {
        method: "POST",
        body: JSON.stringify({ resource, name, view: stateNow() }),
      }),
    onSuccess: (made) => {
      setNaming(false);
      setName("");
      setActiveId(made.view.id);
      invalidate();
    },
  });

  const update = useMutation({
    mutationFn: (id: string) =>
      api(`/api/views/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ view: stateNow() }),
      }),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/views/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      setActiveId("");
      invalidate();
    },
  });

  const apply = (view: SavedView | undefined) => {
    if (!view) {
      // Back to the screen as it opens: no search, no filters, the default
      // sort — not whatever happened to be set before the view was chosen.
      state.setQ("");
      state.clearFilters();
      state.setSort(defaults.sort, defaults.order);
      return;
    }
    state.setQ(view.view.q ?? "");
    state.setSort(
      view.view.sort ?? defaults.sort,
      view.view.order ?? defaults.order,
    );
    state.clearFilters();
    const filters = view.view.filters ?? {};
    if (Object.keys(filters).length) state.setFilter(filters);
  };

  const mine = views.data?.views ?? [];
  const active = mine.find((v) => v.id === activeId);

  return (
    <span className="flex items-center gap-1.5 text-sm" style={muted}>
      View
      <Select
        value={activeId}
        aria-label="Saved view"
        className="w-auto"
        onChange={(e) => {
          setActiveId(e.target.value);
          apply(mine.find((v) => v.id === e.target.value));
        }}
      >
        <option value="">All {resource}</option>
        {mine.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </Select>
      {active ? (
        <>
          {/* Save the screen as it stands into the chosen view. */}
          <button
            type="button"
            className="text-xs link-muted"
            onClick={() => update.mutate(active.id)}
          >
            {update.isPending ? "Saving…" : "Update"}
          </button>
          <ConfirmButton
            title="Delete this view?"
            message={`"${active.name}" will be gone. The ${resource} it shows are untouched.`}
            confirmLabel="Delete the view"
            danger
            onConfirm={() => remove.mutate(active.id)}
          >
            Delete
          </ConfirmButton>
        </>
      ) : null}
      {naming ? (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name this view"
            aria-label="View name"
            className="w-40"
            autoFocus
          />
          <Button type="submit" disabled={!name.trim() || create.isPending}>
            Save
          </Button>
          <Button variant="secondary" onClick={() => setNaming(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <button
          type="button"
          className="flex items-center gap-1 text-xs link-muted"
          onClick={() => setNaming(true)}
        >
          <Icon name="plus" size={13} />
          Save view
        </button>
      )}
    </span>
  );
}

/**
 * Which field to fold the list under.
 *
 * `groupBy` is an ordinary filter parameter: the server answers with the
 * same rows plus a `groups` summary over the whole filtered set, and being
 * in `state.filters` means a saved view carries the grouping with it for
 * free.
 */
export function GroupMenu({
  state,
  fields,
}: {
  state: ListState;
  fields: { field: string; label: string }[];
}) {
  return (
    <span className="flex items-center gap-1.5 text-sm" style={muted}>
      Group by
      <Select
        value={state.filters.groupBy ?? ""}
        aria-label="Group by"
        className="w-auto"
        onChange={(e) =>
          state.setFilter({ groupBy: e.target.value || undefined })
        }
      >
        <option value="">Nothing</option>
        {fields.map((f) => (
          <option key={f.field} value={f.field}>
            {f.label}
          </option>
        ))}
      </Select>
    </span>
  );
}

export interface ListGroup {
  value: string | number | null;
  count: number;
  /** Only where the resource sums money — deals. */
  amountCents?: number;
}

/**
 * The page's rows arranged under the grouping the server summarised.
 *
 * The rows are a page and the counts are the whole filtered set, so a
 * header can honestly say "hot — 41" above the three of them this page
 * holds. Groups with none of their rows on this page are left out rather
 * than shown empty.
 */
export function groupedSections<T>(
  rows: T[],
  groups: ListGroup[] | undefined,
  groupBy: string | undefined,
): { group: ListGroup | null; rows: T[] }[] {
  if (!groupBy || !groups) return [{ group: null, rows }];
  const groupValue = (row: T) =>
    String((row as Record<string, unknown>)[groupBy] ?? "");
  const sections = groups
    .map((group) => ({
      group,
      rows: rows.filter((row) => groupValue(row) === String(group.value ?? "")),
    }))
    .filter((section) => section.rows.length > 0);
  return sections.length ? sections : [{ group: null, rows }];
}
