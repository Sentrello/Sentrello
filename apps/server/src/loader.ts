import type { ModuleJob } from "@sentrello/jobs";
import type {
  EntitlementNeed,
  SentrelloEnv,
  SentrelloModule,
  SentrelloSession,
} from "@sentrello/module-sdk";
import { addSummary, clearSummaries } from "@sentrello/module-sdk";
import type { Hono } from "hono";

export function loadModules(
  app: Hono<SentrelloEnv>,
  entitled: (need: EntitlementNeed) => boolean,
  modules: SentrelloModule[],
) {
  // The nav id is the module's choice and need not match its module id —
  // `scheduling` registers a "Booking" entry — so each item carries the module
  // it came from, which is what the browser needs to fetch its screens.
  const nav: {
    id: string;
    label: string;
    order?: number;
    moduleId: string;
    /** The rail section this belongs to. */
    group?: string;
    /** The entry it nests under, for modules with several screens. */
    parent?: string;
    /** Icon name for the rail and the panel. */
    icon?: string;
  }[] = [];
  // Kept apart from `nav` deliberately: a predicate cannot be serialised, and
  // the nav array is handed to the browser as it stands.
  const navVisibility = new Map<string, (s: SentrelloSession) => boolean>();
  /** What each entry's screen needs, for `/api/_meta` to filter by role. */
  const navPermissions = new Map<string, Record<string, string[]>>();
  // Which module each nav entry belongs to, and what tier that module is.
  // Optional modules are the only ones a business turns on and off — the Free
  // ones are the product, not a purchase.
  const tiers = new Map<string, SentrelloModule["tier"]>();
  const permissions: string[] = [];
  const jobs: ModuleJob[] = [];
  const loaded = new Set<string>();
  // The boot tests load modules more than once in one process, and a summary
  // registered by a run that is over would be drawn by the next one.
  clearSummaries();

  // simple dependency-aware pass; repeat until no progress
  let progress = true;
  while (progress) {
    progress = false;
    for (const m of modules) {
      if (loaded.has(m.id)) continue;
      const tierOk =
        m.tier === "free" ||
        (m.tier === "pro" && entitled({ tier: "pro" })) ||
        (m.tier === "module" && entitled({ module: m.id }));
      const depsOk = (m.requires ?? []).every((d) => loaded.has(d));
      // A module may decline the host itself — ours do, on the flag that says
      // which machine this is. Checked before anything is registered, so a
      // declined module has no tables, no screens and no place in /healthz.
      if (!tierOk || !depsOk || m.available?.() === false) continue;
      m.register({
        app,
        entitled,
        registerNav: ({ visibleTo, requires, ...i }) => {
          nav.push({ ...i, moduleId: m.id });
          if (visibleTo) navVisibility.set(i.id, visibleTo);
          if (requires) navPermissions.set(i.id, requires);
        },
        registerPermission: (p) => permissions.push(p),
        registerSummary: (summary) =>
          addSummary({ ...summary, moduleId: m.id }),
        // namespaced: two modules may both want a job called "reminders"
        registerJob: (j) => jobs.push({ ...j, name: `${m.id}:${j.name}` }),
      });
      tiers.set(m.id, m.tier);
      loaded.add(m.id);
      progress = true;
    }
  }
  nav.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return {
    nav,
    navVisibility,
    navPermissions,
    tiers,
    permissions,
    jobs,
    loaded: [...loaded],
  };
}
