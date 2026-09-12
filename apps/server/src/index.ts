import { roles } from "@sentrello/auth";
import { registerBootstrapRoutes } from "@sentrello/auth/bootstrap";
import {
  activeOrganizationId,
  mayAccess,
  mountAuth,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, schema } from "@sentrello/db";
import { PeriodClosedError } from "@sentrello/db/ledger";
import { runModuleMigrations } from "@sentrello/db/module-migrations";
import {
  isEnabled,
  moduleStates,
  setModuleEnabled,
} from "@sentrello/db/modules";
import { and, eq, sql } from "@sentrello/db/orm";
import { mailConfigured } from "@sentrello/email";
import { startJobs } from "@sentrello/jobs";
import crm from "@sentrello/module-crm";
import dashboard from "@sentrello/module-dashboard";
import money from "@sentrello/module-money";
import profile from "@sentrello/module-profile";
import type { SentrelloEnv, SentrelloModule } from "@sentrello/module-sdk";
import { searchEverything, searchProviders } from "@sentrello/module-sdk";
import settings from "@sentrello/module-settings";
import users from "@sentrello/module-users";
import { Hono } from "hono";
import { resolveLicense } from "./license";
import { loadModules } from "./loader";
import { serveModuleUi } from "./module-ui";
import { discoverOptionalModules, failedBundles } from "./optional-modules";
import { serveWeb } from "./static";

const app = new Hono<SentrelloEnv>();

/**
 * One place that turns a closed accounting period into an answer a business
 * can read.
 *
 * The lock is enforced deep inside `postJournalEntry`, which is what makes it
 * bind every module rather than the one caller that prompted it — and that is
 * a long way from the route somebody pressed. Without this, every one of those
 * routes would need its own try/catch to avoid answering 500 to a rule working
 * exactly as intended.
 *
 * Nothing else is caught here. Every other failure keeps the behaviour it had.
 */
app.onError((err, c) => {
  if (err instanceof PeriodClosedError) {
    return c.json({ error: err.message }, 409);
  }
  console.error(err);
  return c.json({ error: "something went wrong" }, 500);
});

/**
 * The headers every response carries, unless it has a reason not to.
 *
 * None of these were set. The screens a business signs into could be framed by
 * any site on the internet, which is the whole of clickjacking: an invisible
 * frame over a page somebody wants you to click, and the click lands on
 * "delete" or "pay" in a session you are already holding.
 *
 * `nosniff` and the referrer policy are set on everything. Nothing here is
 * improved by a browser guessing a content type, and a full URL in a referrer
 * leaks invoice and contact ids to whatever a customer clicks through to.
 *
 * **The embed surface is exempt from the framing rules, on purpose.** A form
 * on somebody's public website is the one part of this product designed to be
 * used from another origin, and `frame-ancestors 'none'` there would break the
 * feature rather than protect anybody: the page is a form belonging to a
 * business that chose to publish it, and it carries no session.
 *
 * Set only when absent, so a route that has already said something more
 * specific keeps it — attachment downloads serve `default-src 'none'`, which
 * is stricter than anything here.
 *
 * **HSTS is deliberately not here.** The application cannot tell whether it is
 * behind TLS — it sees a plain HTTP request from a proxy either way — and
 * guessing from `x-forwarded-proto` trusts a header the client can forge when
 * the proxy is misconfigured. The nginx in front of it owns that header, which
 * is where Packet 04 puts it.
 */
app.use("*", async (c, next) => {
  await next();
  const set = (name: string, value: string) => {
    if (!c.res.headers.has(name)) c.res.headers.set(name, value);
  };

  set("x-content-type-options", "nosniff");
  set("referrer-policy", "strict-origin-when-cross-origin");

  const path = new URL(c.req.url).pathname;
  const embeddable = path === "/embed.js" || path.startsWith("/api/embed/");
  if (!embeddable) {
    set("x-frame-options", "DENY");
    // The modern spelling, for browsers that stopped reading the old one.
    set("content-security-policy", "frame-ancestors 'none'");
  }
});

mountAuth(app);
registerBootstrapRoutes(app);

const { state, gate } = await resolveLicense();

// Free modules ship in this repo; commercial bundles are discovered at runtime
// only if installed. The loader then drops any this instance is not entitled to.
const modules: SentrelloModule[] = [
  dashboard,
  crm,
  money,
  settings,
  profile,
  users,
  ...(await discoverOptionalModules()),
];
const { nav, navVisibility, navPermissions, tiers, loaded, jobs } = loadModules(
  app,
  gate,
  modules,
);

// A module brings its own tables. Applying them here — after the licence has
// decided what loads — means a customer who buys a module gets its schema on the
// next restart, and one they are not entitled to never touches their database.
for (const module of modules) {
  if (!module.migrations || !loaded.includes(module.id)) continue;
  try {
    await runModuleMigrations(module.migrations.dir, module.migrations.table);
    console.log(`[modules] migrated ${module.id}`);
  } catch (err) {
    // A module whose schema failed must not take the whole instance down: the
    // rest of the business still needs to invoice today.
    console.error(
      `[modules] ${module.id} migrations failed, its features may not work: ${(err as Error).message}`,
    );
  }
}

/**
 * Baked into the image at build time, so an instance can say what it is
 * running without anyone needing shell access to the host. "Which version are
 * you on?" is the first question of every support conversation, and until now
 * the only way to answer it was `docker inspect`.
 */
const VERSION = process.env.SENTRELLO_VERSION ?? "unknown";

/**
 * Whether the database behind this instance is actually usable.
 *
 * /healthz used to answer `ok` without asking the database anything, which is
 * true right up until it matters. On 2026-08-22 the demo's reset emptied its
 * database and the migration that should have refilled it was killed part-way
 * through; /healthz went on answering `ok` for seven hours while every sign-in
 * returned 500, because nothing it reported had ever read a table.
 *
 * `to_regclass` rather than a count: it reads the catalogue, touches no rows,
 * and distinguishes the two failures worth telling apart — a database that
 * cannot be reached, and one that answers fine but has nothing in it.
 */
async function databaseHealth(): Promise<"ok" | "unmigrated" | "unreachable"> {
  try {
    const [row] = await db.execute<{ present: boolean }>(
      sql`select to_regclass('public.user') is not null as present`,
    );
    return row?.present ? "ok" : "unmigrated";
  } catch {
    return "unreachable";
  }
}

/**
 * Where to report a vulnerability, at the address a researcher will look.
 *
 * RFC 9116. A scanner checks this path, a government procurement questionnaire
 * asks whether it exists, and a researcher who cannot find a contact address
 * either gives up or posts publicly — which is the outcome the file prevents.
 *
 * Served by the application rather than dropped in a web server's document
 * root, because every instance of this product is somebody else's server and
 * none of them will place a file by hand.
 *
 * No `Expires` date. RFC 9116 asks for one and it is the field that makes these
 * files go stale: a date a year out becomes a lie in a year, on thousands of
 * instances nobody will revisit. The contact address is the part a researcher
 * needs, and a stale expiry is worse than none because it says the rest cannot
 * be trusted either.
 */
app.get("/.well-known/security.txt", (c) =>
  c.text(
    [
      "Contact: mailto:security@sentrello.com",
      "Preferred-Languages: en",
      "Canonical: https://sentrello.com/.well-known/security.txt",
      "Policy: https://github.com/sentrello/sentrello/blob/main/SECURITY.md",
      "",
      "# This is a self-hosted instance. Reports about this particular",
      "# server should go to whoever runs it; reports about the software",
      "# itself go to the address above.",
      "",
    ].join("\n"),
    200,
    { "content-type": "text/plain; charset=utf-8" },
  ),
);

app.get("/healthz", async (c) => {
  const database = await databaseHealth();
  return c.json({
    // Monitoring alerts on anything that is not "ok". Still HTTP 200: the
    // reset script waits on this endpoint before it migrates, so a fresh,
    // deliberately empty database has to be able to answer.
    status: database === "ok" ? "ok" : "degraded",
    database,
    version: VERSION,
    tier: state.claims?.tier ?? "free",
    license_valid: state.valid,
    modules_loaded: loaded,
    // Named, not detailed: enough for monitoring to alert on, without
    // publishing an error message to anyone who can reach /healthz.
    modules_failed: failedBundles.map((f) => f.name),
  });
});

const uiModules = serveModuleUi(app, modules, loaded);

/**
 * `version` is here so the SPA can key module scripts by release.
 *
 * A module screen is cached for five minutes with no version in its URL, so
 * for five minutes after an upgrade a customer can be running the previous
 * release's screen against the new API. Five minutes of a subtly wrong screen
 * is a support ticket nobody can reproduce.
 */
/**
 * What this instance is running, for the shell to build itself from.
 *
 * Behind a session. It names the version and every module the business
 * bought, which is the first thing anyone probing an instance wants and none
 * of it is any use before signing in — the sign-in page reads `/api/_signin`.
 *
 * Nav entries a module marked as narrower than the instance are dropped here
 * rather than hidden in the browser, so an entry somebody is not offered is
 * genuinely absent from what they are sent.
 */
/**
 * Finding anything, from anywhere.
 *
 * One box that asks every module what it can find. Core knows none of them: a
 * shop's products and a booking's diary reach this list by the same mechanism a
 * contact does, which is the only way a module in another repository could ever
 * be searchable at all.
 *
 * **Permission is checked before a provider is asked**, not after. Filtering
 * results afterwards means the rows were read, and the reason somebody may not
 * see the customer book is usually that they are a contractor with access to
 * one job.
 */
app.get("/api/search", requireSession(), async (c) => {
  const orgId = activeOrganizationId(c.get("session"));
  const q = c.req.query("q") ?? "";

  /*
   * Asked once per distinct requirement rather than once per provider: several
   * modules want `crm: ["read"]`, and each check is a round trip through the
   * auth layer. A search box runs on every keystroke.
   */
  const answers = new Map<string, Promise<boolean>>();
  const may = (requires?: Record<string, string[]>) => {
    if (!requires) return Promise.resolve(true);
    const key = JSON.stringify(requires);
    const already = answers.get(key);
    if (already) return already;
    const asked = mayAccess(c.req.raw.headers, requires);
    answers.set(key, asked);
    return asked;
  };

  // Resolved first, so the search itself is synchronous about who may see what.
  const allowed = new Map<string, boolean>();
  for (const provider of searchProviders()) {
    const key = JSON.stringify(provider.requires ?? null);
    if (!allowed.has(key)) allowed.set(key, await may(provider.requires));
  }

  const hits = await searchEverything({
    organizationId: orgId,
    q,
    limit: 20,
    may: (requires) => allowed.get(JSON.stringify(requires ?? null)) === true,
  });

  return c.json({ hits });
});

app.get("/api/_meta", requireSession(), async (c) => {
  const session = c.get("session");
  // Read directly rather than through `activeOrganizationId`, which throws by
  // design so a business query can never lose its org filter. This is not a
  // business query: somebody signed in but not yet a member of anything still
  // needs a shell to look at, and they simply have no modules set up.
  const orgId = session.session.activeOrganizationId;
  const states = orgId ? await moduleStates(orgId) : new Map();

  /**
   * The role this person holds here, for filtering the nav by what they may
   * actually open. The routes are guarded either way; this only decides what
   * somebody is offered.
   */
  const [membership] = orgId
    ? await db
        .select({ role: schema.member.role })
        .from(schema.member)
        .where(
          and(
            eq(schema.member.userId, session.user.id),
            eq(schema.member.organizationId, orgId),
          ),
        )
        .limit(1)
    : [];
  const compiled = (
    roles as Record<
      string,
      { authorize: (r: unknown) => { success: boolean } } | undefined
    >
  )[membership?.role ?? ""];

  /**
   * A role the business wrote for itself.
   *
   * Better Auth keeps these as JSON in a column rather than compiling them, so
   * they are read and checked here. Without this, the people most likely to
   * have a tailored role — the whole reason custom roles exist — were the ones
   * offered every screen in the product, including the ones their role was
   * written specifically to keep them out of.
   */
  let custom: Record<string, string[]> | null = null;
  if (!compiled && membership?.role && orgId) {
    const [row] = await db
      .select({ permission: schema.organizationRole.permission })
      .from(schema.organizationRole)
      .where(
        and(
          eq(schema.organizationRole.organizationId, orgId),
          eq(schema.organizationRole.role, membership.role),
        ),
      )
      .limit(1);
    if (row) {
      try {
        custom = JSON.parse(row.permission) as Record<string, string[]>;
      } catch {
        // Unreadable permissions are treated as unknown rather than as none:
        // the routes still decide, and blanking somebody's menu on a parse
        // error would look exactly like their access had been revoked.
        custom = null;
      }
    }
  }

  /**
   * Somebody signed in who belongs to no business on this instance.
   *
   * They are not staff who have lost a permission — they are not staff at all.
   * sentrello.com creates exactly such an account for every customer who buys
   * Pro, on the same instance that runs our own books, and the first one of
   * those was shown the whole sidebar: every screen offered, every route
   * refusing them after the click.
   *
   * So the answer for a member of nothing is nothing, and the shell says so
   * rather than drawing a menu out of habit.
   */
  /**
   * Any membership at all, not merely one in the active organization: a
   * session created moments before somebody joined has no active organization
   * yet, and the first owner's own sign-up is exactly that case. Asking the
   * narrower question would have shown the person who just claimed the
   * instance an empty application.
   */
  const [anyMembership] = membership
    ? [membership]
    : await db
        .select({ role: schema.member.role })
        .from(schema.member)
        .where(eq(schema.member.userId, session.user.id))
        .limit(1);
  const belongsHere = Boolean(anyMembership);

  const visible = (belongsHere ? nav : []).filter((item) => {
    const allowed = navVisibility.get(item.id);
    if (allowed && !allowed(session)) return false;

    // A module the licence grants but nobody has set up belongs under Modules
    // with a way to start, not in the sidebar as a screen that half works.
    if (
      tiers.get(item.moduleId) === "module" &&
      !isEnabled(states, item.moduleId)
    ) {
      return false;
    }

    // And a screen this person cannot open should not be offered. Being
    // refused after clicking tells somebody twice that they cannot do their
    // job: once by the error, and once by the menu that suggested otherwise.
    const needs = navPermissions.get(item.id);
    if (!needs) return true;
    if (compiled) return compiled.authorize(needs).success;
    if (custom) {
      return Object.entries(needs).every(([resource, actions]) =>
        actions.every((action) => custom?.[resource]?.includes(action)),
      );
    }
    // Neither: nothing to check it against, so the entry stays and the route
    // decides. Hiding a screen from somebody entitled to it is the worse
    // mistake of the two.
    return true;
  });

  return c.json({
    nav: visible,
    loaded,
    /**
     * Whether this person is part of the business running this instance.
     *
     * False for a billing-only account, which exists so somebody can manage
     * what they pay us and reaches nothing else here. The shell shows them a
     * way out rather than an empty application.
     */
    belongsHere,
    /**
     * Where such a person should be instead, when this instance is the one
     * selling Sentrello. Absent everywhere else, which is every customer's own
     * server — there is nothing to send them to there.
     */
    accountPath: loaded.includes("control-plane") ? "/account" : null,
    /**
     * Every optional module this licence allows, and whether it is set up.
     *
     * The Modules screen is built from this. It carries the state rather than
     * only the unused ones, so the screen never has to work out which of the
     * loaded modules are optional — a guess the browser would get wrong the
     * first time a Free module was renamed.
     */
    modules: loaded
      .filter((id) => tiers.get(id) === "module")
      .map((id) => ({
        id,
        label: nav.find((n) => n.moduleId === id)?.label ?? id,
        enabled: isEnabled(states, id),
      })),
    ui: uiModules,
    /**
     * What this instance is licensed for.
     *
     * The screens read it to decide what to offer — Accounting's Pro half, for
     * one, which is registered on every instance and answered only here. It is
     * a claim about the instance rather than about the person, so it is safe
     * for anybody signed in: the routes still gate every request.
     */
    tier: state.claims?.tier === "pro" ? "pro" : "free",
    version: VERSION,
  });
});

/**
 * Turning an optional module on, or putting it away again.
 *
 * Turning one off hides it and stops it being offered; it never deletes
 * anything. A business that switches scheduling off in the winter and back on
 * in the spring should find its diary where it left it.
 */
app.post(
  "/api/modules/:id",
  requireSession(),
  requirePermission({ settings: ["update"] }),
  async (c) => {
    const id = c.req.param("id");
    if (tiers.get(id) !== "module") {
      // Free modules are the product, not a purchase. A business that could
      // turn off invoicing would be one support call from an instance that
      // cannot invoice.
      return c.json({ error: "that module is not optional" }, 400);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      enabled?: unknown;
    };
    await setModuleEnabled(
      activeOrganizationId(c.get("session")),
      id,
      body.enabled === true,
    );
    return c.json({ id, enabled: body.enabled === true });
  },
);

/**
 * What the sign-in page needs before anyone has signed in.
 *
 * Only whether mail works, never how it is configured. A password reset on an
 * instance with no mail set up would tell the only administrator to check an
 * inbox nothing will arrive in, so the page has to know in advance to offer
 * the host command instead.
 */
app.get("/api/_signin", (c) => c.json({ mailConfigured: mailConfigured() }));

/**
 * Where to get the source of the thing you are talking to.
 *
 * The AGPL's section 13 is the clause that separates it from the GPL: someone
 * who interacts with this over a network, without ever receiving a copy, is
 * still owed the corresponding source. Publishing this repository discharges
 * that for us and for nobody else — **the obligation belongs to whoever is
 * running the instance**, and a business that has modified it and put it in
 * front of its customers owes them *its* version, not ours.
 *
 * Which is what `SENTRELLO_SOURCE_URL` is for. The default is honest for an
 * unmodified instance and wrong for a modified one, so the knob is documented
 * where the operator will meet it rather than left for them to discover they
 * needed.
 *
 * Public on purpose. A clause about people who are not signed in cannot be
 * satisfied behind a sign-in.
 */
app.get("/api/_source", (c) =>
  c.json({
    licence: "AGPL-3.0-or-later",
    source:
      process.env.SENTRELLO_SOURCE_URL ??
      "https://github.com/Sentrello/Sentrello",
    version: process.env.SENTRELLO_VERSION ?? "unknown",
    modified: Boolean(process.env.SENTRELLO_SOURCE_URL),
  }),
);

/**
 * What this instance is licensed for.
 *
 * The first question anyone asks when a feature disappears is "has something
 * expired?", and until now the only way to answer it was to read a JWT off the
 * server. Behind a session and the settings permission: it names the licence
 * and the modules bought, which is not something to hand to the internet.
 */
app.get(
  "/api/license",
  requireSession(),
  requirePermission({ settings: ["read"] }),
  (c) => {
    const claims = state.claims;
    const expiresAt =
      typeof claims?.exp === "number"
        ? new Date(claims.exp * 1000).toISOString()
        : null;

    return c.json({
      tier: claims?.tier ?? "free",
      valid: state.valid,
      // Present when the licence failed to verify, so the screen can say why
      // rather than only that something is wrong.
      reason: state.reason ?? null,
      modules: claims?.modules ?? [],
      seats: claims?.seats ?? null,
      instanceId: claims?.instance_id ?? null,
      // The token is short-lived and refreshed nightly; this is the deadline
      // for that refresh, not the end of the subscription.
      tokenExpiresAt: expiresAt,
      graceUntil: claims?.grace_until ?? null,
      modulesLoaded: loaded,
      // Behind the settings permission, so this one carries the reason.
      failedBundles,
    });
  },
);

// last: everything unclaimed is the SPA
serveWeb(app);

/**
 * Whether this process should also run the background queue.
 *
 * On by default: an instance that serves screens and never sends an overdue
 * chase is an instance quietly failing at half its job, and nobody would be
 * told.
 *
 * Off matters when a second process is pointed at a database that already has
 * one — which is every migration to a new server. The queue itself is safe
 * under two workers, because a job is claimed atomically and a scheduled job
 * is a singleton; but a machine being tested before a cutover has no business
 * sending a customer's email, and "it probably will not" is not the standard
 * to move production on.
 */
const jobsEnabled =
  (process.env.SENTRELLO_JOBS ?? "on").toLowerCase() !== "off";

// Jobs run only in the real server process, never when a test imports this file.
if (import.meta.main && jobsEnabled) {
  // The tier decides whether the overdue chase goes out under Sentrello's name
  // or the business's own; a job has no request to read the licence from.
  await startJobs(jobs, {
    tier: state.claims?.tier === "pro" ? "pro" : "free",
    // Only reaches anywhere if this instance was asked at install time and
    // said yes; the job checks that itself.
    modules: loaded,
  });
}

const port = Number(process.env.PORT ?? 3000);
console.log(
  `Sentrello on :${port} (tier=${state.claims?.tier ?? "free"}, modules=${loaded.join(",")}${
    jobsEnabled ? "" : ", jobs=off"
  })`,
);
export default { port, fetch: app.fetch };

/**
 * The assembled application, for tests that need to enumerate what it serves
 * rather than call one known path. The default export is what Bun wants —
 * `{ port, fetch }` — and a route table cannot be read from that.
 */
export { app };
