import { db, schema } from "@sentrello/db";
import type { ModuleWidget, RegisteredWidget } from "@sentrello/module-sdk";
import { allSummaries, allWidgets } from "@sentrello/module-sdk";
import { and, eq } from "drizzle-orm";

/**
 * The tabs, and what is on them.
 *
 * The dashboard arranges widgets modules declared — it holds no list of its
 * own. What it adds is the arranging: tabs the business names, a default
 * good enough that most businesses never touch it, and the discipline that
 * nothing is ever named to a reader whose licence or permission does not
 * cover it. Arranging is not a paid feature (James, 2026-09-13): Free and
 * Pro get the same screen, and Free additionally carries the promo block.
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
const needsPro = { tier: "pro" as const };
const needsReports = { reports: ["read"] };
export const CORE_WIDGETS: ModuleWidget[] = [
  { id: "money", label: "Money owed" },
  { id: "attention", label: "Needs attention" },
  { id: "pipeline", label: "Pipeline" },
  { id: "health", label: "This server", icon: "gauge" },
  // The twelve-month ledger charts: what a Pro licence buys.
  { id: "revenue-trend", label: "Income and expenses", entitlement: needsPro },
  { id: "cash-position", label: "Profit trend", entitlement: needsPro },
  { id: "deals-by-stage", label: "Deals by stage", entitlement: needsPro },
  { id: "top-customers", label: "Top customers", entitlement: needsPro },
  {
    id: "invoice-aging",
    label: "How late the money is",
    entitlement: needsPro,
  },
  // The reports, drawn from the ledger; a reader needs the books.
  { id: "balance-sheet", label: "Balance sheet", requires: needsReports },
  { id: "cash-flow", label: "Cash in and out", requires: needsReports },
  { id: "trial-balance", label: "Trial balance", requires: needsReports },
  {
    id: "who-owes",
    label: "Who owes you",
    requires: needsReports,
    entitlement: needsPro,
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
  const ids = new Set(declared.map((w) => w.id));
  const bridged = allSummaries()
    .map((s) => ({
      id: `summary:${s.id}`,
      label: s.label,
      icon: s.icon,
      opens: s.opens,
      requires: s.requires,
      load: s.load,
      moduleId: s.moduleId,
    }))
    .filter((w) => !ids.has(w.id));
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
const WIDGET_ID = /^[a-z0-9][a-z0-9-]{0,63}(:[a-z0-9][a-z0-9-]{0,63})?$/;

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
const CORE_TABS: Tab[] = [
  {
    name: "Overview",
    widgets: ["money", "attention", "pipeline", "invoice-aging"],
  },
  {
    name: "Performance",
    widgets: ["revenue-trend", "cash-position", "top-customers"],
  },
  { name: "Sales", widgets: ["deals-by-stage", "pipeline"] },
  {
    name: "Reports",
    widgets: ["who-owes", "balance-sheet", "cash-flow", "trial-balance"],
  },
];

export function defaultLayout(visible: RegisteredWidget[]): Tab[] {
  const ids = new Set(visible.map((w) => w.id));
  const core = CORE_TABS.map((tab) => ({
    name: tab.name,
    widgets: tab.widgets.filter((w) => ids.has(w)),
  })).filter((tab) => tab.widgets.length > 0);
  const modules = moduleTabs(visible.filter((w) => w.moduleId !== "dashboard"));
  const system = ids.has("health")
    ? [{ name: "System", widgets: ["health"] }]
    : [];
  return [
    ...core,
    // Trimmed here so it is a module that is dropped when there are too
    // many, never System.
    ...modules.slice(0, MAX_TABS - core.length - system.length),
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
    widgets: group.map((w) => w.id),
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
  const arrivals = visible.filter((w) => !placed.has(w.id) && !seen.has(w.id));
  if (arrivals.length === 0) return tabs;
  // ponytail: a Pro licence arriving after a save lands all its dashboard
  // widgets in one appended tab named after the first; arranging fixes it in
  // one visit, and anything cleverer needs to know tabs it cannot see.
  return [...tabs, ...moduleTabs(arrivals)].slice(0, MAX_TABS);
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
  return { tabs, known };
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
