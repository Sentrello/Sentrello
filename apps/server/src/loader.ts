import type { ModuleJob } from "@sentrello/jobs";
import type {
  EntitlementNeed,
  SentrelloEnv,
  SentrelloModule,
  SentrelloSession,
} from "@sentrello/module-sdk";
import { addPersonalData } from "@sentrello/module-sdk";
import {
  addAccountSection,
  addComputedColumns,
  addCrawlable,
  addOnboarding,
  addPaymentWebhook,
  addSearchProvider,
  addSummary,
  addWidget,
  clearAccountSections,
  clearComputedColumns,
  clearOnboarding,
  clearPaymentWebhooks,
  clearServices,
  clearSummaries,
  clearWidgets,
  provideService,
} from "@sentrello/module-sdk";
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
  clearWidgets();
  clearAccountSections();
  clearOnboarding();
  clearPaymentWebhooks();
  clearComputedColumns();
  /*
   * And what one module offers another. The boot tests load modules more than
   * once in a process, and a host's functions left behind by a run that is over
   * would be handed to a plugin in the next one — which is worse than missing,
   * because they close over the previous run's state.
   */
  clearServices();

  /** Entitled and held back by a dependency, as the passes go round. */
  const blocked = new Map<string, string[]>();

  // simple dependency-aware pass; repeat until no progress
  let progress = true;
  while (progress) {
    progress = false;
    for (const m of modules) {
      if (loaded.has(m.id)) continue;
      /*
       * A module that comes free with another is entitled when that one is.
       *
       * The till is the case: free for anybody who has bought Shop. Without
       * this it would need its own entry in every licence token, and the day
       * one was signed without it a paying customer would quietly lose a
       * feature they were told came with what they bought.
       */
      const licensed =
        entitled({ module: m.id }) ||
        (m.includedWith !== undefined && entitled({ module: m.includedWith }));
      const tierOk =
        m.tier === "free" ||
        (m.tier === "pro" && entitled({ tier: "pro" })) ||
        (m.tier === "module" && licensed);
      const depsOk = (m.requires ?? []).every((d) => loaded.has(d));
      // A module may decline the host itself — ours do, on the flag that says
      // which machine this is. Checked before anything is registered, so a
      // declined module has no tables, no screens and no place in /healthz.
      const declined = m.available?.() === false;
      /*
       * Entitled, willing, and held back only by something it depends on.
       *
       * Tracked rather than worked out afterwards, because afterwards cannot
       * tell the two apart: a module absent for want of a licence is correctly
       * absent and its dependencies are beside the point, while one that is
       * paid for and still missing is a fault. Reporting both would fill a
       * Free instance's health check with modules it never bought.
       */
      if (tierOk && !declined && !depsOk) blocked.set(m.id, m.requires ?? []);
      if (!tierOk || !depsOk || declined) continue;
      blocked.delete(m.id);
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
        // One dashboard panel, declared individually. The dashboard arranges
        // whatever this instance's modules registered, and gates each widget
        // by its own entitlement and permission before offering it.
        registerWidget: (widget) => addWidget({ ...widget, moduleId: m.id }),
        // One section of the unified customer account page, declared
        // individually like a widget. Gated the same two ways: entitlement
        // decides whether it exists at all, `hasAny` whether this customer's
        // page ever mentions it.
        registerAccountSection: (section) =>
          addAccountSection({ ...section, moduleId: m.id }),
        // That this module listens to a payment processor. One endpoint per
        // provider, offered to whatever declared itself — rather than a path
        // written into the connection screen naming one module, which is how
        // an invoice paid by card was confirmed by nobody.
        registerPaymentWebhook: (consumer) =>
          addPaymentWebhook({ ...consumer, moduleId: m.id }),
        // What somebody has to do before this module is any use. Drawn as a
        // checklist of whatever this instance loaded.
        registerOnboarding: (guide) =>
          addOnboarding({ ...guide, moduleId: m.id }),
        // A path prefix a search engine may follow. Almost nothing here is
        // one: robots.txt refuses everything and a module that genuinely
        // publishes pages says which.
        registerCrawlable: (surface) =>
          addCrawlable({ ...surface, moduleId: m.id }),
        // What this module can find, for the box that searches everything.
        registerSearch: (provider) =>
          addSearchProvider({ ...provider, moduleId: m.id }),
        // What a host offers the plugins that require it. A plugin cannot
        // import its host, so this is how it reaches one.
        provide: (name, value) => provideService(name, value),
        // What this module holds about a person. A subject access or erasure
        // request runs whatever is registered here, so a module loaded on this
        // instance answers and one that is not contributes nothing — which is
        // the correct answer rather than a gap.
        registerPersonalData: (source) =>
          addPersonalData({ ...source, moduleId: m.id }),
        // Columns a module works out on records Core owns. Core builds every
        // list from one factory and cannot name the modules that would add to
        // it, so each says what it can add and the factory asks whatever this
        // instance loaded.
        registerComputedColumns: (provider) =>
          addComputedColumns({ ...provider, moduleId: m.id }),
        // namespaced: two modules may both want a job called "reminders"
        registerJob: (j) => jobs.push({ ...j, name: `${m.id}:${j.name}` }),
      });
      tiers.set(m.id, m.tier);
      loaded.add(m.id);
      progress = true;
    }
  }
  /**
   * A module that was entitled, installed, and never loaded anyway.
   *
   * The loop above repeats until it stops making progress, and anything still
   * unloaded is then dropped in silence. That silence hid three modules for
   * weeks: `invoicing` and `accounting` stopped being modules of their own when
   * they merged into `money`, and everything that named them as a dependency —
   * `pro-core`, and the Shop, and the POS behind the Shop — could no longer be
   * satisfied. Each was bought, installed, entitled and simply absent, with
   * nothing anywhere saying why.
   *
   * A missing dependency is the one failure the loader can describe exactly, so
   * it says which module wanted what. Reported rather than thrown: an instance
   * that can run most of itself should.
   */
  const unmet: { name: string; reason: string }[] = [];
  for (const [id, requires] of blocked) {
    if (loaded.has(id)) continue;
    const missing = requires.filter((d) => !loaded.has(d));
    if (missing.length === 0) continue;
    unmet.push({
      name: id,
      reason: `it needs ${missing.join(" and ")}, which this instance did not load`,
    });
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
    /*
     * Returned rather than pushed into the host's own list of failures.
     *
     * That list is module scope and outlives a call — so a loader test with a
     * fixture that has an unmet dependency, which is a thing the loader is
     * supposed to do, left a phantom module in the next test's health check.
     * The caller owns reporting; this only answers what happened.
     */
    unmet,
  };
}
