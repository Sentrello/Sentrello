import type { SummaryFigure } from "./summaries";

/**
 * A dashboard panel a module brings with it.
 *
 * The dashboard arranges panels into tabs, and it cannot name a module it
 * does not import — Shop and Booking live in another repository — so each
 * module declares its panels here, one by one, and the dashboard arranges
 * whatever this instance loaded. The same shape as `registerSummary` and
 * `registerOnboarding`, and for the same reason.
 *
 * Two gates, applied per widget rather than per screen:
 *
 * - **Entitlement.** Loading the module is the licence's first say — a widget
 *   from a module the licence did not load is never registered at all. A
 *   module whose panels are worth different amounts says so per widget with
 *   `entitlement`; the dashboard offers and draws it only when the licence
 *   agrees. The dashboard's own ledger charts are the case: the module is
 *   Free, the charts are what Pro buys.
 * - **Permission.** `requires` is the reader's gate. A widget somebody may
 *   not read is not offered, not drawn, and not named to them — being told a
 *   panel exists is being told what the business is hiding from you.
 */
export interface ModuleWidget {
  /** Unique across modules; the module id is a good prefix. */
  id: string;
  /** What to call it when somebody is choosing between panels. */
  label: string;
  icon?: string;
  /** The nav entry pressing the panel opens, if there is a sensible one. */
  opens?: string;
  /** What a reader needs before this panel is offered or drawn for them. */
  requires?: Record<string, string[]>;
  /**
   * What the licence must grant beyond loading the module at all.
   *
   * Most widgets leave this off: loading the module was the entitlement. It
   * exists for a module that always loads but sells some of its panels.
   */
  entitlement?: { tier?: "pro"; module?: string };
  /**
   * Figures for the host's generic card, in the module's own words.
   *
   * A widget without one is drawn by a renderer the web shell ships under the
   * widget's id — which only the platform's own modules can do, because the
   * shell and the module have to be built together. A module in another
   * repository declares figures.
   */
  load?: (organizationId: string) => Promise<SummaryFigure[]>;
}

export interface RegisteredWidget extends ModuleWidget {
  moduleId: string;
}

/**
 * Module scope, not a class.
 *
 * Every module resolves `@sentrello/module-sdk` to the host's copy — it is a
 * peer dependency in each of them precisely so that there is one — so this
 * array is the same array for all of them. The host clears it before loading,
 * because the boot tests load modules more than once in one process.
 */
const registry: RegisteredWidget[] = [];

export function addWidget(widget: RegisteredWidget): void {
  const at = registry.findIndex((w) => w.id === widget.id);
  if (at >= 0) registry[at] = widget;
  else registry.push(widget);
}

export function allWidgets(): RegisteredWidget[] {
  return [...registry];
}

/** For tests and for a host that loads its modules more than once. */
export function clearWidgets(): void {
  registry.length = 0;
}
