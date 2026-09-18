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
  addRetention,
  addSearchProvider,
  addSummary,
  addWidget,
  clearAccountSections,
  clearComputedColumns,
  clearCrawlable,
  clearOnboarding,
  clearPaymentWebhooks,
  clearPersonalData,
  clearRetention,
  clearSearchProviders,
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
  clearRetention();
  /*
   * And the three that were left to whichever test file remembered.
   *
   * Each outlives a load, so a module the licence stopped granting went on
   * answering the search box and a subject access request, and went on keeping
   * its prefix out of the `noindex` header this instance puts on everything it
   * has not published. Search was the loud one — it deduplicates nothing, so a
   * second load in one process gave every provider a second voice and the box
   * answered each hit twice.
   */
  clearSearchProviders();
  clearCrawlable();
  clearPersonalData();
  /*
   * And what one module offers another. The boot tests load modules more than
   * once in a process, and a host's functions left behind by a run that is over
   * would be handed to a plugin in the next one — which is worse than missing,
   * because they close over the previous run's state.
   */
  clearServices();

  /** Entitled and held back by a dependency, as the passes go round. */
  const blocked = new Map<string, string[]>();
  /**
   * What did not load for a reason that is nobody's licence.
   *
   * Reported through `unmet` beside the missing dependencies, because from a
   * business's side they are one fault: a module that was paid for and is not
   * there.
   */
  const broke: { name: string; reason: string }[] = [];
  /** Tried once and threw. Remembered, or the next pass would try it again. */
  const failed = new Set<string>();

  // simple dependency-aware pass; repeat until no progress
  let progress = true;
  while (progress) {
    progress = false;
    for (const m of modules) {
      if (failed.has(m.id)) continue;
      if (loaded.has(m.id)) {
        /*
         * Two modules claiming one id.
         *
         * The first one wins and this skips the rest, which is the right
         * answer — a module whose routes are registered twice is answered by
         * whichever won the race, and half-working is worse to diagnose than
         * dark. What was wrong is that it happened in silence: a renamed
         * bundle the installer left behind, or a module that copied another's
         * id, took a paid feature away with nothing anywhere naming it.
         *
         * Only when it really is a second object: the loop passes over an
         * already-loaded module every round.
         */
        if (modules.indexOf(m) !== modules.findIndex((o) => o.id === m.id)) {
          failed.add(m.id);
          broke.push({
            name: m.id,
            reason:
              "another module on this instance already claims that id, and only the first was loaded",
          });
        }
        continue;
      }
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
      /*
       * How far the host's own lists had got before this module spoke.
       *
       * A module that registers a nav entry and then throws leaves a sidebar
       * item pointing at a module that is not there — a door onto nothing,
       * which this repository has shipped twice by other means. Its routes
       * cannot be taken back (Hono has no way to unregister one) and neither
       * can the shared registries, but both are gated: a route belonging to a
       * module nobody loaded is still behind its own permission, and a widget
       * that cannot count itself is dropped from the dashboard. The nav is the
       * one somebody is *offered*.
       */
      const before = {
        nav: nav.length,
        permissions: permissions.length,
        jobs: jobs.length,
      };
      try {
        m.register({
          app,
          entitled,
          registerNav: ({ visibleTo, requires, ...i }) => {
            /*
             * The one id here that cannot be scoped by module: it is the URL
             * a person bookmarks and the key the browser matches a screen
             * against. So a second claimant is refused rather than quietly
             * allowed to replace — and replace is what it did: `visibleTo`
             * and `requires` are keyed by this id, so a module choosing a
             * word another had taken did not merely add a second door, it
             * took the first one's permission gate off and offered its screen
             * to everybody.
             *
             * Said out loud, with both modules named, because a nav entry
             * that is simply missing is the kind of failure nobody can trace
             * back to a name two authors happened to agree on.
             */
            const taken = nav.find((entry) => entry.id === i.id);
            if (taken) {
              console.error(
                `[modules] ${m.id} registered the nav entry "${i.id}", which ${taken.moduleId} already has. It is a URL, so it cannot be shared: one of the two modules has to rename its entry. ${m.id}'s is not being offered.`,
              );
              return;
            }
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
          // How long this module's own logs are kept. A log is the one kind of
          // table that only ever grows and nobody on a self-hosted instance is
          // watching the disk; the module says what it keeps, the platform does
          // the sweeping, and no policy can name a statutory record.
          registerRetention: (policy) =>
            addRetention({ ...policy, moduleId: m.id }),
          // namespaced: two modules may both want a job called "reminders"
          registerJob: (j) => jobs.push({ ...j, name: `${m.id}:${j.name}` }),
        });
      } catch (err) {
        /*
         * `register` runs at boot, in module scope, before the server listens.
         * An exception here used to be not one module missing but no
         * application at all — no sign-in, no invoicing, nothing — on a box the
         * business it belongs to cannot shell into. The migration loop below
         * settled this argument already: a module whose schema failed must not
         * take the whole instance down. Registration is the same argument one
         * step earlier, and a bundle built in another repository is exactly
         * where the surprise arrives.
         */
        nav.length = before.nav;
        permissions.length = before.permissions;
        jobs.length = before.jobs;
        failed.add(m.id);
        broke.push({
          name: m.id,
          reason: `it failed while starting up: ${(err as Error).message}`,
        });
        console.error(`[modules] ${m.id} failed while starting up`, err);
        continue;
      }
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
  const unmet: { name: string; reason: string }[] = [...broke];
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
