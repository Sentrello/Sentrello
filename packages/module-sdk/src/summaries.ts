/**
 * What each module says about itself, on the dashboard.
 *
 * The dashboard used to reach into the tables Core owns — invoices, quotes,
 * tasks — because those are the ones it could name. That does not extend: Shop
 * and Booking live in another repository and Core must not import them, so
 * anything they know would never reach the first screen a business looks at.
 *
 * A module registers a summary instead: a handful of figures and what they are
 * called. The dashboard renders whatever is registered, in whatever
 * combination this instance's licence loaded, and knows nothing about any of
 * them. A module that is not installed contributes nothing, which is the
 * correct answer rather than an empty panel.
 */

export interface SummaryFigure {
  label: string;
  /**
   * Cents for money, a whole number for a count, a string for anything else.
   *
   * Money stays in cents all the way to the browser, which formats it — a
   * figure formatted on the server is a figure in the server's locale and
   * currency, and this one belongs to whoever is reading it.
   */
  value: number | string;
  kind?: "money" | "count" | "text";
  /** Which currency `money` is in. The organization's own, when absent. */
  currency?: string;
  /** Draws attention, or does not. `bad` is for a number somebody must act on. */
  tone?: "plain" | "good" | "bad";
}

export interface ModuleSummary {
  /** Unique across modules; the module id is a good prefix. */
  id: string;
  label: string;
  icon?: string;
  /** The nav entry pressing the card opens, if there is a sensible one. */
  opens?: string;
  /** What a reader needs before these figures are computed for them at all. */
  requires?: Record<string, string[]>;
  load: (organizationId: string) => Promise<SummaryFigure[]>;
}

export interface RegisteredSummary extends ModuleSummary {
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
const registry: RegisteredSummary[] = [];

export function addSummary(summary: RegisteredSummary): void {
  const at = registry.findIndex((s) => s.id === summary.id);
  if (at >= 0) registry[at] = summary;
  else registry.push(summary);
}

export function allSummaries(): RegisteredSummary[] {
  return [...registry];
}

/** For tests and for a host that loads its modules more than once. */
export function clearSummaries(): void {
  registry.length = 0;
}
