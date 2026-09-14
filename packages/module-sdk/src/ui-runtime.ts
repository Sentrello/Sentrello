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

export interface Runtime {
  ui: SentrelloUi;
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
