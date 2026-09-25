/**
 * What the host lends a module at runtime, declared once.
 *
 * Core publishes `window.__sentrello` before loading any module script: React,
 * the query client, and the same primitives, list machinery and money helpers
 * Core's own screens use. Borrowing them rather than bundling copies keeps a
 * module small and, more importantly, keeps it looking like part of the product
 * instead of a panel bolted to the side.
 *
 * This file is the only description of that surface. Every module used to carry
 * its own, which meant eleven descriptions that disagreed, and a primitive was
 * usable only by the modules whose copy happened to mention it.
 */
import type * as React from "react";

/**
 * A field a business defined for itself.
 *
 * The shape every module's custom fields share: the CRM attaches them to
 * contacts, companies and deals, Accounting to bills and money in and out.
 * `appliesTo` stays the module's own vocabulary, so the type does not have to
 * know every subject in the product.
 */
export interface CustomField {
  id: string;
  label: string;
  type: "text" | "number" | "date" | "select" | "checkbox";
  options?: string[];
  appliesTo: string;
}

export interface SentrelloUi {
  Button: React.ComponentType<
    React.ButtonHTMLAttributes<HTMLButtonElement> & {
      variant?: "primary" | "secondary" | "danger";
      /**
       * The permission this button's route asks for, written the way
       * `requirePermission` writes it — `{ shop: ["delete"] }`. Without it the
       * button is disabled and says why on hover, rather than being offered
       * and refused after the click.
       */
      needs?: Record<string, string[]>;
    }
  >;
  Card: React.ComponentType<{ children: React.ReactNode; className?: string }>;
  Field: React.ComponentType<{
    label: string;
    children: React.ReactNode;
    hint?: string;
  }>;
  Input: React.ComponentType<
    React.InputHTMLAttributes<HTMLInputElement> & {
      /** A file input needs one to be cleared, and had to stay raw without it. */
      ref?: React.Ref<HTMLInputElement>;
      /**
       * For a box whose own change or blur **is** the write — a date that
       * saves as it is typed, a day off added to a calendar. Not for one
       * somebody fills in and then saves with a button: the button is the
       * write there, and refusing to let somebody type into a form they
       * cannot save is a worse way of telling them so.
       */
      needs?: Record<string, string[]>;
    }
  >;
  SecretInput: React.ComponentType<React.InputHTMLAttributes<HTMLInputElement>>;
  /** The same box as `Input`, taller. Nine screens copied its look by hand. */
  Textarea: React.ComponentType<
    React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
      ref?: React.Ref<HTMLTextAreaElement>;
    }
  >;
  Select: React.ComponentType<
    React.SelectHTMLAttributes<HTMLSelectElement> & {
      /**
       * The permission the route behind this asks for, when choosing from it
       * is the action rather than a step towards one — a status picker on a
       * row, not a filter above a list.
       */
      needs?: Record<string, string[]>;
    }
  >;
  Dialog: React.ComponentType<{
    title: string;
    open: boolean;
    onClose: () => void;
    size?: "md" | "lg" | "xl";
    children: React.ReactNode;
  }>;
  ConfirmButton: React.ComponentType<{
    children: React.ReactNode;
    title: string;
    message: React.ReactNode;
    confirmLabel?: string;
    danger?: boolean;
    disabled?: boolean;
    className?: string;
    /** What the trigger is, when the trigger is a picture. */
    label?: string;
    /**
     * The permission the route behind this asks for. Without it the trigger
     * is disabled and the dialog never opens — being asked to confirm
     * something the server will refuse is worse than not being offered it.
     */
    needs?: Record<string, string[]>;
    /** Set to render a full Button rather than the small inline link. */
    variant?: "primary" | "secondary" | "danger";
    onConfirm: () => void;
  }>;
  /**
   * One line of a row menu, with the permission its route asks for.
   *
   * `RowMenu` was already here and its items were not, so a module writing
   * one wrote `<button className="menu-item">` — which cannot carry a
   * permission, and is how Core's invoice and quote menus came to hold void,
   * credit, delete and send with nothing gating any of them.
   */
  MenuItem: React.ComponentType<
    React.ButtonHTMLAttributes<HTMLButtonElement> & {
      needs?: Record<string, string[]>;
    }
  >;
  Table: React.ComponentType<{
    headers: (string | { label: string; money?: boolean })[];
    children: React.ReactNode;
  }>;
  Row: React.ComponentType<{ children: React.ReactNode }>;
  /**
   * A row's "…" menu, drawn outside every ancestor that could clip it.
   *
   * Promised to modules because every module with a list needs one, and a
   * module that rolls its own gets the bug this one exists to fix: `Table`
   * scrolls sideways on narrow screens, which makes it a clipping context on
   * both axes, and an absolutely-positioned panel on the last row is cut off
   * at the table's edge.
   */
  RowMenu: React.ComponentType<{
    label: string;
    children: (close: () => void) => React.ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }>;
  Tabs: React.ComponentType<{
    tabs: { id: string; label: string; badge?: React.ReactNode }[];
    active: string;
    onChange: (id: string) => void;
    trailing?: React.ReactNode;
  }>;
  Empty: React.ComponentType<{ title: string; children?: React.ReactNode }>;
  Loading: React.ComponentType;
  ErrorNote: React.ComponentType<{ error: unknown }>;
  /** A sentence we wrote, in the colour of something being wrong. */
  Warning: React.ComponentType<{ children: React.ReactNode }>;
  NeedsPro: React.ComponentType<{ what: string }>;
  /** What every screen says when a policy refuses, so no module writes its own. */
  REFUSED: string;
  StatusBadge: React.ComponentType<{ status: string }>;
  formatMoney: (cents: number, currency?: string) => string;
  briefMoney: (cents: number, currency?: string) => string;
  formatRate: (basisPoints: number) => string;
  formatDate: (value: string | Date | null | undefined) => string;
  textOn: (colour: string) => string;
  /**
   * Not generic, because `ui.tsx`'s is not: a generic declaration here would
   * refuse the concrete function it is meant to describe, and the surface test
   * would fail on a difference that is only in this file.
   */
  activeTab: (
    tabs: { id: string; label: string; badge?: React.ReactNode }[],
    active: string,
  ) => { id: string; label: string; badge?: React.ReactNode } | undefined;
  muted: React.CSSProperties;
  border: React.CSSProperties;
  PageActions: React.ComponentType<{ children: React.ReactNode }>;
  PageSubtitle: React.ComponentType<{ children: React.ReactNode }>;
  /**
   * The root of a screen. `prose` for a form or a settings page, which at full
   * width is a line of text a metre long; `full` for anything with a table.
   */
  Page: React.ComponentType<{
    children: React.ReactNode;
    width?: "full" | "prose";
    className?: string;
  }>;
  /** The row of controls above a list: search, filters, the primary action. */
  Toolbar: React.ComponentType<{
    children: React.ReactNode;
    className?: string;
  }>;
  SectionHeading: React.ComponentType<{
    children: React.ReactNode;
    level?: 2 | 3;
    hint?: React.ReactNode;
    trailing?: React.ReactNode;
  }>;
  StatFigure: React.ComponentType<{
    label: React.ReactNode;
    value: React.ReactNode;
    tone?: "plain" | "good" | "bad";
    hint?: React.ReactNode;
    size?: "sm" | "md";
  }>;
  /**
   * The custom-field trio, shared for the reason its source states: a second
   * copy would be a second place for a list field to lose its choices. The
   * form inputs, the values read back on a record, and the settings editor
   * that defines them.
   */
  CustomFields: React.ComponentType<{
    fields: CustomField[];
    values: Record<string, string | number | boolean | null>;
    onChange: (next: Record<string, string | number | boolean | null>) => void;
  }>;
  CustomValues: React.ComponentType<{
    fields: CustomField[];
    values: Record<string, string | number | boolean | null> | null | undefined;
  }>;
  CustomFieldEditor: React.ComponentType<{
    fields: CustomField[];
    onChange: (next: CustomField[]) => void;
    /** What a field can be attached to, in the order they should be offered. */
    subjects: { value: string; label: string }[];
    title?: string;
    hint?: string;
  }>;
}

/**
 * The same names, readable at runtime.
 *
 * The interface above is erased when TypeScript compiles, so on its own it
 * cannot answer "does Core still export this?". The list can, and
 * `runtime-surface.test.ts` asks it on every run.
 */
export const UI_MEMBERS = [
  "Button",
  "Card",
  "Field",
  "Input",
  "SecretInput",
  "Textarea",
  "Select",
  "Dialog",
  "ConfirmButton",
  "Table",
  "Row",
  "RowMenu",
  "MenuItem",
  "Tabs",
  "Empty",
  "Loading",
  "ErrorNote",
  "Warning",
  "NeedsPro",
  // The one sentence the whole product says when a policy refuses. A module
  // with a checkbox that writes has no primitive to hang `needs` on and asks
  // `may` directly, and three of them were each carrying their own copy.
  "REFUSED",
  "StatusBadge",
  "formatMoney",
  "briefMoney",
  "formatRate",
  "formatDate",
  "textOn",
  "activeTab",
  "muted",
  "border",
  "PageActions",
  "PageSubtitle",
  "Page",
  "Toolbar",
  "SectionHeading",
  "StatFigure",
  "CustomFields",
  "CustomValues",
  "CustomFieldEditor",
] as const satisfies readonly (keyof SentrelloUi)[];

/** The state one list screen keeps — what `useListState` returns. */
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

/** One choice in a `SortMenu`. */
export interface SortField {
  field: string;
  label: string;
  /** Which way round is the useful default for this column. */
  order?: "asc" | "desc";
}

/**
 * The list machinery Core's own screens use, declared once for modules the
 * same way `SentrelloUi` is above.
 *
 * Search, the filter rail, the sort menu and paging were written, tested and
 * used by Core's lists for months before any module could reach them — see
 * `list-ui.tsx`, which this mirrors.
 */
/** What `useColumns` hands back: which are on, and how to turn one off. */
export interface ColumnState {
  columns: { field: string; label: string; fixed?: boolean }[];
  shown: (field: string) => boolean;
  toggle: (field: string) => void;
  reset: () => void;
  hiddenCount: number;
}

/**
 * A row a `RecordPicker` can offer: something with an id and a name.
 *
 * Restated here rather than imported, the same as every other shape in this
 * file — the SDK cannot see Core's source, and this is the only description
 * of the surface a module is given.
 */
export interface PickableRecord {
  id: string;
  name: string;
  [key: string]: unknown;
}

export interface SentrelloListUi {
  useListState: (defaults: {
    sort: string;
    order: "asc" | "desc";
  }) => ListState;
  /** The query string this state asks the server for. */
  listQueryString: (state: ListState, paginate: boolean) => string;
  useListQuery: <T>(
    resource: string,
    state: ListState,
    /**
     * Set when the list's rows change from a background job rather than
     * from anything the viewer did — a campaign a send job is still working
     * through, say. Most lists never need this.
     *
     * Takes a function as well as a fixed number, so polling can stay
     * conditional on the list's own last-fetched data — `query.state.data`
     * — rather than costing a second request to find out whether there is
     * anything worth watching right now.
     */
    options?: {
      refetchInterval?:
        | number
        | false
        | ((query: {
            state: {
              data: (Record<string, unknown> & { total: number }) | undefined;
            };
          }) => number | false | undefined);
    },
  ) => {
    rows: T[];
    total: number;
    paginated: boolean;
    isLoading: boolean;
    error: unknown;
    /** The whole response the rows and total were read out of. */
    response: (Record<string, unknown> & { total: number }) | undefined;
  };
  FilterPanel: React.ComponentType<{
    state: ListState;
    placeholder: string;
    children: React.ReactNode;
  }>;
  FilterGroup: React.ComponentType<{
    label: string;
    icon: string;
    children: React.ReactNode;
  }>;
  FilterToggle: React.ComponentType<{
    label: React.ReactNode;
    active: boolean;
    onClick: () => void;
    count?: number;
  }>;
  SortMenu: React.ComponentType<{ state: ListState; fields: SortField[] }>;
  /**
   * Which columns this person wants to see, remembered per browser.
   *
   * `fixed` marks the ones a list stops making sense without — the row's own
   * identifier, its actions — and those are never offered.
   */
  useColumns: (
    key: string,
    columns: { field: string; label: string; fixed?: boolean }[],
  ) => ColumnState;
  ColumnsMenu: React.ComponentType<{ state: ColumnState }>;
  Pagination: React.ComponentType<{ state: ListState; total: number }>;
  /** How many rows before the screen offers pages at all. */
  PAGINATION_THRESHOLD: number;
  PER_PAGE_CHOICES: number[];
  lastSeenRanges: (now?: Date) => {
    label: string;
    values: { lastSeenAfter?: string; lastSeenBefore?: string };
  }[];
  useLastSeenRanges: () => {
    label: string;
    values: { lastSeenAfter?: string; lastSeenBefore?: string };
  }[];
  /**
   * The columns another module worked out for these records, drawn.
   *
   * A module's own list gets them the same way Core's does: the values ride
   * in on the rows the list already loaded, under `computed`, and the columns
   * that describe them come back beside the rows as `computedColumns`. A cell
   * with no value draws as a dash carrying the reason, never as a blank.
   */
  /**
   * Choosing one record out of however many a business has.
   *
   * The answer to the capped list, and the reason a module should never fill
   * a `<select>` from a list endpoint: the server searches as somebody types
   * and says "showing 20 of 431" rather than ending silently at a thousand.
   * Core's own invoice, contact, deal and sales-tax screens all go through it.
   *
   * Generic, unlike `activeTab` above, because the concrete function is —
   * a picker hands back the row it was given, with whatever else was on it.
   */
  RecordPicker: <T extends PickableRecord>(props: {
    /** The list endpoint, e.g. "/api/contacts". */
    path: string;
    /** The key the endpoint returns its rows under, e.g. "contacts". */
    resource: string;
    /** What is chosen now, with its name, or nothing. */
    value: { id: string; name: string } | null;
    onChange: (picked: T | null) => void;
    placeholder?: string;
    /** The wording for choosing nobody. Absent means the choice is required. */
    clearLabel?: string | null;
    noun?: string;
  }) => React.ReactElement | null;
  ComputedCells: React.ComponentType<{
    columns:
      | {
          key: string;
          label: string;
          kind?: "money" | "whole" | "days" | "text";
        }[]
      | undefined;
    row: {
      computed?: Record<
        string,
        { value: number | string | null; reason?: string }
      >;
    };
  }>;
  /**
   * A list's state, saved under a name and replayed.
   *
   * `resource` has to be one the platform knows: views are stored against it
   * and each one is gated on the permission its own list is gated on, so a
   * name nobody has registered is refused rather than stored.
   */
  SavedViews: React.ComponentType<{
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
    defaults: { sort: string; order: "asc" | "desc" };
  }>;
}

/**
 * The same names, readable at runtime — `ListState` and `SortField` left out
 * since they are erased when TypeScript compiles and were never members of
 * `typeof listUi` to begin with. Same reason as `UI_MEMBERS`: the interface
 * above cannot answer "does Core still export this?" on its own, so
 * `runtime-surface.test.ts` asks the list instead, on every run.
 */
export const LIST_UI_MEMBERS = [
  "useListState",
  "listQueryString",
  "useListQuery",
  "FilterPanel",
  "FilterGroup",
  "FilterToggle",
  "SortMenu",
  "useColumns",
  "ColumnsMenu",
  "Pagination",
  "PAGINATION_THRESHOLD",
  "PER_PAGE_CHOICES",
  "lastSeenRanges",
  "useLastSeenRanges",
  "RecordPicker",
  "ComputedCells",
  "SavedViews",
] as const satisfies readonly (keyof SentrelloListUi)[];

export interface Runtime {
  ui: SentrelloUi;
  /**
   * The list machinery Core's own screens use: search, the filter rail, the
   * sort menu and paging.
   *
   * It existed and was tested for months before any module could reach it,
   * which is not a small omission — it is the difference between a module's
   * list and Core's being the same product.
   */
  listUi: SentrelloListUi;
  money: { toCents: (value: string) => number };
  /**
   * Whether the person in front of this screen may do something.
   *
   * **For deciding what to offer, never for deciding what is safe.** The
   * route enforces the same rule and is the only thing between a request and
   * the data; a module reading this is being polite. Unknown answers `true`
   * for the same reason the host's sidebar does — hiding a control from
   * somebody entitled to it is the worse of the two mistakes.
   *
   * Most screens want `needs` on the button instead, which reads this and
   * disables itself. This is for the cases a prop cannot express.
   */
  may: (resource: string, action: string) => boolean;
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
  screens: Record<string, () => React.ReactElement | null>;
  /**
   * The record this screen was opened for, when it was opened for one.
   *
   * Read on render rather than kept, because the host replaces what is in it
   * rather than the object itself.
   */
  opened: { recordId?: string };
  /**
   * Opens another screen in the host's own navigation — a module's row
   * linking to the invoice it was raised from, say. Optional because an older
   * host may not publish it; `makeModuleRuntime` falls back to a full page
   * load, which lands in the same place the slow way.
   */
  open?: (view: { moduleId: string; recordId?: string; title: string }) => void;
}

/**
 * The host's runtime, or a sentence saying why there isn't one.
 *
 * A module script is served by a Sentrello instance and cannot run anywhere
 * else. Saying so beats `undefined is not an object` from somewhere deep in a
 * screen.
 */
export function hostRuntime(moduleName: string): Runtime {
  const found = (globalThis as { __sentrello?: Runtime }).__sentrello;
  if (!found) {
    throw new Error(
      `${moduleName}: the host runtime is missing. This script is served by a Sentrello instance and cannot run on its own.`,
    );
  }
  return found;
}

/**
 * The handful of bindings every module's `runtime.ts` shim needs from
 * `hostRuntime`: the primitives, `openedRecord`, and `registerScreen`.
 *
 * Before this, each of the eleven shims bound these by hand — a four-line
 * `registerScreen` and a one-line `openedRecord`, copied rather than shared,
 * on top of the declaration duplication this file already fixed. A shim is
 * now this function called with its own module name.
 */
export function makeModuleRuntime(moduleName: string): {
  ui: SentrelloUi;
  money: Runtime["money"];
  may: Runtime["may"];
  api: Runtime["api"];
  listUi: SentrelloListUi;
  openedRecord: () => string | undefined;
  registerScreen: (id: string, screen: () => React.ReactElement | null) => void;
  open: (view: { moduleId: string; recordId?: string; title: string }) => void;
} {
  const runtime = hostRuntime(moduleName);
  return {
    ui: runtime.ui,
    money: runtime.money,
    may: runtime.may,
    api: runtime.api,
    listUi: runtime.listUi,
    /** The record this screen was opened for, if any. */
    openedRecord: () => runtime.opened?.recordId,
    /** How a module hands its screen to the host. */
    registerScreen(id, screen) {
      runtime.screens[id] = screen;
    },
    /** Opens another screen — a host too old to navigate gets a page load. */
    open(view) {
      if (runtime.open) {
        runtime.open(view);
        return;
      }
      globalThis.location?.assign(
        view.recordId
          ? `/${view.moduleId}/${encodeURIComponent(view.recordId)}`
          : `/${view.moduleId}`,
      );
    },
  };
}
