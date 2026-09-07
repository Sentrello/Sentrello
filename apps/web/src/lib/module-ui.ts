/**
 * Loading screens that arrived with a module.
 *
 * A module cannot be compiled into this bundle: Pro and the optional modules
 * live in private repos, and their code must never reach the public one. So
 * each ships a prebuilt script, the host serves it at `/modules/<id>/ui.js`
 * while the module is loaded, and the browser fetches it at runtime.
 *
 * The script is built with React and the query client left out and read from
 * `window.__sentrello` instead. Bundling its own copy of React would give the
 * page two Reacts, and two Reacts means hooks throw — the failure is confusing
 * and total, so the shared runtime is not optional.
 */
import * as reactQuery from "@tanstack/react-query";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { api } from "./api";
import * as money from "./money";
import * as ui from "./ui";

type ScreenComponent = () => React.ReactElement | null;

/**
 * The release this instance is running, published by the app shell.
 *
 * Module scripts are cached for five minutes and their URLs carry no version,
 * so without this a customer runs the previous release's screen against the
 * new API for five minutes after every upgrade.
 */
let release = "";
export function setModuleRelease(value: string): void {
  release = value;
}

const versioned = (path: string) =>
  release ? `${path}?v=${encodeURIComponent(release)}` : path;

interface SentrelloRuntime {
  react: typeof React;
  jsxRuntime: typeof jsxRuntime;
  reactQuery: typeof reactQuery;
  /** the same primitives Core's own screens use, so modules look native */
  ui: typeof ui;
  money: typeof money;
  api: typeof api;
  /** where a module registers its screen as it loads */
  screens: Record<string, ScreenComponent>;
}

declare global {
  interface Window {
    __sentrello?: SentrelloRuntime;
  }
}

/** Publishes the shared runtime. Must run before any module script loads. */
export function installRuntime(): SentrelloRuntime {
  if (window.__sentrello) return window.__sentrello;
  const runtime: SentrelloRuntime = {
    react: React,
    jsxRuntime,
    reactQuery,
    ui,
    money,
    api,
    screens: {},
  };
  window.__sentrello = runtime;
  return runtime;
}

const inFlight = new Map<string, Promise<ScreenComponent | null>>();

/**
 * Fetches a screen from a module, once per page load.
 *
 * One module may own several screens — pro-core registers both Deals and
 * Reports — so the script is fetched per module and the screen looked up by
 * the nav entry that asked for it. A module with a single screen can register
 * it under its own id and needs to know none of this.
 *
 * A module whose script is missing or broken resolves to null rather than
 * throwing: the rest of the application — invoicing, the ledger — must keep
 * working when one module's screen does not.
 */
export function loadModuleScreen(
  moduleId: string,
  screenId = moduleId,
): Promise<ScreenComponent | null> {
  const runtime = installRuntime();
  const pick = () =>
    runtime.screens[screenId] ?? runtime.screens[moduleId] ?? null;

  const already = pick();
  if (already) return Promise.resolve(already);

  const existing = inFlight.get(moduleId);
  if (existing) return existing.then(() => pick());

  const promise = new Promise<ScreenComponent | null>((resolve) => {
    // Stylesheet first, so the screen never paints unstyled. It is allowed to
    // be missing: a module with no classes of its own needs none.
    const href = versioned(`/modules/${encodeURIComponent(moduleId)}/ui.css`);
    if (!document.querySelector(`link[href="${href}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      document.head.append(link);
    }

    const script = document.createElement("script");
    script.src = versioned(`/modules/${encodeURIComponent(moduleId)}/ui.js`);
    script.async = true;
    script.onload = () => {
      const screen = pick();
      if (!screen) {
        console.warn(
          `[modules] ${moduleId} loaded but registered no screen for ${screenId}`,
        );
      }
      resolve(screen);
    };
    script.onerror = () => {
      console.warn(`[modules] ${moduleId} has no screens on this instance`);
      resolve(null);
    };
    document.head.append(script);
  });

  inFlight.set(moduleId, promise);
  return promise;
}
