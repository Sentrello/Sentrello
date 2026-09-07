import { asActor } from "@sentrello/db";
import type { SentrelloEnv, SentrelloSession } from "@sentrello/module-sdk";
import type { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { auth } from "./index";

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
    await asActor(session.user.id, () => next());
  });
}

/**
 * Permission guard: e.g. requirePermission({ invoicing: ["send"] }).
 *
 * `auth.api.hasPermission` resolves to `{ error, success }`, never a bare
 * boolean — truthiness-testing the response would let every check pass, so the
 * `success` flag is read explicitly and anything else denies.
 */
export function requirePermission(permissions: Record<string, string[]>) {
  return createMiddleware<AppEnv>(async (c, next) => {
    let granted = false;
    try {
      const result = await auth.api.hasPermission({
        headers: c.req.raw.headers,
        body: { permissions },
      });
      granted = result?.success === true;
    } catch {
      granted = false; // not a member, no active org, malformed request
    }
    if (!granted) return c.json({ error: "forbidden" }, 403);
    await next();
  });
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
