import { and, asActor, db, eq, schema } from "@sentrello/db";
import {
  hipaaRulesFor,
  idleMinutesFor,
  rolesNeedingTwoFactor,
} from "@sentrello/db/security-events";
import type { SentrelloEnv, SentrelloSession } from "@sentrello/module-sdk";
import { rateLimit, rateLimitSpent } from "@sentrello/module-sdk";
import type { Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { matchedRoutes } from "hono/route";
import { apiKeyMay, bearerKey, resolveApiKey } from "./api-keys";
import { auth, clientIp } from "./index";

export type Session = NonNullable<
  Awaited<ReturnType<typeof auth.api.getSession>>
>;

/** The Hono environment every Sentrello route runs in. */
export type AppEnv = SentrelloEnv;

/**
 * "Invalid origin" is the right refusal and a useless explanation.
 *
 * Better Auth rejects a sign-in whose Origin is not the configured baseURL,
 * which is correct — it is what stops another site posting credentials here.
 * But the person reading it is almost always the owner of a self-hosted
 * instance who reached their own app by a name `SENTRELLO_BASE_URL` does not
 * mention: an IP, `localhost`, `www.` where the setting has the bare domain.
 * Two words with no pointer to the setting turns a one-line fix into a support
 * conversation, so the reply names the setting, what it is, and what was
 * actually asked for.
 *
 * Exported for its own test: Better Auth skips the origin check entirely under
 * NODE_ENV=test, so the suite cannot reach this through the handler. The
 * rewriting is tested here and the refusal itself verified against a running
 * instance by hand.
 */
export async function explainOrigin(res: Response, origin: string | undefined) {
  if (res.status !== 403) return res;

  const body = await res.clone().text();
  if (!body.includes("Invalid origin")) return res;

  const configured =
    process.env.SENTRELLO_BASE_URL ?? "http://localhost:3000 (the default)";
  return Response.json(
    {
      message: `This instance only accepts sign-ins from ${configured}, and this request came from ${origin ?? "an unknown origin"}. Set SENTRELLO_BASE_URL to the address people actually use to reach it, then restart.`,
      code: "INVALID_ORIGIN",
    },
    { status: 403, headers: res.headers },
  );
}

export function mountAuth(app: Hono<AppEnv>) {
  app.on(["POST", "GET"], "/api/auth/*", async (c) =>
    explainOrigin(await auth.handler(c.req.raw), c.req.header("origin")),
  );
}

/** Route guard: requires a session, attaches it to context. */
export function requireSession() {
  return createMiddleware<AppEnv>(async (c, next) => {
    /*
     * A key, when one is presented, and nothing else.
     *
     * Checked before the cookie and never alongside it: a request carrying a
     * key that does not work is refused even if a session cookie came with
     * it, so a script cannot fall back to whoever is signed in on the same
     * machine. Nothing about the cookie path changes — a browser never adds
     * an `Authorization` header on its own, so a forged cross-site request
     * cannot carry a key, and one that carries a cookie meets every check it
     * met before.
     */
    const presented = bearerKey(c.req.raw.headers);
    if (presented !== null) return keyCaller(c, presented, next);

    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "unauthorized" }, 401);
    c.set("session", session as SentrelloSession);
    /**
     * Everything this request does is attributed to whoever made it.
     *
     * Set here, in the one place that already knows who they are, and read by
     * `postJournalEntry` — which is several calls below every route that posts
     * and cannot be told any other way without threading an actor through
     * thirty functions that have no other reason to know about sessions.
     */
    /**
     * HIPAA safeguards, where a business has switched them on.
     *
     * Enforced here rather than in each route because here is the one place
     * every guarded request already passes through, and a safeguard applied in
     * most places is not a safeguard. It costs one indexed lookup per request
     * on organisations that have the row, and nothing at all on the ones that
     * do not.
     */
    const refusal =
      (await idleRefusal(session)) ??
      (await hipaaRefusal(session, c.req.path)) ??
      (await secondFactorRefusal(session, c.req.path));
    if (refusal) return c.json({ error: refusal.error }, refusal.status);

    await asActor(session.user.id, () => next());
  });
}

/**
 * Wrong keys a caller may present before being refused without a lookup.
 *
 * The budget the invitation links use: thirty misses in fifteen minutes, per
 * caller. Counted on misses only, so a meter posting with a good key every
 * few seconds never meets it.
 */
const KEY_MISSES = 30;
const KEY_MISS_WINDOW_MS = 15 * 60_000;

async function keyCaller(
  c: Context<AppEnv>,
  presented: string,
  next: () => Promise<void>,
) {
  const budget = `api-key:${clientIp(c)}`;
  if (rateLimitSpent(budget, KEY_MISSES, KEY_MISS_WINDOW_MS)) {
    return c.json(
      { error: "too many attempts with a key that does not work" },
      429,
    );
  }

  const key = await resolveApiKey(presented);
  if (!key) {
    rateLimit(budget, KEY_MISSES, KEY_MISS_WINDOW_MS);
    return c.json({ error: "unauthorized" }, 401);
  }

  /*
   * Only where a route names the permission it needs.
   *
   * A route behind a session and nothing more is one that acts on whoever is
   * signed in — their profile, their own security settings, their place in a
   * list — and for a key that person is its maker. None of those are what a
   * key was made for, and none of them check the key's own permissions, so a
   * key carrying only `subscriptions:meter` could otherwise rename the person
   * who made it. Read off the handlers Hono matched for this request, which
   * is where `requirePermission` leaves its mark.
   */
  const declared = matchedRoutes(c).some((route) =>
    Boolean((route.handler as unknown as Record<symbol, unknown>)[DECLARES]),
  );
  if (!declared) {
    return c.json(
      {
        error:
          "an API key can only call a route that names the permission it needs",
      },
      403,
    );
  }

  c.set("session", {
    session: {
      id: `api-key:${key.id}`,
      activeOrganizationId: key.organizationId,
      userId: key.user.id,
    },
    user: key.user,
    apiKey: { id: key.id, name: key.name, permissions: key.permissions },
  });
  await asActor(key.user.id, () => next());
}

/**
 * Signed out after however long this business decided, not after thirty
 * minutes regardless.
 *
 * "Stay signed in for" has been on the Authentication screen, in days, saved
 * and validated, since the Users module shipped — and nothing read it. The
 * library was configured with a thirty-minute rolling window and that is what
 * every instance got, so a business that chose thirty days was signed out
 * every half hour with the number it picked on the screen in front of it.
 * Found 2026-09-28.
 *
 * It is enforced here rather than in the library's own `expiresIn`, which is
 * one number read once at startup: it cannot be a business's decision, and
 * the cookie's lifetime comes from the same number, so a longer session set
 * that way would outlive the cookie carrying it. The library's number is now
 * the ceiling — thirty days, the longest this setting allows — and this is
 * the clock.
 *
 * HIPAA mode's own timeout still runs beside this and wins where it is
 * shorter, because a safeguard a business switched on for its records is not
 * something a session preference may relax.
 */
async function idleRefusal(session: {
  session: { activeOrganizationId?: string | null; updatedAt?: Date | string };
}): Promise<{ error: string; status: 401 } | null> {
  const orgId = session.session.activeOrganizationId;
  if (!orgId) return null;

  /*
   * Absent `updatedAt` is not treated as "idle for ever", for the reason the
   * HIPAA check below gives: a session shape without the field would sign
   * everybody out on every request, and the failure would look like the
   * safeguard working.
   */
  if (!session.session.updatedAt) return null;

  const minutes = await idleMinutesFor(orgId);
  const idleMs = Date.now() - new Date(session.session.updatedAt).getTime();
  if (idleMs <= minutes * 60_000) return null;

  return {
    error:
      minutes >= 24 * 60
        ? `signed out after ${Math.round(minutes / (24 * 60))} day${minutes >= 48 * 60 ? "s" : ""} of inactivity`
        : `signed out after ${minutes} minutes of inactivity`,
    status: 401,
  };
}

/**
 * Why this request must not proceed under HIPAA safeguards, if it must not.
 *
 * Two rules, both from §164.312, and both meaningless unless the server is the
 * one applying them — a timeout the browser enforces is a timeout anybody can
 * turn off with the developer tools open.
 */
/**
 * The routes a safeguard must never lock anybody out of.
 *
 * The way back. Requiring a second factor from everybody is correct and it is
 * also a door that closes behind you: an administrator who switches it on
 * without having set one up is refused by every route in the product, including
 * the one that would switch it off again. That is not a hypothetical — it is
 * what this rule did the first time it was tested, and it is the same mistake
 * as closing a firewall port from the far side of the firewall.
 *
 * So the compliance settings themselves stay reachable. It is a narrow
 * exemption: the routes still require a session and the settings permission, so
 * this is an administrator with a password, not the public.
 */
const ALWAYS_REACHABLE = ["/api/compliance", "/api/users/me/security"];

/**
 * A second factor, where the business requires it of this person's roles.
 *
 * Separate from the HIPAA rule above and enforced identically, because they
 * answer different questions: HIPAA mode requires one of everybody, and this
 * requires one of the people who can do the things the business decided need
 * it — the person who moves money, not the person who clocks in on a shared
 * tablet.
 *
 * **It was written down and enforced by nothing.** The checkbox saved, two
 * screens read it back, one of them told the person "until you set it up you
 * will be refused the things it protects", and no guard anywhere asked. A
 * control that is displayed and not applied is worse than one that is absent:
 * the business believes it is covered and the person believes they are
 * blocked, and neither is true. Found 2026-09-28.
 *
 * Two more doors stay open, on top of the pair above, for the reason that pair
 * gives. Complying is always possible — enabling a second factor goes to
 * `/api/auth/*`, which `mountAuth` serves without this middleware — and so is
 * undoing it: an administrator who names their own role by mistake can still
 * reach the policy screen. Without that the mistake is unrecoverable from inside
 * the product, which is the failure this rule's neighbour already made once.
 *
 * **Four in total, and the count matters**, which is why it is exported and
 * asserted rather than described. The comment here said "two" while the list
 * below held four, and a security page repeated the two — so a reader auditing
 * what a required second factor actually covers was told a smaller surface than
 * the one that exists. A new entry is a widening of that surface and has to be
 * argued for in the test, not added quietly.
 */
export const STILL_REACHABLE_WITHOUT_A_FACTOR = [
  ...ALWAYS_REACHABLE,
  "/api/users/policy",
  "/api/users/me",
];
async function secondFactorRefusal(
  session: {
    session: { activeOrganizationId?: string | null };
    user: { id: string; twoFactorEnabled?: boolean | null };
  },
  path: string,
): Promise<{ error: string; status: 403 } | null> {
  const orgId = session.session.activeOrganizationId;
  if (!orgId) return null;
  if (session.user.twoFactorEnabled) return null;
  if (STILL_REACHABLE_WITHOUT_A_FACTOR.some((p) => path.startsWith(p)))
    return null;

  const required = await rolesNeedingTwoFactor(orgId);
  if (required.length === 0) return null;

  /*
   * Every role this person holds, their own and their groups'.
   *
   * Read straight from the row rather than through the users module's own
   * `effectiveRoles`: this runs under every request in the product and the
   * auth package cannot import a module that imports it. `member.role` is
   * where that function writes the union it derives, which is the field to
   * ask — and a member whose role has not been recomputed since groups
   * arrived still carries their own role in it.
   */
  const [member] = await db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(
      and(
        eq(schema.member.organizationId, orgId),
        eq(schema.member.userId, session.user.id),
      ),
    )
    .limit(1);
  if (!member) return null;

  const held = member.role
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean);
  if (!held.some((role) => required.includes(role))) return null;

  return {
    error:
      "this business requires a second factor for your role. Set one up in your profile.",
    status: 403,
  };
}

async function hipaaRefusal(
  session: {
    session: {
      activeOrganizationId?: string | null;
      updatedAt?: Date | string;
    };
    user: { twoFactorEnabled?: boolean | null };
  },
  path: string,
): Promise<{ error: string; status: 401 | 403 } | null> {
  const orgId = session.session.activeOrganizationId;
  if (!orgId) return null;

  const rules = await hipaaRulesFor(orgId);
  if (!rules) return null;

  /**
   * Automatic logoff, §164.312(a)(2)(iii).
   *
   * Measured from the session's own last update, which better-auth refreshes as
   * the person uses it. The scenario is not an attacker: it is a receptionist's
   * screen left open in a room patients walk through, and fifteen minutes is
   * the number most practices settle on.
   */
  /*
   * Absent `updatedAt` is not treated as "idle for ever". A session shape that
   * does not carry the field would sign everybody out on every request, which
   * is a broken product rather than a safe one — and the failure would look
   * like the safeguard working.
   */
  const lastSeen = session.session.updatedAt
    ? new Date(session.session.updatedAt).getTime()
    : Date.now();
  if (Date.now() - lastSeen > rules.idleTimeoutMinutes * 60_000) {
    return {
      error: `signed out after ${rules.idleTimeoutMinutes} minutes of inactivity`,
      status: 401,
    };
  }

  /**
   * Person or entity authentication, §164.312(d).
   *
   * Refused rather than nagged. A prompt somebody can dismiss is a prompt
   * everybody dismisses, and the whole point of switching this on is that the
   * business has decided a password alone is not enough for these records.
   * The message says what to do, because a flat "forbidden" on every screen
   * with no explanation is how a practice turns the safeguards back off.
   */
  if (
    rules.requireTwoFactor &&
    !session.user.twoFactorEnabled &&
    !ALWAYS_REACHABLE.some((p) => path.startsWith(p))
  ) {
    return {
      error:
        "this business requires a second factor before you can sign in. Set one up in your profile.",
      status: 403,
    };
  }

  return null;
}

/**
 * Permission guard: e.g. requirePermission({ invoicing: ["send"] }).
 *
 * `auth.api.hasPermission` resolves to `{ error, success }`, never a bare
 * boolean — truthiness-testing the response would let every check pass, so the
 * `success` flag is read explicitly and anything else denies.
 */
/**
 * What a guard asks for, readable from the route it is mounted on.
 *
 * The middleware knows the permission and the app knows the path, and until
 * now nothing put the two together — so the only way to ask "what does this
 * route require" was to read the source with a regular expression. That works
 * until a module generates its routes, which the CRM does for contacts,
 * companies, deals, tasks, tags, notes and activities: seven resources, one
 * template, `requirePermission({ [permission]: ["create"] })`, and a scanner
 * that can see none of it.
 *
 * Hono lists every handler it has registered with the method and path it was
 * registered under, so tagging the middleware is enough to turn that list
 * into the real table. `declaredRoutes` in the module SDK reads it.
 */
export const DECLARES = Symbol.for("sentrello.requirePermission");

export function requirePermission(permissions: Record<string, string[]>) {
  const middleware = createMiddleware<AppEnv>(async (c, next) => {
    let granted = false;
    const key = c.get("session")?.apiKey;
    const orgId = c.get("session")?.session.activeOrganizationId;
    if (key && orgId) {
      // The key's own list, and its maker's access as it stands today.
      granted = await apiKeyMay(
        {
          organizationId: orgId,
          permissions: key.permissions,
          user: c.get("session").user,
        },
        permissions,
      );
    } else {
      try {
        const result = await auth.api.hasPermission({
          headers: c.req.raw.headers,
          body: { permissions },
        });
        granted = result?.success === true;
      } catch {
        granted = false; // not a member, no active org, malformed request
      }
    }
    if (!granted) {
      /*
       * Say what was required, because the screen cannot work it out.
       *
       * This answered a flat "forbidden", so the client said "Your role does
       * not allow this" — which is the right sentence when there is nothing
       * better and sends somebody to the wrong place when there is. The till is
       * the case that showed it: a role holding every `pos` permission opens it
       * and is refused, because the catalogue behind it is the Shop's and needs
       * `shop: read`. Told only that their role does not allow this, they look
       * at the till's permissions, which are fine.
       *
       * The names are in the published documentation, so there is nothing here
       * a member should not read.
       */
      const wanted = Object.entries(permissions)
        .map(([resource, actions]) => `${resource}: ${actions.join(", ")}`)
        .join("; ");
      return c.json({ error: `this needs ${wanted}` }, 403);
    }
    await next();
  });
  return Object.assign(middleware, { [DECLARES]: permissions });
}

/**
 * Whether this request may do something, without refusing it.
 *
 * `requirePermission` answers 403 and stops. This answers the same question so
 * a handler can decide what to *include* — the dashboard asks it once per
 * module summary, because a bookkeeper's first screen should not be missing
 * everything an owner sees, and an owner's should not 403 because one panel
 * was not theirs.
 */
export async function mayAccess(
  headers: Headers,
  permissions: Record<string, string[]>,
): Promise<boolean> {
  // Asked again of the key rather than of the session it has none of, so a
  // key caller is answered by the same rule `requirePermission` applies.
  const presented = bearerKey(headers);
  if (presented !== null) {
    const key = await resolveApiKey(presented);
    return key ? apiKeyMay(key, permissions) : false;
  }
  try {
    const result = await auth.api.hasPermission({
      headers,
      body: { permissions },
    });
    return result?.success === true;
  } catch {
    return false;
  }
}

/**
 * The organization every business query must be scoped by. Throws rather than
 * returning undefined: a business query that silently loses its org filter is
 * a cross-tenant data leak.
 */
export function activeOrganizationId(session: SentrelloSession): string {
  const orgId = session.session.activeOrganizationId;
  if (!orgId) throw new Error("session has no active organization");
  return orgId;
}
