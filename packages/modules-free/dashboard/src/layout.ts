import { db, schema } from "@sentrello/db";
import type { ModuleWidget, RegisteredWidget } from "@sentrello/module-sdk";
import { allSummaries, allWidgets, scopedId } from "@sentrello/module-sdk";
import { and, eq } from "drizzle-orm";

/**
 * The tabs, and what is on them.
 *
 * The dashboard arranges widgets modules declared — it holds no list of its
 * own. What it adds is the arranging: tabs the business names, a default
 * good enough that most businesses never touch it, and the discipline that
 * nothing is ever named to a reader whose licence or permission does not
 * cover it. Arranging is not a paid feature (James, 2026-09-13): Free and
 * Pro get the same screen, and Free additionally carries the upgrade block.
 *
 * The arrangement belongs to the organization, not to whoever saved it —
 * "look at the Shop tab" has to mean the same thing to everyone in a twelve
 * person company.
 */

export interface Tab {
  name: string;
  widgets: string[];
}

/**
 * How long one widget's figures may take before the rest stop waiting for it.
 *
 * Every widget on the active tab is fetched through one shared request —
 * `/api/dashboard/widgets` answers all of them at once — so a widget whose
 * `load` never settles, a slow query on a module having a bad day, leaves
 * every other widget's card spinning behind it forever, not just its own.
 * The route already excludes a widget whose `load` throws rather than losing
 * the page to it; a hang is the same failure with nothing to throw.
 */
export const WIDGET_LOAD_TIMEOUT_MS = 4000;

/** Races a widget's own promise against the clock, whichever settles first. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`widget load timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * The dashboard's own panels, declared like anybody else's.
 *
 * The dashboard used to hold a closed list of widget ids beside the registry
 * every other module declared into — two mechanisms for one screen, and the
 * closed one leaked: a Free layout response named every Pro panel. Declared,
 * each carries its own gates and the arranging code treats the platform's
 * panels and the Shop's identically.
 *
 * None carry `load`: their renderers ship in the web shell, drawn from
 * `/api/dashboard`, `/api/dashboard/insights` and `/api/reports/*`, which
 * only the platform's own panels can do because the shell and the module are
 * built together.
 *
 * The report panels are declared here rather than by the modules whose
 * routes they read (`accounting`, and `pro-accounting` for who-owes) because
 * their renderers live in this module's half of the shell; they move when
 * those modules take their screens over.
 */
/**
 * Pro, because the route that answers is in the Pro bundle — never because
 * the panel is worth money.
 *
 * James, 2026-09-20: **the Free dashboard is the Pro dashboard.** The ledger
 * charts below used to be what a licence bought; they are Core's own figures,
 * computed in `pro.ts` from tables every instance has, so they are now
 * answered on every instance. What is still gated is the three panels whose
 * data comes from `pro-accounting` — on a Free instance there is no route to
 * ask, and a panel that 404s is worse than one that is not offered. That is a
 * fact about where the code lives, and it stops being true when those reports
 * move into Core.
 *
 * The only thing Free has that Pro does not is the upgrade block at the top,
 * which appears once onboarding is done.
 */
const answeredByPro = { tier: "pro" as const };
const needsReports = { reports: ["read"] };
export const CORE_WIDGETS: ModuleWidget[] = [
  { id: "money", label: "Money owed" },
  { id: "attention", label: "Needs attention" },
  { id: "pipeline", label: "Pipeline" },
  { id: "health", label: "This server", icon: "gauge" },
  // The twelve-month ledger charts. Free, as of 2026-09-20: every figure in
  // them is computed by Core from tables every instance has.
  { id: "revenue-trend", label: "Income and expenses" },
  { id: "cash-position", label: "Profit trend" },
  { id: "deals-by-stage", label: "Deals by stage" },
  { id: "top-customers", label: "Top customers" },
  { id: "invoice-aging", label: "How late the money is" },
  // The reports, drawn from the ledger; a reader needs the books.
  { id: "balance-sheet", label: "Balance sheet", requires: needsReports },
  // Cash flow and the trial balance are answered by Pro's accounting bundle,
  // not by Core — unlike Balance sheet, which Core answers itself. Missing
  // `entitlement` here left both declared, offered and placed on a Free
  // instance's default Reports tab with nothing behind them to answer, a 404
  // on the very first Reports tab anybody opened.
  {
    id: "cash-flow",
    label: "Cash in and out",
    requires: needsReports,
    entitlement: answeredByPro,
  },
  {
    id: "trial-balance",
    label: "Trial balance",
    requires: needsReports,
    entitlement: answeredByPro,
  },
  {
    id: "who-owes",
    label: "Who owes you",
    requires: needsReports,
    entitlement: answeredByPro,
  },
];

/**
 * Every widget declared on this instance: the ones modules registered
 * individually, plus every registered summary as a widget under
 * `summary:<id>`. The bridge is what lets a module that only knows
 * `registerSummary` — every module written before widgets existed — put its
 * panel on a tab with no further declaration and no special case per module.
 */
export function declaredWidgets(): RegisteredWidget[] {
  const declared = allWidgets();
  const keys = new Set(declared.map((w) => w.key));
  const bridged = allSummaries()
    .map((s) => ({
      id: `summary:${s.id}`,
      key: scopedId(s.moduleId, `summary:${s.id}`),
      label: s.label,
      icon: s.icon,
      opens: s.opens,
      requires: s.requires,
      load: s.load,
      moduleId: s.moduleId,
    }))
    .filter((w) => !keys.has(w.key));
  return [...declared, ...bridged];
}

/**
 * Twelve, because tabs are generated now — one per module this instance
 * loaded — so an instance with the Shop, Booking, the Newsletter, Storage
 * and SEO needs room for them beside the core screens and System. Enforced
 * rather than trusted: the strip is built from whatever is stored, and a
 * payload with two hundred tabs is one PUT away.
 */
const MAX_TABS = 12;
const MAX_WIDGETS_PER_TAB = 12;
/** Known ids are only ever a suppression list; keep it from growing forever. */
const MAX_KNOWN = 200;

/**
 * The shape of a widget id: the module's own word, optionally one namespace
 * deep (`summary:shop`). A shape rather than a list, because ids are
 * module-chosen and the modules live in other repositories.
 */
const WIDGET_ID = /^[a-z0-9][a-z0-9-]{0,63}(:[a-z0-9][a-z0-9-]{0,63}){0,2}$/;

/**
 * What somebody sees before they have arranged anything — which must be good
 * enough that nobody ever has to. Core screens first, then a tab per module
 * that brought widgets, then System last: the first cut trimmed the whole
 * list and lost the health tab on any instance with enough modules, exactly
 * the tab that must stay reachable because it is where somebody looks when
 * the instance itself is what is wrong.
 *
 * Built from the widgets this reader may actually have, so a Free default
 * has no ledger charts on it and a bookkeeperless reader has no Reports tab
 * — a tab of panels that all refuse is worse than no tab.
 */
const core = (id: string) => scopedId("dashboard", id);
export const CORE_TABS: Tab[] = [
  {
    name: "Overview",
    widgets: [
      core("money"),
      core("attention"),
      core("pipeline"),
      core("invoice-aging"),
    ],
  },
  {
    name: "Performance",
    widgets: [
      core("revenue-trend"),
      core("cash-position"),
      core("top-customers"),
    ],
  },
  { name: "Sales", widgets: [core("deals-by-stage"), core("pipeline")] },
  {
    name: "Reports",
    widgets: [
      core("who-owes"),
      core("balance-sheet"),
      core("cash-flow"),
      core("trial-balance"),
    ],
  },
];

export function defaultLayout(visible: RegisteredWidget[]): Tab[] {
  const keys = new Set(visible.map((w) => w.key));
  const coreTabs = CORE_TABS.map((tab) => ({
    name: tab.name,
    widgets: tab.widgets.filter((w) => keys.has(w)),
  })).filter((tab) => tab.widgets.length > 0);
  const modules = moduleTabs(visible.filter((w) => w.moduleId !== "dashboard"));
  const system = keys.has(core("health"))
    ? [{ name: "System", widgets: [core("health")] }]
    : [];
  return [
    ...coreTabs,
    // Trimmed here so it is a module that is dropped when there are too
    // many, never System.
    ...modules.slice(0, MAX_TABS - coreTabs.length - system.length),
    ...system,
  ];
}

/**
 * One tab per module, named what the module called its first widget — which
 * for a module with one panel is the module's own name, the common case.
 */
function moduleTabs(widgets: RegisteredWidget[]): Tab[] {
  const groups = new Map<string, RegisteredWidget[]>();
  for (const w of widgets) {
    const group = groups.get(w.moduleId);
    if (group) group.push(w);
    else groups.set(w.moduleId, [w]);
  }
  return [...groups.values()].map((group) => ({
    name: group[0]?.label ?? "Module",
    widgets: group.map((w) => w.key),
  }));
}

/**
 * Whatever was sent, turned into something safe to store.
 *
 * An id is kept if it is shaped like one, not only if a module declares it
 * right now: a licence that lapses and is renewed, or a module switched off
 * for a week, should find its panel where it was left rather than having
 * been quietly deleted from the layout while it was away. Nothing stored is
 * ever shown on that strength alone — `shownTabs` filters every response to
 * what the reader may have.
 *
 * An empty result means "nothing worth storing"; the caller treats it as a
 * reset, because a layout with no tabs is a blank screen with no way back.
 */
export function normalizeLayout(input: unknown): Tab[] {
  if (!Array.isArray(input)) return [];

  const tabs: Tab[] = [];
  for (const raw of input.slice(0, MAX_TABS)) {
    if (!raw || typeof raw !== "object") continue;
    const tab = raw as { name?: unknown; widgets?: unknown };
    const name =
      typeof tab.name === "string" && tab.name.trim()
        ? tab.name.trim().slice(0, 40)
        : `Tab ${tabs.length + 1}`;
    const widgets = Array.isArray(tab.widgets)
      ? tab.widgets
          .filter(
            (w): w is string => typeof w === "string" && WIDGET_ID.test(w),
          )
          .slice(0, MAX_WIDGETS_PER_TAB)
      : [];
    tabs.push({ name, widgets });
  }
  return tabs;
}

/**
 * A stored arrangement, cut down to what this reader may be shown.
 *
 * This is the whole of the non-disclosure rule: whatever is stored, a
 * response only ever names widgets the reader's licence and permissions
 * cover. A tab left empty by the cut is kept — the business named it.
 */
export function shownTabs(tabs: Tab[], visible: Set<string>): Tab[] {
  return tabs.map((tab) => ({
    name: tab.name,
    widgets: tab.widgets.filter((w) => visible.has(w)),
  }));
}

/**
 * A module bought on day 200 reaches the screen on day 200.
 *
 * The business arranged its tabs long ago; a widget that was in nobody's
 * arrangement gets a tab of its own, exactly as the default would have given
 * it. `known` is every widget the business has been shown an arrangement
 * for — a widget in it and on no tab was removed on purpose, and stays
 * removed.
 */
export function withArrivals(
  tabs: Tab[],
  known: string[],
  visible: RegisteredWidget[],
): Tab[] {
  const placed = new Set(tabs.flatMap((t) => t.widgets));
  const seen = new Set(known);
  const arrivals = visible.filter(
    (w) => !placed.has(w.key) && !seen.has(w.key),
  );
  if (arrivals.length === 0) return tabs;
  // ponytail: a Pro licence arriving after a save lands all its dashboard
  // widgets in one appended tab named after the first; arranging fixes it in
  // one visit, and anything cleverer needs to know tabs it cannot see.
  return [...tabs, ...moduleTabs(arrivals)].slice(0, MAX_TABS);
}

/**
 * An arrangement saved before widget keys were scoped by module.
 *
 * Widgets used to be addressed by the module's own bare word — `money`,
 * `health`, `summary:shop` — which is exactly what two modules could both
 * choose. They are addressed as `moduleId:id` now, and every dashboard
 * arranged before today is stored in the old spelling: read literally, every
 * tab would filter down to nothing and a business that spent an afternoon
 * arranging its screen would find it blank.
 *
 * So a stored entry that is not a key is looked up as a bare id and rewritten
 * to the key of the widget that answers to it. The first match wins, which is
 * the honest reading of the old data: under the old registry a duplicate
 * silently replaced, so a stored bare id only ever referred to one panel
 * anyway. Anything that matches nothing is left exactly as it was — a module
 * switched off or whose licence lapsed keeps its place, which is the rule the
 * rest of this file already follows.
 *
 * Upgraded on read and written back in the new spelling by the next save, so
 * there is no migration to run and no moment where a layout is half converted.
 */
export function upgradeWidgetIds(
  entries: string[],
  declared: RegisteredWidget[],
): string[] {
  const keys = new Set(declared.map((w) => w.key));
  const byBareId = new Map<string, string>();
  for (const w of declared) if (!byBareId.has(w.id)) byBareId.set(w.id, w.key);
  return entries.map((entry) =>
    keys.has(entry) ? entry : (byBareId.get(entry) ?? entry),
  );
}

interface Stored {
  tabs: Tab[];
  known: string[];
}

export async function readStored(
  organizationId: string,
): Promise<Stored | null> {
  const [row] = await db
    .select({ value: schema.organizationPreferences.value })
    .from(schema.organizationPreferences)
    .where(
      and(
        eq(schema.organizationPreferences.organizationId, organizationId),
        eq(schema.organizationPreferences.key, "dashboard"),
      ),
    )
    .limit(1);
  if (!row) return null;

  const stored = row.value as { tabs?: unknown; known?: unknown };
  const tabs = normalizeLayout(stored?.tabs);
  if (tabs.length === 0) return null;
  const known = Array.isArray(stored?.known)
    ? stored.known.filter((k): k is string => typeof k === "string")
    : [];
  // Anything saved before widgets were keyed by module, brought forward.
  const declared = declaredWidgets();
  return {
    tabs: tabs.map((tab) => ({
      name: tab.name,
      widgets: upgradeWidgetIds(tab.widgets, declared),
    })),
    known: upgradeWidgetIds(known, declared),
  };
}

export async function writeStored(
  organizationId: string,
  tabs: Tab[],
  known: string[],
): Promise<void> {
  const value = { tabs, known: known.slice(-MAX_KNOWN) };
  await db
    .insert(schema.organizationPreferences)
    .values({ organizationId, key: "dashboard", value })
    // Saving twice is the normal case — every rearrange is a save.
    .onConflictDoUpdate({
      target: [
        schema.organizationPreferences.organizationId,
        schema.organizationPreferences.key,
      ],
      set: { value, updatedAt: new Date() },
    });
}

/** An empty save resets rather than empties. */
export async function clearStored(organizationId: string): Promise<void> {
  await db
    .delete(schema.organizationPreferences)
    .where(
      and(
        eq(schema.organizationPreferences.organizationId, organizationId),
        eq(schema.organizationPreferences.key, "dashboard"),
      ),
    );
}
