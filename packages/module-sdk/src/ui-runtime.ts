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

export interface SentrelloUi {
  Button: React.ComponentType<
    React.ButtonHTMLAttributes<HTMLButtonElement> & {
      variant?: "primary" | "secondary" | "danger";
    }
  >;
  Card: React.ComponentType<{ children: React.ReactNode; className?: string }>;
  Field: React.ComponentType<{
    label: string;
    children: React.ReactNode;
    hint?: string;
  }>;
  Input: React.ComponentType<React.InputHTMLAttributes<HTMLInputElement>>;
  SecretInput: React.ComponentType<React.InputHTMLAttributes<HTMLInputElement>>;
  Select: React.ComponentType<React.SelectHTMLAttributes<HTMLSelectElement>>;
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
    /** Set to render a full Button rather than the small inline link. */
    variant?: "primary" | "secondary" | "danger";
    onConfirm: () => void;
  }>;
  Table: React.ComponentType<{
    headers: (string | { label: string; money?: boolean })[];
    children: React.ReactNode;
  }>;
  Row: React.ComponentType<{ children: React.ReactNode }>;
  Tabs: React.ComponentType<{
    tabs: { id: string; label: string; badge?: React.ReactNode }[];
    active: string;
    onChange: (id: string) => void;
    trailing?: React.ReactNode;
  }>;
  Empty: React.ComponentType<{ title: string; children?: React.ReactNode }>;
  Loading: React.ComponentType;
  ErrorNote: React.ComponentType<{ error: unknown }>;
  NeedsPro: React.ComponentType<{ what: string }>;
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
  "Select",
  "Dialog",
  "ConfirmButton",
  "Table",
  "Row",
  "Tabs",
  "Empty",
  "Loading",
  "ErrorNote",
  "NeedsPro",
  "StatusBadge",
  "formatMoney",
  "briefMoney",
  "formatRate",
  "formatDate",
  "textOn",
  "activeTab",
  "muted",
  "border",
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
  ) => {
    rows: T[];
    total: number;
    paginated: boolean;
    isLoading: boolean;
    error: unknown;
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
}

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
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
  screens: Record<string, () => React.ReactElement | null>;
  /**
   * The record this screen was opened for, when it was opened for one.
   *
   * Read on render rather than kept, because the host replaces what is in it
   * rather than the object itself.
   */
  opened: { recordId?: string };
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
