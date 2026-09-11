import { Hono, type MiddlewareHandler } from "hono";
import type { Context, Next } from "hono";
import { createMiddleware } from "hono/factory";

export type Tier = "free" | "pro" | "module";

/** What a running module can ask about the instance's entitlement. */
export interface EntitlementNeed {
  tier?: "pro";
  module?: string;
}

/**
 * The parts of a session every module relies on. Structural on purpose: the SDK
 * is the public contract and must not depend on the auth package (auth depends
 * on the SDK, never the reverse).
 */
export interface SentrelloSession {
  session: {
    /** The row id, so a screen can tell which session is the one in front of you. */
    id: string;
    activeOrganizationId?: string | null;
    userId: string;
  };
  user: { id: string; email?: string | null; name?: string | null };
}

/** The Hono environment the host app and every module route share. */
export type SentrelloEnv = { Variables: { session: SentrelloSession } };

/** The host's app type. Modules take this rather than importing `hono`. */
export type SentrelloApp = Hono<SentrelloEnv>;

/** Middleware bound to the host's environment, so modules need no `hono` dep. */
export function defineMiddleware(
  handler: MiddlewareHandler<SentrelloEnv>,
): MiddlewareHandler<SentrelloEnv> {
  return createMiddleware<SentrelloEnv>(handler);
}

export interface ModuleContext {
  app: Hono<SentrelloEnv>;
  /** True if the instance's license satisfies `need`. */
  entitled: (need: EntitlementNeed) => boolean;
  registerNav: (item: {
    id: string;
    label: string;
    order?: number;
    /**
     * Which section of the sidebar this belongs under.
     *
     * The nav was a flat list, which is a large part of why the application
     * reads as unrelated parts: fifteen equal items say nothing about a
     * contact leading to a quote leading to an invoice. A section says at
     * least that they belong to the same piece of work.
     *
     * Free text rather than a fixed set, so a module can name a section the
     * host has never heard of. Anything without one sits at the top level.
     */
    group?: string;
    /**
     * The entry this one sits under, by id.
     *
     * The sidebar has two levels: a rail of sections, and inside a section a
     * list of modules, each of which may expand into its own pages. A module
     * with several screens — the CRM has five — registers one parent entry and
     * its pages against it, rather than spilling five siblings into the
     * section and burying every other module.
     *
     * A parent is not a screen. Opening one opens its first child, because a
     * heading that goes nowhere when clicked is a heading people click twice.
     */
    parent?: string;
    /**
     * Which icon to draw, by name.
     *
     * The rail is icons alone, so a section without one is a blank square. The
     * host maps the name; an unknown one falls back rather than failing, since
     * a module built against a later host must not break an earlier one.
     */
    icon?: string;
    /**
     * The permission this entry's screen needs.
     *
     * The routes behind it are guarded regardless; this decides whether
     * somebody is offered the door at all. A staff member who can see
     * Settings in the sidebar, clicks it, and is refused has been told twice
     * that they cannot do their job — once by the error, and once by the menu
     * that suggested otherwise.
     */
    requires?: Record<string, string[]>;
    /**
     * Who is offered this entry, when "everybody who can load the module" is
     * the wrong answer.
     *
     * The loader decides whether a module runs at all; this decides whether a
     * person is shown the way in. Most modules need neither — a business's own
     * staff all see Invoices. It exists for entries whose audience is narrower
     * than the instance: an allow-list held in the environment rather than in
     * any role a business can grant.
     *
     * Not a security boundary. The routes are still guarded; this only stops
     * offering somebody a door that will not open.
     */
    visibleTo?: (session: SentrelloSession) => boolean;
  }) => void;
  registerPermission: (permission: string) => void;
  /**
   * Background work. The name is namespaced with the module id by the host, so
   * `reminders` is safe even if another module wants the same word. Without a
   * `cron` the queue exists but only runs when something sends to it.
   */
  /**
   * A few figures about this module, for the dashboard.
   *
   * The dashboard cannot name a module it does not import — Shop and Booking
   * are in another repository — so each module says what it is worth showing
   * and the dashboard draws whatever is registered.
   */
  registerSummary: (summary: ModuleSummary) => void;
  /**
   * What this module holds about a person, and what it can do about it.
   *
   * A subject access or erasure request arrives once and every module has to
   * answer it. Core cannot name the modules in other repositories, so each says
   * what it holds and Core runs whatever this instance loaded.
   *
   * A module that stores anything identifying a person — a name, an email, an
   * address, an IP — registers one of these. A module that stores none does
   * not, and its absence is the honest answer.
   */
  registerPersonalData: (source: PersonalDataSource) => void;

  /**
   * What this module can find, for the box that searches everything.
   *
   * The commonest thing somebody does after looking at today's figures is look
   * for one particular thing, and every list screen filtering itself only helps
   * if you are already on the right screen. A module says what it can find;
   * Core asks whatever this instance loaded and puts the answers in one list.
   */
  registerSearch: (provider: SearchProvider) => void;

  /**
   * Offer something to the modules that require this one.
   *
   * A plugin cannot import its host — a bundle ships alone and the container
   * links only the platform's packages — so a host that wants to be built on
   * offers its own functions here, and the plugin asks for them by name with
   * `moduleService`. `requires` guarantees the host has registered before the
   * plugin can ask.
   */
  provide: (name: string, value: unknown) => void;
  registerJob: (job: {
    name: string;
    cron?: string;
    /**
     * Also run it once when the instance starts.
     *
     * For work a new install needs before its schedule comes round. It goes
     * through the queue like any other run, so a failure is retried and never
     * reaches the boot path.
     */
    runAtBoot?: boolean;
    handler: () => Promise<unknown>;
  }) => void;
}

/**
 * A module's own tables.
 *
 * Each module keeps its migrations to itself, tracked in its own table, so
 * installing or removing a module never disturbs another's history. The host
 * applies them at boot for modules the licence actually loads.
 */
export interface ModuleMigrations {
  /** absolute path to the drizzle output folder, usually `${import.meta.dir}/../drizzle` */
  dir: string;
  /** the module's own migrations table, e.g. `__drizzle_migrations_time_tracking` */
  table: string;
}

/** Every Free, Pro, and optional module implements exactly this. */
export interface SentrelloModule {
  id: string;
  tier: Tier;
  /** ids of modules that must load first */
  requires?: string[];
  migrations?: ModuleMigrations;
  /**
   * Absolute path to this module's prebuilt browser screens, if it has any.
   *
   * The module names the file itself — `${import.meta.dir}/../ui/index.js` —
   * because the same code runs from a linked checkout in development and from
   * an unpacked bundle in production, and only the module knows where its own
   * files are. The host serves it at `/modules/<id>/ui.js`, and only while the
   * module is loaded: a screen for a feature the licence does not grant is
   * never served, not merely hidden.
   *
   * The file is built, not source. Customers' servers have no build tools.
   */
  ui?: string;
  /**
   * Whether this module belongs on this host at all.
   *
   * The licence decides what a business has bought. This decides something the
   * licence cannot express: that a module is Sentrello's own and runs on one
   * machine — Master, and the SubShop we sell our own subscriptions from.
   *
   * Refusing inside `register` is not enough. A module that loads and
   * registers nothing still has its tables migrated and its screens served,
   * and still appears in `/healthz` as loaded — so an instance that must never
   * have it would quietly grow its tables. Declining here means it was never
   * loaded, which is the claim we actually want to make.
   *
   * Absent means yes, which is what every module a customer buys should say.
   */
  available?: () => boolean;
  register(ctx: ModuleContext): void;
}

import { type PersonalDataSource, addPersonalData } from "./personal-data";
import { type SearchProvider, addSearchProvider } from "./search";
import { provideService } from "./services";
import { type ModuleSummary, addSummary } from "./summaries";

export * from "./attachments";
export * from "./search";
export * from "./csv";
export * from "./images";
export * from "./public-endpoints";
/**
 * Read from disk, so it is imported by tests rather than by a running
 * instance. Exported from here because Core's modules and the commercial ones
 * have the same shape of hole, and a second copy is a copy that gets the
 * matching subtly wrong in one repository only.
 */
export * from "./reachability";
export * from "./unregistered";
/**
 * Bank connections. Kept beside the payment processors because it is the same
 * argument: one contract, two providers, and the credentials belong to the
 * business rather than to us.
 */
export * as banking from "./banking";
export * as secrets from "./secrets";
export * from "./stripe-signature";
export * from "./summaries";
export * from "./personal-data";
export * from "./unread-fields";

/**
 * The context a route handler receives.
 *
 * Exported because TypeScript stops inferring it once a module registers
 * enough routes, and a module cannot name the type itself without depending on
 * Hono directly — which the bundle contract does not allow, since the
 * container links only this small set of packages.
 */
export type RouteContext = Context<SentrelloEnv>;

/**
 * Handing the request on instead of answering it.
 *
 * For the same reason `RouteContext` is here: a bundle cannot import Hono, so
 * a handler that wants to decline — "this path is not mine after all" — has no
 * way to say so without this. Declining matters most for a route registered at
 * the root: `/:key` matches every single-segment path on the instance, and a
 * handler that answers 404 rather than passing on takes `/healthz` away from
 * the server that registered it first.
 */
export type { Next };

export function defineModule(m: SentrelloModule): SentrelloModule {
  return m;
}

/**
 * A host-shaped Hono app. Modules use this instead of depending on `hono`
 * themselves — a second copy of the framework gives structurally identical but
 * nominally incompatible generics, exactly like a second copy of the ORM.
 * Mainly useful for testing a module in isolation.
 */
export function createModuleApp(): Hono<SentrelloEnv> {
  return new Hono<SentrelloEnv>();
}

/** Registers a module against a bare app, with entitlement forced on. */
export function registerForTest(
  module: SentrelloModule,
  app: Hono<SentrelloEnv> = createModuleApp(),
  /**
   * What the licence is pretending to allow.
   *
   * Entitled to everything by default, which is what a module's own tests
   * want. Overridable because a module that behaves differently on Free than
   * on Pro — the dashboard does — has no way to test the Free half otherwise,
   * and the Free half is the one every new instance sees.
   */
  entitled: (need: EntitlementNeed) => boolean = () => true,
  /**
   * Parts of the context a test wants to watch rather than ignore.
   *
   * Nav entries and jobs are dropped on the floor by default, which is what a
   * route test wants. But a module's nav and its screens are built into
   * different artefacts — the routes are TypeScript the host imports, the
   * screens are a bundle the browser fetches — so nothing checks that a nav
   * entry has anything behind it. An id that does not match renders a blank
   * panel, which is indistinguishable from a broken one, and two modules have
   * shipped a door onto nothing that way.
   *
   * Passing `registerNav` here is how a module tests its own rail against its
   * own bundle.
   */
  overrides: Partial<
    Pick<ModuleContext, "registerNav" | "registerPermission" | "registerJob">
  > = {},
): Hono<SentrelloEnv> {
  module.register({
    app,
    entitled,
    registerNav: () => {},
    registerPermission: () => {},
    // Registered for real, so a module's own tests can assert its figures.
    registerSummary: (summary) =>
      addSummary({ ...summary, moduleId: module.id }),
    registerSearch: (provider) =>
      addSearchProvider({ ...provider, moduleId: module.id }),
    // Registered for real, like summaries, so a module's own tests can ask it
    // what it would hand over about somebody.
    provide: (name, value) => provideService(name, value),
    registerPersonalData: (source) =>
      addPersonalData({ ...source, moduleId: module.id }),
    registerJob: () => {},
    ...overrides,
  });

  /**
   * The host's own answer to a refusal, so a module's tests see what its users
   * will.
   *
   * Some rules are enforced far below the route that tripped them — the
   * period lock lives inside `postJournalEntry`, several calls down — and the
   * host answers those with the status the error names rather than 500. A
   * harness without this reports a working rule as a crash, and the test
   * written against it either asserts the wrong status or quietly stops
   * covering the rule.
   *
   * The number is read off the error rather than matched against a list of
   * classes, so this package keeps its one dependency and any future refusal
   * works the same way by saying so.
   */
  app.onError((err, c) => {
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      return c.json({ error: err.message }, status as 400);
    }
    // Everything else keeps the answer the host gives it, 500 included: a
    // harness that rethrows turns a route's crash into a rejected request and
    // a sweep asking every route for its status gets an exception instead.
    console.error(err);
    return c.json({ error: "something went wrong" }, 500);
  });

  return app;
}
export * from "./custom-fields";
export * from "./services";
export * from "./payments/provider";
export * from "./payments/stripe";
export * from "./payments/paypal";
