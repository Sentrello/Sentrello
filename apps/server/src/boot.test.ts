import { afterAll, expect, test } from "bun:test";
import { auth, roles } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import { isEnabled } from "@sentrello/db/modules";
import { eq, like, sql } from "@sentrello/db/orm";
import { type SentrelloEnv, defineModule } from "@sentrello/module-sdk";
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
    "crm-settings",
    "user-auth",
    "user-providers",
    "user-events",
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
    "invoicing-us-tax",
    // No "recurring" and no "subscriptions": this instance has no licence, and
    // both are the Pro half of Invoicing. The routes behind them answer 404
    // here, so the sidebar must not offer either door.
    "invoicing-settings",
    "accounting",
    // Accounting's own pages. The Pro four — bills, banking, budgets, tax —
    // are absent because this instance has no licence, and a door onto an
    // endpoint that answers nothing is worse than no door.
    "accounting-summary",
    "accounting-money",
    "accounting-accounts",
    "accounting-journal",
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
  expect(layout).toContain('"money"');
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
    // 404 is "does not exist on this instance", the same answer a module
    // that never loaded gives for any of its routes. Disclosed must mean
    // answers, withheld must mean does not — never a mismatch either way.
    expect([id, offered.has(id)]).toEqual([id, res.status !== 404]);
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
