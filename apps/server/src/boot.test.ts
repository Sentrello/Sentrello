import { afterAll, expect, test } from "bun:test";
import { auth, roles } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import { isEnabled } from "@sentrello/db/modules";
import { eq, like, sql } from "@sentrello/db/orm";
import {
  type SentrelloEnv,
  type SentrelloModule,
  addCrawlable,
  addPersonalData,
  addSearchProvider,
  allCrawlable,
  defineModule,
  personalDataSources,
  registerForTest,
  searchProviders,
} from "@sentrello/module-sdk";
import { Hono } from "hono";
import { resolveLicense } from "./license";
import { loadModules } from "./loader";
import { failedBundles } from "./optional-modules";

/**
 * A signed-in caller, because `/api/_meta` names the version and every module
 * a business bought — the first thing anyone probing an instance wants, and
 * none of it any use before signing in.
 */
async function signedIn(): Promise<{
  headers: Headers;
  email: string;
  organizationId: string;
  cleanUp: () => Promise<void>;
}> {
  const email = `boot-${crypto.randomUUID().slice(0, 8)}@x.test`;
  const signUp = await signUpAsOwner({
    email,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  const headers = new Headers({ cookie });

  /**
   * And a business to belong to, because the real first-run path creates one:
   * `/api/bootstrap` signs the owner up and immediately creates their
   * organization. A signed-in user who is a member of nothing is a billing
   * account, not staff, and the shell now treats the two differently — so a
   * test that skipped this would be asserting against a person who does not
   * exist in production.
   */
  const suffix = crypto.randomUUID().slice(0, 8);
  const org = await auth.api.createOrganization({
    body: { name: `Boot ${suffix}`, slug: `boot-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create the test organization");
  await auth.api.setActiveOrganization({
    body: { organizationId: org.id },
    headers,
  });

  return {
    headers,
    email,
    organizationId: org.id,
    // Left behind, any owner makes the instance look claimed and every
    // bootstrap test then fails on a database this one dirtied.
    cleanUp: async () => {
      const [u] = await db
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(eq(schema.user.email, email));
      if (!u) return;
      await db.delete(schema.member).where(eq(schema.member.userId, u.id));
      await db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, org.id));
      await db.delete(schema.session).where(eq(schema.session.userId, u.id));
      await db.delete(schema.account).where(eq(schema.account.userId, u.id));
      await db.delete(schema.user).where(eq(schema.user.id, u.id));
    },
  };
}

/**
 * A safety net, because one missed cleanup poisons other files.
 *
 * Every sign-in here creates an organization — the real first-run path does,
 * so a test owner without one is a person who cannot exist. But an
 * organization left behind makes the instance look *claimed*, and the
 * bootstrap tests in another file then fail with 409s that have nothing to do
 * with them. That happened. Per-test cleanup still runs; this catches whatever
 * it misses.
 */
afterAll(async () => {
  const strays = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(like(schema.organizations.slug, "boot-%"));
  for (const org of strays) {
    await db
      .delete(schema.member)
      .where(eq(schema.member.organizationId, org.id));
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, org.id));
  }

  const users = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(like(schema.user.email, "boot-%@x.test"));
  for (const u of users) {
    await db.delete(schema.session).where(eq(schema.session.userId, u.id));
    await db.delete(schema.account).where(eq(schema.account.userId, u.id));
    await db.delete(schema.user).where(eq(schema.user.id, u.id));
  }
});

const freeGate = () => false;
const proGate = (need: { tier?: "pro"; module?: string }) =>
  need.tier === "pro" || need.module === "scheduling";

function mod(id: string, tier: "free" | "pro" | "module", requires?: string[]) {
  return defineModule({
    id,
    tier,
    requires,
    register(ctx) {
      ctx.registerNav({ id, label: id, order: id === "crm" ? 10 : 20 });
      ctx.registerPermission(`${id}:read`);
      ctx.app.get(`/api/${id}`, (c) => c.json({ ok: id }));
    },
  });
}

test("free modules load without any license", () => {
  const app = new Hono<SentrelloEnv>();
  const { loaded, nav, permissions } = loadModules(app, freeGate, [
    mod("crm", "free"),
  ]);
  expect(loaded).toEqual(["crm"]);
  // the module that registered the entry travels with it: the browser fetches
  // that module's screens, and a nav id is not always a module id
  expect(nav).toEqual([
    { id: "crm", label: "crm", order: 10, moduleId: "crm" },
  ]);
  expect(permissions).toEqual(["crm:read"]);
});

/**
 * A nav id is a URL, so two modules cannot share one.
 *
 * Every other registry the SDK offers is keyed by module and id together now,
 * which is what makes two modules choosing the same obvious word harmless.
 * This one cannot be: the id is the path a person bookmarks and the key the
 * browser matches a module's screens against. And it was not merely appending
 * a second entry — `visibleTo` and `requires` are held against this id, so the
 * later module silently took the earlier one's permission gate off its screen.
 *
 * Refused, and said out loud with both modules named.
 */
test("a nav id another module already has is refused rather than replacing it", () => {
  const first = defineModule({
    id: "invoicing",
    tier: "free" as const,
    register(ctx) {
      ctx.registerNav({
        id: "money",
        label: "Invoices",
        requires: {
          invoices: ["read"],
        },
      });
    },
  });
  const second = defineModule({
    id: "shop",
    tier: "free" as const,
    register(ctx) {
      ctx.registerNav({ id: "money", label: "Takings" });
    },
  });

  const said: string[] = [];
  const wasError = console.error;
  console.error = (...args: unknown[]) => said.push(args.join(" "));
  let loaded: ReturnType<typeof loadModules>;
  try {
    loaded = loadModules(new Hono<SentrelloEnv>(), freeGate, [first, second]);
  } finally {
    console.error = wasError;
  }

  // One entry, and it is the one that claimed the word first.
  expect(loaded.nav.filter((n) => n.id === "money")).toEqual([
    { id: "money", label: "Invoices", moduleId: "invoicing" },
  ]);
  // And the permission the first module's screen needs is still the one held
  // against it — the whole reason a silent replacement was worse than a
  // duplicate.
  expect(loaded.navPermissions.get("money")).toEqual({ invoices: ["read"] });
  expect(said.join(" ")).toContain("shop");
  expect(said.join(" ")).toContain("invoicing");
});

test("pro + entitled optional modules load only when the gate allows", () => {
  const modules = [
    mod("crm", "free"),
    mod("pro-core", "pro"),
    mod("scheduling", "module"),
    mod("documents", "module"),
  ];

  const proLoaded = loadModules(
    new Hono<SentrelloEnv>(),
    proGate,
    modules,
  ).loaded;
  expect(proLoaded).toContain("pro-core");
  expect(proLoaded).toContain("scheduling");
  expect(proLoaded).not.toContain("documents");

  const freeLoaded = loadModules(
    new Hono<SentrelloEnv>(),
    freeGate,
    modules,
  ).loaded;
  expect(freeLoaded).toEqual(["crm"]);
});

test("module with an unmet `requires` is skipped", () => {
  const { loaded } = loadModules(new Hono<SentrelloEnv>(), freeGate, [
    mod("reports", "free", ["pro-core"]),
    mod("crm", "free"),
  ]);
  expect(loaded).toEqual(["crm"]);
});

test("dependency order is respected regardless of array order", () => {
  const { loaded } = loadModules(new Hono<SentrelloEnv>(), freeGate, [
    mod("c", "free", ["b"]),
    mod("b", "free", ["a"]),
    mod("a", "free"),
  ]);
  expect(loaded).toEqual(["a", "b", "c"]);
});

test("a module's job reaches the host with its handler intact", async () => {
  let ran = 0;
  const withJob = defineModule({
    id: "scheduling",
    tier: "module",
    register(ctx) {
      ctx.registerJob({
        name: "reminders",
        cron: "*/15 * * * *",
        handler: async () => {
          ran += 1;
        },
      });
    },
  });

  const boughtScheduling = (need: { tier?: "pro"; module?: string }) =>
    need.module === "scheduling";

  const { jobs } = loadModules(new Hono<SentrelloEnv>(), boughtScheduling, [
    withJob,
    // this one was not bought, so its job must not be scheduled either
    defineModule({
      id: "documents",
      tier: "module",
      register: (ctx) =>
        ctx.registerJob({ name: "reminders", handler: async () => {} }),
    }),
  ]);

  // namespaced, so two modules asking for "reminders" cannot collide
  expect(jobs.map((j) => j.name)).toEqual(["scheduling:reminders"]);
  expect(jobs[0]?.cron).toBe("*/15 * * * *");

  await jobs[0]?.handler();
  expect(ran).toBe(1);
});

test("a job from an unentitled module is never scheduled", () => {
  const { jobs } = loadModules(new Hono<SentrelloEnv>(), freeGate, [
    defineModule({
      id: "scheduling",
      tier: "module",
      register: (ctx) =>
        ctx.registerJob({
          name: "reminders",
          handler: async () => {
            throw new Error("must not run");
          },
        }),
    }),
  ]);
  expect(jobs).toEqual([]);
});

/**
 * Some modules are ours and belong on one machine — Master, and the control
 * plane that issues licences. They say so themselves, and the loader takes
 * their word for it before anything is registered: a module that only refused
 * inside `register` would still have its tables migrated and its screens
 * served.
 */
test("a module that declines this host is not loaded at all", async () => {
  const app = new Hono<SentrelloEnv>();
  const ours = defineModule({
    ...mod("master", "free"),
    available: () => false,
  });

  const { loaded, nav } = loadModules(app, freeGate, [
    ours,
    mod("crm", "free"),
  ]);

  expect(loaded).toEqual(["crm"]);
  expect(nav.map((n) => n.id)).toEqual(["crm"]);
  expect((await app.request("http://localhost/api/master")).status).toBe(404);
});

test("a skipped module registers no routes", async () => {
  const app = new Hono<SentrelloEnv>();
  loadModules(app, freeGate, [mod("scheduling", "module")]);
  const res = await app.request("http://localhost/api/hr");
  expect(res.status).toBe(404);
});

test("resolveLicense falls back to Free when the token file is missing", async () => {
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = "secrets/does-not-exist.jwt";
  const { state, gate, tokenPresent } = await resolveLicense();
  expect(state.valid).toBe(false);
  expect(state.claims).toBeNull();
  expect(gate({ tier: "pro" })).toBe(false);
  // No token is plain Free, not a failed verification — the licence screen
  // shows a neutral "Free" for this, never "not verified".
  expect(tokenPresent).toBe(false);
});

test("/healthz boots and reports Free when no token is present", async () => {
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = "secrets/does-not-exist.jwt";
  const server = (await import("./index")).default;
  const res = await server.fetch(new Request("http://localhost/healthz"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    status: "ok",
    // Answered by asking the database, not by assuming it. A wiped instance
    // used to report "ok" here while every sign-in returned 500.
    database: "ok",
    // Baked into the image at build time; "unknown" outside a released one,
    // which is the honest answer when running from a checkout.
    version: "unknown",
    tier: "free",
    license_valid: false,
    modules_loaded: [
      "dashboard",
      "crm",
      // One module now: quotes, invoices, the ledger and the returns are one
      // subject, and the split into two was ours rather than the business's.
      "money",
      "settings",
      "profile",
      "users",
      // Taking old records off this server: Free, because the business most
      // likely to fill a disk is the one on the smallest machine.
      "archive",
      "account",
    ],
    // A bundle that will not load is reported rather than only logged: it
    // takes every feature of that module with it.
    modules_failed: [],
    // Null until the nightly sweep has run in this process — which after a
    // restart is simply true. Once it has, monitoring reads the backlog and
    // the time here, because a housekeeping job that quietly stopped is how
    // a self-hosted disk fills.
    retention: null,
  });
});

test("/healthz reports degraded when the database has not been migrated", async () => {
  // The failure this endpoint exists to catch, reproduced rather than
  // described: the demo's reset emptied its database on 2026-08-22, the
  // migration that should have refilled it was killed part-way, and /healthz
  // went on answering "ok" for seven hours while every sign-in returned 500.
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = "secrets/does-not-exist.jwt";
  const server = (await import("./index")).default;

  await db.execute(sql`alter table "user" rename to "user__healthz_test"`);
  try {
    const res = await server.fetch(new Request("http://localhost/healthz"));
    const body = (await res.json()) as { status: string; database: string };
    expect(body.database).toBe("unmigrated");
    expect(body.status).toBe("degraded");
  } finally {
    await db.execute(sql`alter table "user__healthz_test" rename to "user"`);
  }

  // And back to ok once the table is there again, so the test proves the
  // check reads the database rather than latching on first call.
  const after = await server.fetch(new Request("http://localhost/healthz"));
  expect(((await after.json()) as { database: string }).database).toBe("ok");
});

test("/healthz reports the version the image was built with", async () => {
  // "Which version are you on?" is the first question of every support
  // conversation, and the only way to answer it used to be docker inspect.
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = "secrets/does-not-exist.jwt";
  process.env.SENTRELLO_VERSION = "9.9.9";

  // A fresh module registry, because index.ts reads the variable once at load.
  const mod = await import(`./index?version-test=${Date.now()}`);
  const res = await mod.default.fetch(new Request("http://localhost/healthz"));
  const body = (await res.json()) as { version: string };
  expect(body.version).toBe("9.9.9");

  process.env.SENTRELLO_VERSION = undefined;
});

test("/api/_meta exposes only the nav the loaded modules registered", async () => {
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = "secrets/does-not-exist.jwt";
  const server = (await import("./index")).default;

  // Anonymous callers are told nothing at all.
  const anonymous = await server.fetch(
    new Request("http://localhost/api/_meta"),
  );
  expect(anonymous.status).toBe(401);

  const { headers, cleanUp } = await signedIn();
  const res = await server.fetch(
    new Request("http://localhost/api/_meta", { headers }),
  );
  const body = (await res.json()) as {
    nav: { id: string }[];
    loaded: string[];
  };
  // Sorted by each entry's own `order`, globally — so a module's children
  // interleave with another module's, because both number their pages from 1.
  // That is cosmetic here: the sidebar never reads this flat sequence, it
  // groups by parent (`childrenOf` in `app-shell.tsx`), and the order within
  // a parent is asserted by the console test further down. What this list is
  // for is the set: every entry the loaded modules registered and nothing
  // else, with the Pro entries absent because this instance has no licence.
  expect(body.nav.map((n) => n.id)).toEqual([
    "dashboard",
    "crm-dashboard",
    // The Users console's seven screens sit at orders 1-7, so they land
    // among the CRM's pages here. `users` keeps its id so /users still opens
    // the people list rather than a heading.
    "users",
    "contacts",
    "user-groups",
    "companies",
    "user-policies",
    "deals",
    "user-sessions",
    "forms",
    "user-auth",
    "user-providers",
    "user-events",
    /*
     * The CRM's settings moved from 5 to 9, which is why they sit here now
     * rather than three lines up.
     *
     * At 5 they sat between the deals and the Pro half's notes, mailbox and
     * automations — in the middle of the module, above things somebody uses
     * every day. Settings are settings: they go at the bottom, under their own
     * heading in the panel.
     */
    "crm-settings",
    "crm",
    /*
     * Money, and then its pages.
     *
     * The pages kept their own ids, which is deliberate: a nav id is the address
     * in the browser, so everything anybody had bookmarked is where it was. Only
     * the module they belong to changed, and with it the one icon on the rail.
     */
    "money",
    "invoicing-dashboard",
    "quotes",
    "invoicing",
    // Where the business stands against each state's economic-nexus line,
    // its exemption certificates, and a period's filing figures.
    // No "recurring" and no "subscriptions": this instance has no licence, and
    // both are the Pro half of Invoicing. The routes behind them answer 404
    // here, so the sidebar must not offer either door.
    "invoicing-settings",
    /*
     * From here the sequence is Money's, not each half's.
     *
     * Invoicing numbered its pages around 20 and Accounting around 30, for a
     * world where each had its own menu. Read as one list that put the tax
     * returns second, between the invoices and the bank, and left two pages
     * sharing 20.5 so their relative position was whatever the sort did that
     * run. Money arranges both halves now, so the numbers are Money's: getting
     * paid, spending, banking, the books, then tax.
     *
     * Money's own head (18.8) and dashboard (18.9) still lead, which is why the
     * sections begin at 19 rather than 10 — below them and the module sorted
     * after its own pages.
     */
    // Spending, and the Pro bills page absent with no licence.
    "accounting-money",
    // Banking, and the Pro banking page likewise absent.
    "accounting-accounts",
    // The books. The Pro reports page is absent for the same reason: a door
    // onto an endpoint that answers nothing is worse than no door.
    "accounting",
    "accounting-summary",
    "accounting-journal",
    /*
     * Tax last, which is the point of the rearrangement.
     *
     * `invoicing-us-tax` was 20.5 and sat between the invoices and the invoice
     * settings. A return is a deliberate act with a legal declaration attached,
     * and somebody looking for one on a quarter-end deadline should find a
     * heading rather than read down a list of sixteen.
     */
    "invoicing-us-tax",
    // No "accounting-vat" and no "accounting-ca-tax" here: a fresh
    // organization has chosen no tax regimes explicitly and defaults to US
    // sales tax alone (see `@sentrello/db/tax-regimes`), so the UK VAT and
    // Canadian tax screens — each a deliberate act with a legal declaration
    // attached — are not offered until this business says it operates there.
    "settings",
    // Settings' own pages, so nobody hunts for a VAT number past the licence.
    "settings-business",
    "settings-integrations",
    "settings-licence",
    "settings-modules",
    // Answering somebody who asks what is held about them, which has a legal
    // deadline — so it sits beside the other settings rather than inside one.
    "settings-privacy",
    // Taking old records off this server, beside the other settings for the
    // same reason: it is a decision about the instance, not about the books.
    "settings-archive",
    // The console heading itself, at order 91 with the other Configure
    // entries — last, because its children numbered themselves from 1.
    "users-console",
  ]);
  expect(body.loaded).not.toContain("pro-core");

  /**
   * And nothing about dashboard widgets, entitled or otherwise. The layout
   * endpoint is where widgets are offered, filtered per reader; _meta
   * carrying them too would be a second copy to leak from. On this
   * unlicensed instance a Pro panel's id must appear nowhere at all.
   */
  const meta = JSON.stringify(body);
  expect(meta).not.toContain("revenue-trend");
  expect(meta).not.toContain("who-owes");

  // The same discipline on the layout endpoint itself, through the real
  // loader: the Free reader is offered the Free panels by name and never
  // told the Pro ones exist.
  const layoutRes = await server.fetch(
    new Request("http://localhost/api/dashboard/layout", { headers }),
  );
  expect(layoutRes.status).toBe(200);
  const layout = JSON.stringify(await layoutRes.json());
  expect(layout).toContain('"dashboard:money"');
  expect(layout).not.toContain("revenue-trend");
  expect(layout).not.toContain("who-owes");

  await cleanUp();
});

/**
 * A report widget is offered to a reader only when its own route can
 * actually answer them — and never the other way round.
 *
 * `visibleWidgets` in the dashboard module decides what a reader is told
 * about; for the four report panels, what actually answers lives in a
 * different module's routes (Core's own accounting bundle for
 * `balance-sheet`, Pro's for the rest) — not in the dashboard's own
 * `/api/dashboard/widgets`. The two bugs this guards against were both the
 * same shape: the widget was offered (no `entitlement: needsPro`) while the
 * route behind it did not exist on this instance at all.
 *
 * Core cannot hold a list of which report widgets are "Pro" — that is
 * exactly the fact Pro's internals must not be named from here. So this
 * checks the two sides against each other instead of against a label:
 * whatever the layout endpoint discloses, the matching route must actually
 * answer; whatever it withholds, the route must not. Run against the real
 * unlicensed boot, with the real accounting module's real routes, not a
 * fake or a stub — so a widget's `entitlement` and its route only ever
 * drift apart in a way this test can see.
 *
 * What this cannot catch: a route that answers 200 but returns the wrong
 * data (a widget pointed at somebody else's report), or a fifth report
 * widget added to the layout without adding its path to `REPORT_ROUTE`
 * below — that map is Core's own web shell's routing
 * (`apps/web/src/routes/dashboard.tsx`), which nothing ties to the widget
 * declaration at the type level either. Both are narrower failures than
 * "disclosed and broken," which is the one that has shipped twice.
 */
test("a report widget is disclosed to a reader if and only if its own route can answer them", async () => {
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = "secrets/does-not-exist.jwt";
  const server = (await import("./index")).default;
  const { headers, cleanUp } = await signedIn();

  const layoutRes = await server.fetch(
    new Request("http://localhost/api/dashboard/layout", { headers }),
  );
  const layout = (await layoutRes.json()) as { widgets: { id: string }[] };
  const offered = new Set(layout.widgets.map((w) => w.id));

  // The path each report widget's own renderer fetches, from
  // apps/web/src/routes/dashboard.tsx. Every id matches its own
  // `/api/reports/<id>` except "who-owes", which reads the aged-debt report
  // under its Pro name.
  const REPORT_ROUTE: Record<string, string> = {
    "balance-sheet": "/api/reports/balance-sheet",
    "cash-flow": "/api/reports/cash-flow",
    "trial-balance": "/api/reports/trial-balance",
    "who-owes": "/api/reports/accounts-receivable",
  };

  for (const [id, path] of Object.entries(REPORT_ROUTE)) {
    const res = await server.fetch(
      new Request(`http://localhost${path}`, { headers }),
    );
    // Panels are offered as `moduleId:id`; these are the dashboard's own.
    const key = `dashboard:${id}`;
    // 404 is "does not exist on this instance", the same answer a module
    // that never loaded gives for any of its routes. Disclosed must mean
    // answers, withheld must mean does not — never a mismatch either way.
    expect([id, offered.has(key)]).toEqual([id, res.status !== 404]);
  }

  await cleanUp();
});

test("a business sees only the tax regimes it has chosen, and turning one off never breaks an old report", async () => {
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = "secrets/does-not-exist.jwt";
  const server = (await import("./index")).default;
  const { headers, cleanUp } = await signedIn();
  headers.set("content-type", "application/json");

  const navIds = async () => {
    const res = await server.fetch(
      new Request("http://localhost/api/_meta", { headers }),
    );
    const body = (await res.json()) as { nav: { id: string }[] };
    return body.nav.map((n) => n.id);
  };

  // A fresh instance defaults to US sales tax alone — never anything the
  // business never said it operates in, and never an empty sidebar either.
  expect(await navIds()).toContain("invoicing-us-tax");
  expect(await navIds()).not.toContain("accounting-vat");
  expect(await navIds()).not.toContain("accounting-ca-tax");
  // EU VAT gates the One Stop Shop return the same way.
  expect(await navIds()).not.toContain("invoicing-oss");

  // Choosing UK VAT and Canada as well offers both screens immediately.
  const put = await server.fetch(
    new Request("http://localhost/api/tax-regimes", {
      method: "PUT",
      headers,
      body: JSON.stringify({ regimes: ["uk-vat", "ca-tax"] }),
    }),
  );
  expect(put.status).toBe(200);
  expect(await navIds()).toContain("accounting-vat");
  expect(await navIds()).toContain("accounting-ca-tax");
  // US sales tax was not re-chosen, so it is offered no longer.
  expect(await navIds()).not.toContain("invoicing-us-tax");

  // And EU VAT, once chosen, puts the OSS return in the sidebar.
  await server.fetch(
    new Request("http://localhost/api/tax-regimes", {
      method: "PUT",
      headers,
      body: JSON.stringify({ regimes: ["uk-vat", "ca-tax", "eu-vat"] }),
    }),
  );
  expect(await navIds()).toContain("invoicing-oss");

  // The VAT return itself computes regardless — the nav entry is what is
  // gated, never the figures. Proven both while the regime is chosen and
  // after it is turned back off, so a business that stops selling in the UK
  // can still pull up what it filed while it did.
  const vatReturn = () =>
    server.fetch(
      new Request("http://localhost/api/accounting/vat-return", { headers }),
    );
  expect((await vatReturn()).status).toBe(200);

  await server.fetch(
    new Request("http://localhost/api/tax-regimes", {
      method: "PUT",
      headers,
      body: JSON.stringify({ regimes: ["us-sales-tax"] }),
    }),
  );
  expect(await navIds()).not.toContain("accounting-vat");
  // The screen is gone; the computation underneath it is not.
  expect((await vatReturn()).status).toBe(200);

  await cleanUp();
});

/**
 * The failure a real customer met.
 *
 * sentrello.com creates a billing account for every buyer, on the same
 * instance that runs the business's own books. Being a member of no
 * organization, that account was shown the entire sidebar — every screen
 * offered, every route refusing them after the click.
 */
test("somebody who belongs to no business is offered nothing at all", async () => {
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = "secrets/does-not-exist.jwt";
  const server = (await import("./index")).default;

  const { headers, email, cleanUp } = await signedIn();
  const [user] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email));

  const before = (await (
    await server.fetch(new Request("http://localhost/api/_meta", { headers }))
  ).json()) as { nav: { id: string }[]; belongsHere: boolean };
  expect(before.nav.length).toBeGreaterThan(0);
  expect(before.belongsHere).toBe(true);

  // What a billing account is: a real login, a member of no business. Scoped
  // to this user, because other tests are entitled to their own memberships.
  await db
    .delete(schema.member)
    .where(eq(schema.member.userId, user?.id as string));

  const after = (await (
    await server.fetch(new Request("http://localhost/api/_meta", { headers }))
  ).json()) as {
    nav: { id: string }[];
    belongsHere: boolean;
    accountPath: string | null;
  };
  expect(after.nav).toEqual([]);
  expect(after.belongsHere).toBe(false);
  // Nothing to send them to on an instance that does not sell Sentrello.
  expect(after.accountPath).toBeNull();

  await cleanUp();
});

test("a module's screens are not served when the module did not load", async () => {
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = "secrets/does-not-exist.jwt";
  const server = (await import("./index")).default;

  // Free instance: scheduling is not loaded, so its script must 404 rather
  // than merely be hidden by the interface.
  const res = await server.fetch(
    new Request("http://localhost/modules/scheduling/ui.js"),
  );
  expect(res.status).toBe(404);

  const { headers, cleanUp } = await signedIn();
  const meta = (await (
    await server.fetch(new Request("http://localhost/api/_meta", { headers }))
  ).json()) as { ui: string[] };
  expect(meta.ui).toEqual([]);
  await cleanUp();
});

test("a module id cannot be used to reach a file off the map", async () => {
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = "secrets/does-not-exist.jwt";
  const server = (await import("./index")).default;

  for (const id of [
    "../../../etc/passwd",
    "..%2f..%2fpackage.json",
    "crm/../../secrets",
  ]) {
    const res = await server.fetch(
      new Request(`http://localhost/modules/${encodeURIComponent(id)}/ui.js`),
    );
    // The served path never comes from the request — the id is a map key, so
    // there is nothing to traverse.
    expect(res.status).toBe(404);
  }
});

test("the licence is not readable without a session", async () => {
  // It names the licence and the modules bought: not something to hand to
  // the internet, unlike /healthz which only says free or pro.
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = "secrets/does-not-exist.jwt";
  const server = (await import("./index")).default;
  const res = await server.fetch(new Request("http://localhost/api/license"));
  expect(res.status).toBe(401);
});

test("a business route is 401 without a session", async () => {
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = "secrets/does-not-exist.jwt";
  const server = (await import("./index")).default;
  const res = await server.fetch(new Request("http://localhost/api/contacts"));
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "unauthorized" });
});

/**
 * A date that never existed is a 400, wherever it was read.
 *
 * `new Date` rolls the 30th of February forward to the 2nd of March rather
 * than refusing it, so a filter or a period parameter would quietly answer a
 * question about February with March. The parsers throw; this is the mapping
 * that turns the throw into something the person who typed it can act on,
 * rather than "something went wrong".
 */
test("an impossible date is a 400 that names it, not a 500", async () => {
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = "secrets/does-not-exist.jwt";
  const server = (await import("./index")).default;
  const { headers, cleanUp } = await signedIn();
  try {
    const res = await server.fetch(
      new Request("http://localhost/api/contacts?lastSeenAfter=2026-02-30", {
        headers,
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "2026-02-30",
    );
  } finally {
    await cleanUp();
  }
});

test("a body that is not JSON is a 400, not a crash", async () => {
  // Routes parse with `c.req.json()`; before the onError mapping, a stray
  // byte in the body answered "something went wrong" with a 500 and a stack
  // trace in the log, for what is the caller's typo.
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = "secrets/does-not-exist.jwt";
  const server = (await import("./index")).default;
  const { headers, cleanUp } = await signedIn();
  try {
    headers.set("content-type", "application/json");
    const res = await server.fetch(
      new Request("http://localhost/api/contacts", {
        method: "POST",
        headers,
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "the request body is not valid JSON",
    });
  } finally {
    await cleanUp();
  }
});

/**
 * Owning a module and using it are different things.
 *
 * A business that buys Pro with four modules on a Friday should not find four
 * half-configured screens in its sidebar on Monday. The licence decides what
 * may run; this decides what has been set up, and until somebody says so the
 * answer is "not yet" rather than "no".
 */
test("an optional module stays out of the nav until it is turned on", async () => {
  const boughtScheduling = (need: { tier?: "pro"; module?: string }) =>
    need.module === "scheduling";

  const { nav, tiers } = loadModules(
    new Hono<SentrelloEnv>(),
    boughtScheduling,
    [mod("crm", "free"), mod("scheduling", "module")],
  );

  // The loader still loads it — its routes and jobs are real, and the licence
  // is what decides that. Only the way in is withheld.
  expect(nav.map((n) => n.id)).toContain("scheduling");
  expect(tiers.get("scheduling")).toBe("module");
  expect(tiers.get("crm")).toBe("free");

  const states = new Map([
    ["scheduling", { moduleId: "scheduling", enabled: false, enabledAt: null }],
  ]);
  const shown = nav.filter((item) =>
    tiers.get(item.moduleId) === "module"
      ? isEnabled(states, item.moduleId)
      : true,
  );
  expect(shown.map((n) => n.id)).toEqual(["crm"]);

  // A Free module is the product, not a purchase: nothing can hide it.
  expect(isEnabled(new Map(), "crm")).toBe(false);
  expect(shown.some((n) => n.id === "crm")).toBe(true);
});

/**
 * A screen somebody cannot open should not be offered.
 *
 * Found by inviting a colleague as Staff and looking at their sidebar: it
 * listed Settings, Bookkeeping and Roles, all of which answered 403 when
 * clicked. Being refused after clicking tells somebody twice that they cannot
 * do their job — once by the error, and once by the menu that suggested
 * otherwise.
 */
test("nav entries declare what they need, and the roles agree", () => {
  const withPermission = defineModule({
    id: "books",
    tier: "free",
    register(ctx) {
      ctx.registerNav({
        id: "bookkeeping",
        label: "Bookkeeping",
        requires: { bookkeeping: ["read"] },
      });
      ctx.registerNav({ id: "contacts", label: "Contacts" });
    },
  });

  const { nav, navPermissions } = loadModules(
    new Hono<SentrelloEnv>(),
    freeGate,
    [withPermission],
  );

  // The requirement travels beside the entry, never inside the payload the
  // browser receives — it is not the browser's decision to make.
  expect(nav.every((n) => !("requires" in n))).toBe(true);
  expect(navPermissions.get("bookkeeping")).toEqual({ bookkeeping: ["read"] });
  expect(navPermissions.has("contacts")).toBe(false);

  // And the compiled roles answer it the way the routes do. Two of them:
  // Staff and Accounting are the business's own roles now, so what they allow
  // is asserted where they are defined rather than here.
  expect(roles.admin.authorize({ bookkeeping: ["read"] }).success).toBe(true);
  expect(roles.admin.authorize({ settings: ["update"] }).success).toBe(true);
  expect(roles.customer.authorize({ bookkeeping: ["read"] }).success).toBe(
    false,
  );
  expect(roles.customer.authorize({ invoicing: ["read"] }).success).toBe(true);
});

/**
 * The sidebar draws itself from this, in two levels: a section holds modules,
 * and a module holds its own pages. If the relationship is not in the payload
 * the browser has to guess it from naming, which is how the CRM's five screens
 * ended up as five siblings of the Shop.
 */
test("/api/_meta says which entries are a module's own pages", async () => {
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = "secrets/does-not-exist.jwt";
  const server = (await import("./index")).default;

  const { headers, cleanUp } = await signedIn();
  const body = (await (
    await server.fetch(new Request("http://localhost/api/_meta", { headers }))
  ).json()) as {
    nav: { id: string; group?: string; parent?: string; icon?: string }[];
  };

  const crm = body.nav.find((n) => n.id === "crm");
  expect(crm?.group).toBe("Sales");
  expect(crm?.parent).toBeUndefined();
  // The rail is icons alone, so a section entry without one is a blank square.
  expect(crm?.icon).toBeTruthy();

  const pages = body.nav.filter((n) => n.parent === "crm").map((n) => n.id);
  expect(pages).toEqual([
    "crm-dashboard",
    "contacts",
    "companies",
    "deals",
    // Forms is a CRM screen, not a module beside it: it has no data, no
    // permissions and no meaning of its own. Above Settings, because it is
    // where the CRM's records come from and Settings is configuration.
    "forms",
    "crm-settings",
  ]);

  // And selling stays together: quotes and the CRM in one section.
  expect(body.nav.find((n) => n.id === "quotes")?.group).toBe("Sales");

  await cleanUp();
});

test("Users opens out into the screens of a console, not one page", async () => {
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = "secrets/does-not-exist.jwt";
  const server = (await import("./index")).default;

  const { headers, cleanUp } = await signedIn();
  const body = (await (
    await server.fetch(new Request("http://localhost/api/_meta", { headers }))
  ).json()) as {
    nav: { id: string; group?: string; parent?: string; icon?: string }[];
  };

  const parent = body.nav.find((n) => n.id === "users-console");
  expect(parent?.parent).toBeUndefined();
  expect(parent?.group).toBe("Configure");
  // The rail is icons alone, so a section entry without one is a blank square.
  expect(parent?.icon).toBeTruthy();

  const pages = body.nav
    .filter((n) => n.parent === "users-console")
    .map((n) => n.id);
  expect(pages).toEqual([
    "users",
    "user-groups",
    "user-policies",
    "user-sessions",
    "user-auth",
    "user-providers",
    "user-events",
  ]);

  // `users` stays the id of the people screen rather than becoming the
  // heading, so a bookmark to /users still lands on the list.
  expect(body.nav.find((n) => n.id === "users")?.parent).toBe("users-console");

  await cleanUp();
});

/**
 * Every screen in the console is gated at `settings:["update"]`, including
 * including two that might seem to only need `read`, because the routes behind them are —
 * `GET /api/users/events` and `GET /api/users/sessions` each aggregate every
 * person in the business into one read.
 *
 * This is what holds them there. `/api/_meta` filters the nav by what the
 * caller may actually use, so a caller holding `settings:read` and nothing
 * more must see none of these entries: dropping any one of them to `read`
 * puts a menu item in front of somebody the route will answer 403.
 */
test("a caller with settings:read alone is offered none of the Users console", async () => {
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = "secrets/does-not-exist.jwt";
  const server = (await import("./index")).default;

  const owner = await signedIn();

  // A role of this organization's own making that reads settings and changes
  // nothing — the shape every seeded policy except `admins` has.
  await db.insert(schema.organizationRole).values({
    id: crypto.randomUUID(),
    organizationId: owner.organizationId,
    role: "read-only",
    permission: JSON.stringify({ settings: ["read"] }),
  });

  const readerEmail = `boot-reader-${crypto.randomUUID().slice(0, 8)}@x.test`;
  const reader = await signUpAsOwner({
    email: readerEmail,
    password: "correct-horse-battery-staple",
    name: "A Reader",
  });
  const readerCookie = reader.headers.get("set-cookie");
  if (!readerCookie) throw new Error("sign-up returned no session cookie");
  const readerHeaders = new Headers({ cookie: readerCookie });
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: owner.organizationId,
    userId: reader.response.user.id,
    role: "read-only",
    baseRole: "read-only",
    createdAt: new Date(),
  });
  await auth.api.setActiveOrganization({
    body: { organizationId: owner.organizationId },
    headers: readerHeaders,
  });

  const body = (await (
    await server.fetch(
      new Request("http://localhost/api/_meta", { headers: readerHeaders }),
    )
  ).json()) as { nav: { id: string; parent?: string }[] };

  // Positive assertion first: this caller really is being offered a nav, so
  // the absences below mean something.
  expect(body.nav.length).toBeGreaterThan(0);
  expect(body.nav.find((n) => n.id === "users-console")).toBeUndefined();
  expect(body.nav.filter((n) => n.parent === "users-console")).toEqual([]);

  await db
    .delete(schema.organizationRole)
    .where(eq(schema.organizationRole.organizationId, owner.organizationId));
  await db
    .delete(schema.member)
    .where(eq(schema.member.userId, reader.response.user.id));
  await db
    .delete(schema.session)
    .where(eq(schema.session.userId, reader.response.user.id));
  await db
    .delete(schema.account)
    .where(eq(schema.account.userId, reader.response.user.id));
  await db
    .delete(schema.user)
    .where(eq(schema.user.id, reader.response.user.id));
  await owner.cleanUp();
});

/**
 * The same caller, once they are in a group.
 *
 * `member.role` is comma separated the moment somebody is in one —
 * `applyRoles` in the Users module writes it that way — so the role this
 * person holds is `"read-only,sales"`, not `"read-only"`. Nothing about what
 * they may do has changed: neither role grants `settings:update`, and every
 * Users console route still answers 403.
 *
 * The nav used to stop agreeing at exactly that point. It read `member.role`
 * as one role name, found neither a compiled role nor a stored row under the
 * whole comma-separated string, and fell through to "nothing to check
 * against, so the entry stays" — offering the entire sidebar to the people
 * most likely to have a tailored role, which is the same failure the custom
 * role lookup was added to fix.
 */
test("a caller in a group is still offered only what their roles allow", async () => {
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = "secrets/does-not-exist.jwt";
  const server = (await import("./index")).default;

  const owner = await signedIn();

  for (const [role, permission] of [
    ["read-only", { settings: ["read"] }],
    ["sales", { crm: ["read", "create", "update"] }],
  ] as const) {
    await db.insert(schema.organizationRole).values({
      id: crypto.randomUUID(),
      organizationId: owner.organizationId,
      role,
      permission: JSON.stringify(permission),
    });
  }

  const readerEmail = `boot-grouped-${crypto.randomUUID().slice(0, 8)}@x.test`;
  const reader = await signUpAsOwner({
    email: readerEmail,
    password: "correct-horse-battery-staple",
    name: "In A Group",
  });
  const readerCookie = reader.headers.get("set-cookie");
  if (!readerCookie) throw new Error("sign-up returned no session cookie");
  const readerHeaders = new Headers({ cookie: readerCookie });
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: owner.organizationId,
    userId: reader.response.user.id,
    // What `applyRoles` writes: their own role, then the group's.
    role: "read-only,sales",
    baseRole: "read-only",
    createdAt: new Date(),
  });
  await auth.api.setActiveOrganization({
    body: { organizationId: owner.organizationId },
    headers: readerHeaders,
  });

  const body = (await (
    await server.fetch(
      new Request("http://localhost/api/_meta", { headers: readerHeaders }),
    )
  ).json()) as { nav: { id: string; parent?: string }[] };

  // The group's own role really did arrive: the CRM is offered, which
  // `read-only` alone would not have been.
  expect(body.nav.find((n) => n.id === "crm")).toBeDefined();
  // And nothing either role withholds is.
  expect(body.nav.find((n) => n.id === "users-console")).toBeUndefined();
  expect(body.nav.filter((n) => n.parent === "users-console")).toEqual([]);

  await db
    .delete(schema.organizationRole)
    .where(eq(schema.organizationRole.organizationId, owner.organizationId));
  await db
    .delete(schema.member)
    .where(eq(schema.member.userId, reader.response.user.id));
  await db
    .delete(schema.session)
    .where(eq(schema.session.userId, reader.response.user.id));
  await db
    .delete(schema.account)
    .where(eq(schema.account.userId, reader.response.user.id));
  await db
    .delete(schema.user)
    .where(eq(schema.user.id, reader.response.user.id));
  await owner.cleanUp();
});

/**
 * A researcher can find where to report something.
 *
 * RFC 9116. A scanner checks this path, procurement questionnaires ask whether
 * it exists, and a researcher who cannot find a contact address either gives up
 * or posts publicly — which is the outcome the file exists to prevent.
 *
 * Unauthenticated on purpose: the person who needs it does not have an account,
 * and requiring one would be the same as not having the file.
 */
test("security.txt says where to report a vulnerability, without a session", async () => {
  const server = (await import("./index")).default;
  const res = await server.fetch(
    new Request("http://localhost/.well-known/security.txt"),
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/plain");

  const body = await res.text();
  expect(body).toContain("Contact: mailto:security@sentrello.com");
  // The distinction a researcher needs: this instance belongs to a business,
  // the software belongs to us.
  expect(body).toContain("self-hosted instance");
});

/**
 * The AGPL's section 13 offer, which is the clause that separates this licence
 * from the GPL: somebody who interacts with the software over a network is
 * owed the corresponding source even though they never receive a copy.
 *
 * Tested for two things, and the first matters more. **It must answer without
 * a session** — a clause about people who are not signed in cannot be
 * satisfied behind a sign-in, and every other `/api/_` route on this host
 * requires one, so this is the exception and exceptions drift back.
 *
 * And it must be able to point somewhere other than our repository. A business
 * that has modified Sentrello and put it in front of its customers owes them
 * its own source; publishing ours discharges nothing on their behalf.
 */
test("the source offer answers anybody, and can name the operator's own repository", async () => {
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = "secrets/does-not-exist.jwt";
  const server = (await import("./index")).default;

  const anonymous = await server.fetch(
    new Request("http://localhost/api/_source"),
  );
  expect(anonymous.status).toBe(200);
  const body = (await anonymous.json()) as {
    licence: string;
    source: string;
    modified: boolean;
  };
  expect(body.licence).toBe("AGPL-3.0-or-later");
  expect(body.source).toBe("https://github.com/Sentrello/Sentrello");
  // Unmodified until an operator says otherwise, which is the honest default
  // for an instance running the published image.
  expect(body.modified).toBe(false);

  process.env.SENTRELLO_SOURCE_URL = "https://git.example.test/their-fork";
  const theirs = await (
    await server.fetch(new Request("http://localhost/api/_source"))
  ).json();
  expect(theirs).toMatchObject({
    source: "https://git.example.test/their-fork",
    modified: true,
  });
  process.env.SENTRELLO_SOURCE_URL = undefined;
});

/**
 * Clickjacking, which nothing prevented.
 *
 * Every screen a business signs into could be framed by any site on the
 * internet. That is the whole attack: an invisible frame over a page somebody
 * wants you to click, and the click lands on "delete" or "pay" inside a session
 * the browser is already holding.
 *
 * The embedded form is checked in the same test rather than a separate one,
 * because the two facts only mean something together: the rule applies
 * everywhere *except* the one surface built to be used from another origin, and
 * a rule with a hole in it is worth testing at the hole.
 */
test("every response refuses to be framed, except the one meant to be embedded", async () => {
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = "secrets/does-not-exist.jwt";
  const server = (await import("./index")).default;

  const guarded = await server.fetch(new Request("http://localhost/healthz"));
  expect(guarded.headers.get("x-frame-options")).toBe("DENY");
  expect(guarded.headers.get("content-security-policy")).toContain(
    "frame-ancestors 'none'",
  );
  // Set on everything, framing aside: nothing here is improved by a browser
  // guessing a content type, and a full URL in a referrer carries invoice and
  // contact ids to wherever a customer clicks next.
  expect(guarded.headers.get("x-content-type-options")).toBe("nosniff");
  expect(guarded.headers.get("referrer-policy")).toBe(
    "strict-origin-when-cross-origin",
  );

  // The exception, and the reason it exists: a form on somebody's public
  // website is used from another origin by design.
  const embed = await server.fetch(new Request("http://localhost/embed.js"));
  expect(embed.headers.get("x-frame-options")).toBeNull();
  expect(embed.headers.get("x-content-type-options")).toBe("nosniff");
});

/**
 * A module that comes free with another loads when that one is licensed.
 *
 * The till is the case: free for anybody who has bought Shop. Without this it
 * would need its own entry in every licence token, and the day one was signed
 * without it a paying customer would quietly lose a feature they were told came
 * with what they bought.
 */
test("a module included with another is entitled by it", () => {
  const host = defineModule({
    id: "host-module",
    tier: "module",
    register() {},
  });
  const guest = defineModule({
    id: "guest-module",
    tier: "module",
    requires: ["host-module"],
    includedWith: "host-module",
    register() {},
  });

  const boughtTheHost = (need: { tier?: "pro"; module?: string }) =>
    need.tier === "pro" || need.module === "host-module";

  const withHost = loadModules(new Hono<SentrelloEnv>(), boughtTheHost, [
    host,
    guest,
  ]);
  expect(withHost.loaded.sort()).toEqual(["guest-module", "host-module"]);

  // And without the one it comes with, neither loads — the guest is free, not
  // free-standing.
  const without = loadModules(new Hono<SentrelloEnv>(), () => false, [
    host,
    guest,
  ]);
  expect(without.loaded).toEqual([]);
});

/**
 * `/robots.txt` is a robots file, not the application.
 *
 * It used to fall through to the single-page app: a 200 of HTML, which a
 * crawler reads as *no robots.txt at all* and therefore as permission to index
 * everything an instance serves. Our own hosts were covered by an nginx header;
 * a customer on their own domain was not, and the first they would know is
 * their sign-in page in a search result.
 */
test("/robots.txt refuses crawlers rather than serving the app", async () => {
  const server = (await import("./index")).default;
  const res = await server.fetch(
    new Request("http://localhost/robots.txt", {
      headers: { host: "app.example.test", "x-forwarded-proto": "https" },
    }),
  );

  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/plain");

  const body = await res.text();
  expect(body).not.toContain("<!doctype html>");
  expect(body).toContain("User-agent: *");
  expect(body).toContain("Disallow: /");
});

/**
 * Everything that is not published says so in a header, not only in a file.
 *
 * robots.txt can be overruled. A CDN may prepend its own — Cloudflare's does,
 * with `Allow: /` for every agent — and a crawler resolving that against our
 * `Disallow: /` takes the permissive one, because the specificity is equal and
 * Allow wins. bmp.sentrello.com was crawlable for exactly that reason on the
 * day `/robots.txt` was written. A header travels with the response and
 * nothing prepends to it.
 */
test("an application path tells crawlers to leave it alone", async () => {
  const server = (await import("./index")).default;
  const res = await server.fetch(new Request("http://localhost/contacts"));
  expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
});

/** Or a crawler cannot read the file that tells it what it may read. */
test("robots.txt itself is not marked noindex", async () => {
  const server = (await import("./index")).default;
  const res = await server.fetch(new Request("http://localhost/robots.txt"));
  expect(res.headers.get("x-robots-tag")).toBeNull();
});

/**
 * A published prefix keeps no noindex header.
 *
 * The half that matters commercially: getting this wrong does not break a
 * screen, it quietly takes a customer's storefront out of every search result
 * and nothing on any page says why.
 */
test("a path under a published prefix is left alone", async () => {
  const { addCrawlable, clearCrawlable } = await import(
    "@sentrello/module-sdk"
  );
  clearCrawlable();
  addCrawlable({ moduleId: "shop", prefix: "/shop" });
  const server = (await import("./index")).default;

  try {
    for (const path of ["/shop", "/shop/thing", "/shop/cart"]) {
      const res = await server.fetch(new Request(`http://localhost${path}`));
      expect(res.headers.get("x-robots-tag")).toBeNull();
    }

    // A path that merely begins with the same letters is not the shop.
    const other = await server.fetch(new Request("http://localhost/shopping"));
    expect(other.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  } finally {
    clearCrawlable();
  }
});

/**
 * A paid module that did not start is reported everywhere somebody might be
 * looking: the health endpoint monitoring watches, and the meta answer the
 * shell draws its banner from. `pro-core` was dark for weeks, twice, while
 * only /healthz knew — reported is not the same as noticed, so the fault now
 * travels to the screen an administrator is actually on.
 */
test("a bundle that did not start reaches /healthz and the shell's meta", async () => {
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = "secrets/does-not-exist.jwt";
  const server = (await import("./index")).default;

  // The list the boot filled, plus one: the fixture stands in for any of the
  // three ways a bundle goes missing — import threw, dependency unmet, or
  // entitled and simply absent — all of which land in this same list.
  failedBundles.push({ name: "pro-accounting", reason: "it broke, in a test" });
  const { headers, cleanUp } = await signedIn();
  try {
    const health = await server.fetch(new Request("http://localhost/healthz"));
    const reported = (await health.json()) as { modules_failed: string[] };
    expect(reported.modules_failed).toContain("pro-accounting");

    const meta = await server.fetch(
      new Request("http://localhost/api/_meta", { headers }),
    );
    const body = (await meta.json()) as { failed: string[] };
    // Names only — the reason stays behind the settings permission on
    // /api/license, where the licence screen reads it.
    expect(body.failed).toContain("pro-accounting");
    expect(JSON.stringify(body)).not.toContain("it broke, in a test");
  } finally {
    failedBundles.splice(
      failedBundles.findIndex((f) => f.name === "pro-accounting"),
      1,
    );
    await cleanUp();
  }
});

/** And a healthy instance's shell hears nothing at all. */
test("no failures means an empty list in the shell's meta", async () => {
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = "secrets/does-not-exist.jwt";
  const server = (await import("./index")).default;
  const { headers, cleanUp } = await signedIn();
  try {
    const meta = await server.fetch(
      new Request("http://localhost/api/_meta", { headers }),
    );
    const body = (await meta.json()) as { failed: string[] };
    expect(body.failed).toEqual([]);
  } finally {
    await cleanUp();
  }
});

// --- a module that misbehaves ----------------------------------------------

/**
 * A module that throws on the way up must not take the instance with it.
 *
 * `register` runs at boot, in module scope, before the server listens. An
 * exception there is not one module missing — it is no application at all: no
 * sign-in, no invoicing, nothing, on a box nobody can shell into. The same
 * file already decided this for migrations ("a module whose schema failed must
 * not take the whole instance down"); registration is the same argument one
 * step earlier, and a bundle from another repository is exactly where a
 * surprise arrives.
 */
test("a module that throws while registering does not stop the others", () => {
  const app = new Hono<SentrelloEnv>();
  const angry = defineModule({
    id: "angry",
    tier: "free",
    register() {
      throw new Error("it broke, in a test");
    },
  });

  const { loaded, unmet } = loadModules(app, freeGate, [
    angry,
    mod("crm", "free"),
  ]);

  expect(loaded).toEqual(["crm"]);
  // And reported, because a module that is installed, entitled and absent is
  // the failure /healthz exists for.
  expect(unmet.map((f) => f.name)).toContain("angry");
});

/**
 * And it is tried once, not once per pass.
 *
 * The loop goes round again whenever anything else made progress, and a module
 * that is neither loaded nor remembered as broken is offered its `register`
 * every time — so a module that throws half way through would register its
 * first few routes once per pass.
 */
test("a module that throws is not asked again on the next pass", () => {
  let attempts = 0;
  const angry = defineModule({
    id: "angry",
    tier: "free",
    register() {
      attempts += 1;
      throw new Error("it broke, in a test");
    },
  });

  // `late` cannot load until `early` has, so the loop is guaranteed a second
  // pass after `angry` has already failed in the first.
  loadModules(new Hono<SentrelloEnv>(), freeGate, [
    angry,
    mod("late", "free", ["early"]),
    mod("early", "free"),
  ]);

  expect(attempts).toBe(1);
});

/**
 * And it leaves no door behind it.
 *
 * A module that registered its nav entry and then threw would put a sidebar
 * item on every screen pointing at a module that is not there — the "door onto
 * nothing" this repository has shipped twice by other means.
 */
test("a module that throws leaves no nav, permission or job behind", () => {
  const halfway = defineModule({
    id: "halfway",
    tier: "free",
    register(ctx) {
      ctx.registerNav({ id: "halfway", label: "Halfway" });
      ctx.registerPermission("halfway:read");
      ctx.registerJob({ name: "sweep", handler: async () => {} });
      throw new Error("it broke, in a test");
    },
  });

  const { nav, permissions, jobs } = loadModules(
    new Hono<SentrelloEnv>(),
    freeGate,
    [halfway, mod("crm", "free")],
  );

  expect(nav.map((n) => n.id)).toEqual(["crm"]);
  expect(permissions).toEqual(["crm:read"]);
  expect(jobs).toEqual([]);
});

/**
 * Two modules claiming one id: the second is refused, and said so.
 *
 * It was refused already — the first one wins and the loop skips the rest —
 * but in silence, which is the half that matters. A renamed bundle left behind
 * by an installer, or a module that copied another's id, would take a paid
 * feature dark with nothing anywhere naming it.
 */
test("a second module with the same id is refused and reported", () => {
  const { loaded, unmet } = loadModules(new Hono<SentrelloEnv>(), freeGate, [
    mod("crm", "free"),
    defineModule({
      id: "crm",
      tier: "free",
      register: (ctx) => ctx.app.get("/api/imposter", (c) => c.json({})),
    }),
  ]);

  expect(loaded).toEqual(["crm"]);
  expect(unmet.map((f) => f.name)).toContain("crm");
});

/**
 * Every registration point the host offers, and the SDK's own harness offers
 * the same ones.
 *
 * Eight of them arrived in one day, each optional on `ModuleContext` so that
 * test harnesses in four repositories keep compiling. That makes forgetting to
 * wire one up in the loader invisible: the module calls
 * `ctx.registerWhatever?.(…)`, nothing happens, and nothing says so. A typo in
 * the *name* is caught by the compiler, since `ModuleContext` has no such
 * property; a name that is right and a host that never provides it is not.
 *
 * So the two contexts are compared against each other. A ninth registration
 * point wired into one and not the other fails here.
 */
test("the loader and the SDK's harness offer the same registration points", () => {
  const keysFrom = (register: (m: SentrelloModule) => void): string[] => {
    let seen: string[] = [];
    register(
      defineModule({
        id: "keys",
        tier: "free",
        register(ctx) {
          seen = Object.keys(ctx).sort();
        },
      }),
    );
    return seen;
  };

  const fromHost = keysFrom((m) =>
    loadModules(new Hono<SentrelloEnv>(), () => true, [m]),
  );
  const fromHarness = keysFrom((m) => {
    registerForTest(m);
  });

  expect(fromHost).toEqual(fromHarness);
  // And a rename that emptied both would pass the comparison above.
  expect(fromHost).toContain("registerRetention");
  expect(fromHost.length).toBeGreaterThan(12);
});

/**
 * The loader starts every registry empty, not most of them.
 *
 * It clears eight and left three — search, crawlable surfaces and personal
 * data — to whichever test file remembered. Each of those outlives a load, so
 * a module dropped by a licence that lapsed goes on answering the search box,
 * goes on answering a subject access request, and goes on keeping its prefix
 * out of the `noindex` header this instance puts on everything unpublished.
 */
test("loading modules starts every registry from empty", () => {
  addSearchProvider({ moduleId: "gone", find: async () => [] });
  addCrawlable({ moduleId: "gone", prefix: "/gone" });
  addPersonalData({
    moduleId: "gone",
    id: "gone",
    label: "Gone",
    retention: "never",
    export: async () => [],
  });

  loadModules(new Hono<SentrelloEnv>(), freeGate, [mod("crm", "free")]);

  expect(searchProviders()).toEqual([]);
  expect(allCrawlable()).toEqual([]);
  expect(personalDataSources()).toEqual([]);
});

test("a page hung off another page is reported, not drawn", () => {
  /*
   * The sidebar draws two levels. A third renders as nothing: the entry is
   * served by /api/_meta, passes its permission check, and has nowhere to
   * appear. The Newsletter shipped six that way — every settings tab hung off
   * the settings page — and nobody noticed, because that screen has its own
   * tabs and the URLs still resolved.
   *
   * Said at boot rather than asserted per module, because a test can only
   * cover the modules the repository holding it can load, and the licence
   * decides what any given instance runs. This sees whatever actually
   * started, including a bundle somebody else wrote.
   */
  const said: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    said.push(args.join(" "));
  };
  try {
    loadModules(new Hono<SentrelloEnv>(), freeGate, [
      defineModule({
        id: "deep",
        tier: "free",
        register(ctx) {
          ctx.registerNav({ id: "deep", label: "Deep" });
          ctx.registerNav({ id: "deep-page", label: "Page", parent: "deep" });
          ctx.registerNav({
            id: "deep-tab",
            label: "Tab",
            parent: "deep-page",
          });
        },
      }),
    ]);
  } finally {
    console.warn = warn;
  }

  const complaint = said.find((line) => line.includes("deep-tab"));
  expect(
    complaint,
    `nothing said deep-tab cannot be drawn; what was said: ${said.join(" | ")}`,
  ).toBeTruthy();
  expect(complaint).toContain("deep-page");
});

test("and an ordinary page is not reported", () => {
  const said: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    said.push(args.join(" "));
  };
  try {
    loadModules(new Hono<SentrelloEnv>(), freeGate, [
      defineModule({
        id: "flat",
        tier: "free",
        register(ctx) {
          ctx.registerNav({ id: "flat", label: "Flat" });
          ctx.registerNav({ id: "flat-page", label: "Page", parent: "flat" });
        },
      }),
    ]);
  } finally {
    console.warn = warn;
  }
  expect(said.filter((l) => l.includes("hangs off"))).toEqual([]);
});
