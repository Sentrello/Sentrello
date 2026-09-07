import { and, asc, db, eq, schema } from "@sentrello/db";
import { lockState, policyFor } from "@sentrello/db/lockout";
import { record } from "@sentrello/db/security-events";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";

/**
 * Better Auth's own cookie name for a pending two-factor challenge, mirrored
 * here rather than imported.
 *
 * `better-auth/plugins/two-factor` — the only public entry point for this
 * plugin — exports `twoFactor`, `twoFactorClient` and `TWO_FACTOR_ERROR_CODES`
 * and nothing else; the constant itself lives at
 * `better-auth/dist/plugins/two-factor/constant.mjs`, a path outside the
 * package's declared exports. Reaching into it directly would import an
 * implementation file the package is free to move or delete without notice.
 * The literal is verified against the pinned `better-auth@1.6.26` (see
 * `userAwaitingTwoFactorChallenge` below for what it is used for and why),
 * and a test in `sign-in-events.test.ts` asserts a real challenge cookie
 * actually carries this name — so a future upgrade that renames it fails a
 * test here instead of silently leaving every failed second-factor attempt
 * unattributed.
 */
export const TWO_FACTOR_COOKIE_NAME = "two_factor";

/**
 * The account id a signed, unexpired two-factor challenge cookie names, or
 * `undefined` if the request carries none.
 *
 * Neither `/two-factor/verify-totp` nor `/two-factor/verify-backup-code`
 * receives an email in its body — only a code, and `trustDevice` or
 * `disableSession` — so a *failed* verification can only be attributed to an
 * account by reading the same cookie Better Auth's own `verifyTwoFactor()`
 * (in `better-auth/dist/plugins/two-factor/verify-two-factor.mjs`) reads to
 * find the challenge in the first place: a signed cookie whose value is an
 * opaque identifier, looked up in the verification table for the user id it
 * names. This repeats exactly those two steps, through the same public
 * context methods `verifyTwoFactor()` itself uses (`ctx.getSignedCookie`,
 * `ctx.context.internalAdapter.findVerificationValue`) — not a reimplemented
 * decode, the same one, run a second time, read-only.
 *
 * Read-only is the point: `verifyTwoFactor()`'s own `valid()` and
 * `beginAttempt()` *consume* this same verification value — `valid()` when
 * the code is right, `beginAttempt()` once five wrong codes have been tried
 * against one challenge. This function only calls `findVerificationValue`,
 * never `consumeVerificationValue`, so calling it from an after-hook, once
 * the real request has already decided the outcome, can never itself expire
 * a challenge the caller is still allowed to keep trying.
 *
 * That also bounds what this can miss: `beginAttempt(5)` throws and consumes
 * the verification record once its counter reaches 5, and the counter starts
 * at 0 and increments after each wrong code — so all five wrong codes still
 * attribute correctly, and it is only on the attempt after the fifth wrong
 * code, when `beginAttempt` consumes the record before this function ever
 * gets to read it, that an attempt goes unattributed. Accepted rather than
 * worked around — at that point Better Auth has already expired the
 * challenge and the caller has to sign in again, so the gap is one closed
 * challenge's one uncounted attempt, not an open-ended one, and
 * reproducing `beginAttempt`'s own consumption bookkeeping here to close it
 * would be duplicating state that belongs to the plugin — the same mistake
 * the trust-device cookie handling used to make, and was rewritten to stop
 * making (see the `newSession` comment on `signInEvents` below).
 */
async function userAwaitingTwoFactorChallenge(
  ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0],
): Promise<string | undefined> {
  const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE_NAME);
  const signed = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!signed) return undefined;
  const verification =
    await ctx.context.internalAdapter.findVerificationValue(signed);
  return verification?.value;
}

/**
 * The organization a sign-in attempt belongs to.
 *
 * Resolved from the signing-in user's own membership first — the instance may
 * run more than one organization even though the common case is exactly one,
 * and picking whichever row Postgres happened to return first from an
 * unordered query, which an earlier version of this code did, attributed the
 * event to a business it may have nothing to do with. Oldest membership
 * first, for the same reason `databaseHooks.session.create.before` in
 * `./index.ts` picks a session's active organization the same way: it is a
 * deterministic answer, not the only defensible one, for a person who belongs
 * to several.
 *
 * Falling back to this instance's oldest organization whenever that leaves
 * `org` unresolved — not merely when there is no `user` at all. The realistic
 * case is a real account with no membership row yet: `ensureBootstrapped` in
 * `./bootstrap.ts` reaches `/sign-in/email` when its own sign-up call fails
 * with "email already taken" and it retries via sign-in with the same
 * credentials — the account exists, its organization does not yet, and that
 * is the same setup-token-guessing window the zero-organization case below
 * documents. A member later removed from every organization is the same
 * shape of gap: the `member` row is gone, the `user` row is not. On the
 * one-organization-per-instance norm the fallback is the only organization
 * there is; on an instance running several it is a guess, made because a
 * failed attempt still needs somewhere to land and there is no membership
 * anywhere to ask instead.
 *
 * Zero organizations is a real state, not a theoretical one: the same
 * `ensureBootstrapped` retry above runs while the instance is still unclaimed
 * and before its one organization exists. A sign-in during that window —
 * which is also the window the setup token is being guessed in — has nowhere
 * to record to: `security_events` rows are organization-scoped, and there is
 * no organization yet to scope one to. That gap is accepted rather than
 * papered over by inventing an organization no member has joined — a row
 * attributed to a business that does not exist yet would be worse than no
 * row.
 */
async function organizationFor(
  user: { id: string } | undefined,
): Promise<{ id: string } | undefined> {
  let org: { id: string } | undefined;
  if (user) {
    [org] = await db
      .select({ id: schema.member.organizationId })
      .from(schema.member)
      .where(eq(schema.member.userId, user.id))
      .orderBy(asc(schema.member.createdAt))
      .limit(1);
  }
  if (!org) {
    [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .orderBy(asc(schema.organizations.createdAt))
      .limit(1);
  }
  return org;
}

/**
 * The second factor, recorded in both directions.
 *
 * `/two-factor/verify-totp` and `/two-factor/verify-backup-code` share this
 * handler — `apps/web/src/routes/sign-in.tsx` routes any code longer than six
 * characters to the backup-code endpoint, so a business whose owner is typing
 * a backup code because they lost their phone would otherwise be invisible
 * here even though that is exactly the account most worth watching.
 *
 * Both endpoints serve two callers, not one: a sign-in still mid-challenge
 * (no ordinary session yet, only the two-factor cookie), and an already
 * signed-in user proving a code for its own sake — `enableTwoFactor` followed
 * by `verifyTOTP`, the only way `twoFactorEnabled` is ever set (see
 * `two-factor.test.ts`), reuses this same endpoint outside of sign-in
 * entirely. Recording the second case as a sign-in would put a fabricated
 * success in the audit log every time somebody turns 2FA on. Better Auth's
 * own `verifyTwoFactor()` tells the two apart by calling `getSessionFromCtx`
 * as the very first thing either endpoint does, which — as a side effect —
 * writes its answer to `ctx.context.session`: left `null` when the caller had
 * no ordinary session (the sign-in-mid-challenge case), populated when they
 * did. Reading that same side effect back here, rather than re-deriving it
 * from cookies, is what keeps this in step with whatever `verifyTwoFactor()`
 * itself decides, including if that logic ever changes.
 *
 * A flood of wrong codes is capped before it gets here — in the environment
 * this app actually ships as. Better Auth's own `twoFactor()` plugin declares
 * a rate limit on every `/two-factor/*` path (`rateLimit` in
 * `better-auth/dist/plugins/two-factor/index.mjs`, 3 requests per 10-second
 * window per IP), enforced by the router's `onRequest` step — before routing
 * to the endpoint, so ahead of this after-hook entirely
 * (`better-auth/dist/api/index.mjs`). That enforcement is gated behind
 * `ctx.rateLimit.enabled`, which defaults to `isProduction` —
 * `NODE_ENV === "production"` — and the shipped image sets exactly that:
 * `Infrastructure/build/Dockerfile.core:56` sets `NODE_ENV=production` in the
 * final runtime stage, and `Infrastructure/deploy/docker-compose.yml` and the
 * installer carry it through to what a self-hosted customer actually runs.
 * So in production, a refused attempt returns from `onRequest` with 429 and
 * never reaches this hook — only the first three wrong codes in each
 * 10-second window are ever recorded here, and Task 4's lockout count
 * excludes the rest. That exclusion is safe only because those excluded
 * attempts are already being refused by the router, not because they went
 * unnoticed.
 *
 * Under `bun test`, `NODE_ENV` is `"test"`, not `"production"`, so this
 * limiter is off and every attempt in a flood is recorded here instead — the
 * flood test in `sign-in-events.test.ts` asserts that, scoped to that
 * environment, and skips itself when run with `NODE_ENV=production` rather
 * than asserting something the shipped configuration contradicts.
 */
async function recordTwoFactorVerify(
  ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0],
): Promise<void> {
  if (ctx.context.session) return;

  try {
    // The same signal `signInEvents` below reads for `/sign-in/email`, and
    // for the same reason: `setSessionCookie` is the only thing that ever
    // calls `ctx.context.setNewSession(...)`, and the sign-in branch of
    // `valid()` inside Better Auth's `verifyTwoFactor()` is the only branch
    // of either endpoint that calls it. A wrong code throws out of the
    // endpoint (`invalid("INVALID_CODE")`) before that call is ever reached.
    const succeeded = Boolean(ctx.context.newSession);

    let user: { id: string; name: string; email: string } | undefined;
    if (succeeded) {
      // Free on success: the session Better Auth just created carries the
      // full user row, so there is nothing left to look up.
      user = ctx.context.newSession?.user;
    } else {
      const userId = await userAwaitingTwoFactorChallenge(ctx);
      if (userId) {
        [user] = await db
          .select({
            id: schema.user.id,
            name: schema.user.name,
            email: schema.user.email,
          })
          .from(schema.user)
          .where(eq(schema.user.id, userId))
          .limit(1);
      }
    }
    // No cookie, an expired one, or one already spent by a fifth wrong code
    // (see `userAwaitingTwoFactorChallenge`) — nobody to attribute this to.
    if (!user) return;

    const org = await organizationFor(user);
    if (!org) return;

    await record({
      organizationId: org.id,
      // Same rule as `/sign-in/email` below: only a success gets an actor,
      // because only a success is known to be that person rather than
      // somebody guessing codes against their address.
      actor: succeeded ? user : null,
      subject: user,
      action: succeeded ? "sign-in.succeeded" : "sign-in.failed",
      detail: { email: user.email.toLowerCase() },
    });
  } catch (err) {
    // See the matching catch in `signInEvents` below for why this is
    // swallowed rather than rethrown: this hook must never become the reason
    // a correct code fails to sign somebody in.
    console.error(
      `[auth] could not record a two-factor attempt: ${(err as Error).message}`,
    );
  }
}

/**
 * What happened at the front door.
 *
 * The audit log records what administrators do and nothing about what anybody
 * tries. On an instance whose login page faces the internet that is the half
 * that matters: a business's first sign that it is being guessed at is a run
 * of failures against one address at three in the morning. That is as true of
 * the second factor as it is of the password — an instance that requires
 * two-factor is the one that cares *most* about a run of guessed codes, not
 * less, and until this file's Task 3c that half was invisible in both
 * directions: neither a completed two-factor sign-in nor a failed one against
 * an account that has 2FA turned on was ever recorded.
 *
 * An `after` hook rather than wrapping the endpoints, because sign-in and
 * two-factor verification are Better Auth's routes and not ours. Registered
 * as a plugin (`signInEventsPlugin` below) placed after `twoFactor(...)` in
 * `./index.ts`'s `plugins` array, rather than as the top-level `hooks.after`
 * — see the long comment on `ctx.context.newSession` below for why the
 * position is load-bearing, not cosmetic.
 *
 * Never able to fail the sign-in it describes. A person unable to get into
 * their own instance because the log could not be written would be worse than
 * a gap in the log, and the gap is visible where the failure would not be.
 * That guarantee has to cover the whole function, not just the database
 * calls: reading `ctx.body.email` is exactly as capable of throwing as a
 * query is, so the entire body below the path check runs where an exception
 * cannot escape to the caller.
 */
export const signInEvents = createAuthMiddleware(async (ctx) => {
  if (
    ctx.path === "/two-factor/verify-totp" ||
    ctx.path === "/two-factor/verify-backup-code"
  ) {
    return recordTwoFactorVerify(ctx);
  }
  if (ctx.path !== "/sign-in/email") return;

  // `ctx.body` is whatever the caller sent, not what the route declares — a
  // request that posts `{"email": 12345}` reaches this hook with a number
  // sitting where a string is assumed. Better Auth's own handler validates
  // this properly and answers 400 INVALID_EMAIL; this hook runs regardless of
  // whether the handler accepted or rejected the request. Only an `APIError`
  // thrown from an after-hook is turned back into a response by Better
  // Auth's hook runner; anything else — a plain `TypeError` from calling
  // `.trim()` on a number, say — is rethrown and becomes an unhandled 500.
  // That turned the 400 a stranger already got for a malformed request into
  // a stack trace instead, from an unauthenticated and fully
  // attacker-controlled field. Checking the type before touching it is what
  // keeps that path a silent no-op rather than a crash.
  const raw = (ctx.body as { email?: unknown } | undefined)?.email;
  if (typeof raw !== "string") return;
  const email = raw.trim().toLowerCase();
  if (!email) return;

  try {
    // Whether a two-factor challenge is still pending is read from
    // `ctx.context.returned`, not guessed at from the user's own
    // `twoFactorEnabled` flag — an earlier version of this code guessed,
    // and the guess was wrong for a trusted device (see below). The plugin
    // itself sets `returned` to `{ twoFactorRedirect: true, ... }` — the
    // exact shape `apps/web/src/lib/auth.ts` and `sign-in.tsx` already key
    // off to show the code prompt, so this is the plugin's own public
    // contract, not an internal detail — when a challenge is still open,
    // and leaves `returned` as the plain `{ user, token, ... }` sign-in
    // response otherwise, trust-device or not.
    const returned = ctx.context.returned as
      | { twoFactorRedirect?: boolean }
      | Error
      | undefined;
    const pending =
      returned && !(returned instanceof Error) && returned.twoFactorRedirect;

    // Still 2FA-pending: not a success (it isn't one yet) and not a failure
    // either — the password was right, and Task 4 counts `sign-in.failed`
    // rows toward a lockout, so marking a correct credential as a failure
    // would start locking people out for typing the right password.
    // Nothing is recorded for this half of the attempt; what happens next
    // at `/two-factor/verify-totp` is a separate endpoint and a separate
    // task's concern.
    if (pending) return;

    // Whether the sign-in actually completed is read from
    // `ctx.context.newSession` rather than from `returned.user`, because
    // this hook is registered to run *after* the two-factor plugin's own
    // `/sign-in/email` hook (see `signInEventsPlugin` in `./index.ts`), and
    // from that position `newSession` is the plugin's own, already-final
    // word on it: present when a session actually exists once the plugin is
    // done, null when it does not. That covers every case correctly and in
    // one read — a plain non-2FA success, a two-factor success let through
    // by a valid "trust this device" cookie, and a two-factor success
    // reached the normal way (which never lands here at all, since it goes
    // through `/two-factor/verify-totp`) — without this hook having to know
    // anything about cookies, HMACs, or verification records the way an
    // earlier version of it did, duplicating logic that belongs to the
    // plugin and drifts silently if the plugin's own implementation of any
    // of that ever changes.
    //
    // A hook ordered *ahead* of the plugin cannot read `newSession` this
    // way: the plugin's own docstring warns that `newSession` is nulled
    // while a two-factor challenge is in flight, but that is only true once
    // the plugin's hook has actually run and done the nulling. A plain
    // `hooks.after` handler always runs before every plugin's after-hooks,
    // which is what made that warning misleading the first time this hook
    // read `newSession` — this hook is registered as a plugin specifically
    // so that warning finally applies to it.
    const succeeded = Boolean(ctx.context.newSession);

    const [user] = await db
      .select({
        id: schema.user.id,
        name: schema.user.name,
        email: schema.user.email,
      })
      .from(schema.user)
      .where(eq(schema.user.email, email))
      .limit(1);

    // See `organizationFor` above — shared with `recordTwoFactorVerify`
    // below, since a sign-in and a second-factor attempt resolve their
    // organization the same way, from the same person.
    const org = await organizationFor(user);
    if (!org) return;

    await record({
      organizationId: org.id,
      // Null on every failure, not just the stranger case. Writing the real
      // account as the actor here — what an earlier version of this code
      // did — records "Alice failed to sign in as Alice" for a wrong
      // password typed by whoever is guessing at Alice's address, which is
      // both false and the exact sentence an administrator reads during an
      // incident. Only a success has an actor: the person who is, at that
      // point, genuinely who they signed in as.
      actor: succeeded ? (user ?? null) : null,
      subject: user ?? undefined,
      action: succeeded ? "sign-in.succeeded" : "sign-in.failed",
      // The address, never the password. The address is what an administrator
      // needs to read; the password is what nobody may ever store.
      detail: { email },
    });
  } catch (err) {
    // Deliberately swallowed, not merely logged and re-thrown: the guarantee
    // this hook makes is that it can never become the reason somebody is
    // locked out of their own instance, and re-throwing here would hand that
    // outcome to whatever this hook's own bug happens to be on a given day.
    // The `console.error` exists so the failure is not invisible to an
    // operator — a security log that has silently stopped writing is its own
    // kind of incident, and an earlier version of this code gave nobody a
    // way to notice that had happened.
    console.error(
      `[auth] could not record a sign-in attempt: ${(err as Error).message}`,
    );
  }
});

/**
 * Suspension does not stop at the three doors `signInLockGuard` watches.
 *
 * `signInLockGuard` is a `before` hook, and a `before` hook has to know who
 * is signing in before the request is answered — which is why it only ever
 * lists `/sign-in/email` and the two `/two-factor/verify-*` paths, the only
 * three places a credential or a code arrives in the request body. The
 * `sso()` plugin in `./index.ts` answers sign-in through four more
 * (`/sso/callback/:providerId`, the shared `/sso/callback`, and their SAML
 * equivalents), and on every one of them nobody knows who is signing in
 * until the identity provider's response has already been read and
 * exchanged — there is no body to read a member out of ahead of time the way
 * `signInLockGuard` does. Naming those four paths here would not fix that,
 * only move the same problem to whatever ships next — a magic link, an
 * OTP endpoint, anything else that ends in a session.
 *
 * So this asks a different question, after the fact rather than before it:
 * did a session just get created, and if so, for a member this business has
 * suspended? Every endpoint in Better Auth that actually issues a session —
 * a plain sign-in, a two-factor completion, an SSO callback, a session
 * rotated by `/change-password` — calls the same function to do it,
 * `setSessionCookie`, and that function calls `ctx.context.setNewSession(...)`
 * synchronously, *inside* the endpoint handler
 * (`better-auth/dist/cookies/index.mjs:127-134` in the pinned 1.6.26, and
 * `@better-auth/sso`'s own callback handlers calling it directly at
 * `dist/index.mjs:2211` and `:3162`). The endpoint handler always finishes
 * before a single after-hook runs, on any plugin, in any order — so by the
 * time this hook reads `ctx.context.newSession`, it is already that
 * endpoint's final answer, for every path that ever calls `setSessionCookie`,
 * this file's three, `sso()`'s four, or one written after this comment was.
 *
 * The session is deleted, not merely refused. `setSessionCookie` has already
 * queued the `Set-Cookie` header for the response by the time this hook
 * runs, and Better Auth throwing here changes the JSON body and the status
 * code, not headers a middleware upstream already wrote — refusing without
 * deleting would leave a live, working session in the caller's browser under
 * a response that told them it did not exist. `deleteSessionCookie(ctx)`
 * (the same public helper `@better-auth/sso` imports from the same
 * `better-auth/cookies` entry point, not a reach into an internal path)
 * expires the cookie too, best-effort — the session row being gone is what
 * actually matters, since the cookie alone resolves to nothing once it is.
 *
 * Fails open on its own uncertainty, the same rule `signInLockGuard` runs on
 * and for the same reason: if the database cannot say whether the member
 * this session belongs to is suspended, the session is left standing rather
 * than torn down under everyone on an outage.
 *
 * Built with `createAuthMiddleware(...)`, not a plain async function, and
 * that is load-bearing, not a style choice: `runAfterHooks`
 * (`better-auth/dist/api/dispatch.mjs:107-130`) calls `hook.handler(context)`
 * and reads `result.headers` off whatever it resolves to, with no null
 * check. `createMiddleware`'s own internal handler
 * (`better-call/dist/middleware.mjs:16-23`) is what turns a bare `undefined`
 * return into the `{ headers, response }` shape that call site expects; a
 * handler that skips that wrapping resolves to a bare `undefined` on its own
 * early returns, and `result.headers` throws a `TypeError` reading a
 * property off it — verified by removing the wrapping and watching a plain
 * sign-up crash the same way.
 */
const refuseIfSuspendedSession = createAuthMiddleware(async (ctx) => {
  const created = ctx.context.newSession;
  if (!created) return;

  let suspended: boolean;
  try {
    // Scoped to the session's own active organization, not merely the
    // person: the same account can be a live member of one business and a
    // suspended one of another, and a session issued for the business it is
    // live in must not be judged by the one it is not.
    const orgId = created.session.activeOrganizationId;
    if (!orgId) return;
    const [member] = await db
      .select({ disabledAt: schema.member.disabledAt })
      .from(schema.member)
      .where(
        and(
          eq(schema.member.userId, created.user.id),
          eq(schema.member.organizationId, orgId),
        ),
      )
      .limit(1);
    suspended = Boolean(member?.disabledAt);
  } catch (err) {
    console.error(
      `[auth] could not check a freshly issued session against suspension, so it was left standing: ${(err as Error).message}`,
    );
    return;
  }
  if (!suspended) return;

  await db
    .delete(schema.session)
    .where(eq(schema.session.token, created.session.token));
  deleteSessionCookie(ctx);
  throw new APIError("FORBIDDEN", {
    message: "This account has been suspended. Ask an administrator.",
  });
});

/**
 * `signInEvents` as a Better Auth plugin, so it runs *after* the two-factor
 * plugin's own `/sign-in/email` after-hook rather than before it.
 *
 * `getHooks` in Better Auth's dispatcher builds the after-hook list as: the
 * top-level `hooks.after` passed to `betterAuth({...})` first, unconditionally
 * — which is where this hook used to live, and why it used to run ahead of
 * every plugin — then every plugin's own `hooks.after`, in the order plugins
 * appear in the `plugins` array. Wrapping this hook in a minimal plugin object
 * and placing it after `twoFactor(...)` in that array (see `./index.ts`) is
 * what moves it behind the two-factor plugin's hook without touching
 * anything else about how or when it runs.
 *
 * The two verify endpoints have no competing after-hook of their own inside
 * `twoFactor(...)` — only `/sign-in/email` (and `/sign-in/username`,
 * `/sign-in/phone-number`) does — so this hook's position is load-bearing
 * for `/sign-in/email` specifically, and merely convenient, not required, for
 * `/two-factor/verify-totp` and `/two-factor/verify-backup-code`. All three
 * are handled by the one hook and the one matcher below regardless, so this
 * stays a single fact to keep straight rather than two.
 *
 * No endpoints, no schema, no client plugin — this exists purely to get one
 * hook a later turn in an ordered list.
 *
 * Carries a second, unrelated after-hook for the same reason: `signInEvents`
 * needs a later turn than `twoFactor(...)`'s own hook, and
 * `refuseIfSuspendedSession` does not — it matches every path, not three
 * named ones, and reads `ctx.context.newSession` only after `setSessionCookie`
 * has already set it inside whichever endpoint ran (see the long comment on
 * that function). Riding along on this plugin rather than a second one avoids
 * a plugin that exists purely to hold one more hook, the same reason this one
 * exists in the first place.
 */
export const signInEventsPlugin: BetterAuthPlugin = {
  id: "sentrello-sign-in-events",
  hooks: {
    after: [
      {
        matcher: (context) =>
          context.path === "/sign-in/email" ||
          context.path === "/two-factor/verify-totp" ||
          context.path === "/two-factor/verify-backup-code",
        handler: signInEvents,
      },
      {
        // Every path, deliberately: see `refuseIfSuspendedSession` above for
        // why enumerating paths is the thing this hook exists to stop doing.
        matcher: () => true,
        handler: refuseIfSuspendedSession,
      },
    ],
  },
};

/**
 * Turning somebody away while their account is locked, from the log this
 * same file writes.
 *
 * Before the password — or the second-factor code — is checked, so a locked
 * account can never be used as an oracle for whether a guess was right. Not
 * only `/sign-in/email`: a lock that stopped there would still let somebody
 * whose password is correct finish signing in through
 * `/two-factor/verify-totp` or `/two-factor/verify-backup-code` while the
 * account stands locked, which defeats the point for exactly the accounts an
 * instance that requires two-factor cares most about protecting. All three
 * paths are guarded here rather than only the one the original brief for
 * this task named, because `sign-in-events.test.ts` already established that
 * a run of wrong codes against a pending challenge is exactly as real an
 * attack as a run of wrong passwords, and `record()` already writes both
 * kinds of failure under the identical `detail.email` key — the lock reads
 * one count, not two, because it is one count.
 *
 * The message says the account is locked and for how long, and says the same
 * thing whether or not the typed address belongs to a real account —
 * `lockState` only ever comes back locked for an address with five recorded
 * failures against it, and an address nobody owns cannot have accumulated
 * those unless the caller made them happen themselves. An attacker learning
 * which addresses are real from a *different* response than everyone else
 * gets is the thing this guards against, not the fact of the lock message
 * existing at all.
 *
 * Every database call below sits inside one `try` whose `catch` swallows
 * unconditionally — this hook deciding "I cannot tell" must read as "let the
 * sign-in through," never as "lock everyone out of their own instance
 * because a query timed out." That includes an `APIError` raised *inside*
 * the `try` by something other than this function's own decision — the
 * lookup on the two verify endpoints calls `userAwaitingTwoFactorChallenge`,
 * which reads a signed cookie and a verification record and can itself throw
 * an `APIError` (a malformed or expired cookie, say). An earlier version of
 * this hook rethrew anything of that type, on the theory that only *this*
 * function's own `APIError` should ever appear here — which is true of every
 * `APIError` this function constructs, but not of one thrown by code this
 * function merely calls, and the result was a broken cookie refusing a
 * sign-in instead of one more thing this hook could not determine. The
 * `locked` and `suspended` booleans below are what fix that: nothing throws
 * until after the `try` has finished, and the `catch` itself never returns
 * early — it logs and falls through to the two `if`s below, so a
 * determination already made before the failure (say, `locked` set `true` by
 * a successful `lockState` call, with the *later* suspension lookup the
 * thing that broke) still reaches them and is still enforced. Only whatever
 * the failure left undetermined keeps its `false` default and fails open —
 * an earlier version of this function returned straight out of the `catch`,
 * which discarded a positive determination exactly like that one along with
 * it.
 */
export const signInLockGuard = createAuthMiddleware(async (ctx) => {
  if (
    ctx.path !== "/sign-in/email" &&
    ctx.path !== "/two-factor/verify-totp" &&
    ctx.path !== "/two-factor/verify-backup-code"
  ) {
    return;
  }

  let locked = false;
  // Same fail-open rule as `locked`, and a deliberate choice rather than an
  // oversight: if the database cannot say whether this member is suspended,
  // the sign-in proceeds. A suspended person getting in during an outage is
  // bounded by that outage; a guard that refuses everyone it cannot read
  // would make the outage an instance nobody can get into at all, with no
  // second channel to fix it from.
  let suspended = false;
  // Same fail-open rule as the two above: an instance that cannot read its own
  // policy lets the sign-in through rather than refusing everybody.
  let unverified = false;
  try {
    let email: string | undefined;
    let user: { id: string } | undefined;

    if (ctx.path === "/sign-in/email") {
      const raw = (ctx.body as { email?: unknown } | undefined)?.email;
      if (typeof raw !== "string") return;
      email = raw.trim().toLowerCase();
      if (!email) return;
      [user] = await db
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(eq(schema.user.email, email))
        .limit(1);
    } else {
      // Neither verify endpoint carries an email in its body — only a code
      // and, implicitly, the pending-challenge cookie. The same read-only
      // lookup `recordTwoFactorVerify` above uses to attribute a failed code
      // to an account is what resolves one here, so a locked account cannot
      // be reached by this door either.
      const userId = await userAwaitingTwoFactorChallenge(ctx);
      if (!userId) return;
      const [row] = await db
        .select({ id: schema.user.id, email: schema.user.email })
        .from(schema.user)
        .where(eq(schema.user.id, userId))
        .limit(1);
      if (!row) return;
      user = { id: row.id };
      email = row.email.toLowerCase();
    }

    // See `organizationFor` above: the same membership-first, oldest-org
    // fallback resolution `signInEvents` uses to attribute an event, reused
    // here so the lock is checked against the same organization the matching
    // attempt would be recorded against — and, since it resolves identically
    // whether or not `user` exists, so an address nobody owns is checked
    // exactly the same way a real one is. That equivalence is what keeps the
    // refusal below from becoming an oracle for which addresses are real.
    const org = await organizationFor(user);
    if (!org) return;

    locked = (await lockState(org.id, email)).locked;

    // Only a real member can be suspended, so this check — unlike the lock
    // above — cannot help but tell an attacker whether an address is real: a
    // stranger's address never has a `member` row to find one on. Accepted
    // rather than worked around, because the message this produces has to be
    // actionable for the person standing there, and `organizationFor` and the
    // `email`/`user` resolution above are untouched by it — this reads the
    // same `user` the lock already resolved, one more lookup keyed on it,
    // not a second way of finding the address or its organization.
    if (user) {
      const [member] = await db
        .select({ disabledAt: schema.member.disabledAt })
        .from(schema.member)
        .where(
          and(
            eq(schema.member.userId, user.id),
            eq(schema.member.organizationId, org.id),
          ),
        )
        .limit(1);
      suspended = Boolean(member?.disabledAt);

      /**
       * And whether this business requires a confirmed address.
       *
       * Read from the organization's own policy rather than Better Auth's
       * `requireEmailVerification`, which is read once at startup and so
       * cannot be a business's decision. Off unless somebody turned it on,
       * and the route that turns it on refuses without mail configured.
       */
      if (!suspended) {
        const policy = await policyFor(org.id);
        if (policy.requireEmailVerified) {
          const [account] = await db
            .select({ verified: schema.user.emailVerified })
            .from(schema.user)
            .where(eq(schema.user.id, user.id))
            .limit(1);
          unverified = account ? !account.verified : false;
        }
      }
    }
  } catch (err) {
    // Logged and fallen through, not returned: whichever of `locked` and
    // `suspended` was already positively determined before this failure must
    // still reach the `if`s below. Only the one this failure actually
    // prevented keeps its `false` default and fails open.
    console.error(
      `[auth] could not finish determining whether this account is locked or suspended, so the attempt proceeds on whatever was already decided: ${(err as Error).message}`,
    );
  }

  // Lock checked first, deliberately, not merely as it happened to be
  // written. A real account that is both locked and suspended must answer
  // exactly like a locked address nobody owns — that is the whole point of
  // the lock message above being identical for a real and a made-up address.
  // Checking `suspended` first would break that: a locked-and-suspended real
  // account would get the suspension message while a locked-but-not-a-member
  // stranger still gets the lock message, and the difference between the two
  // messages is then an oracle for which addresses are real, exactly the
  // thing `organizationFor`'s equivalence and the identical wording above
  // exist to prevent. The cost of the current order is bounded and small: a
  // suspended person is told to try again later instead of being told to ask
  // an administrator, for as long as their own past failures keep the lock
  // open.
  if (locked) {
    throw new APIError("TOO_MANY_REQUESTS", {
      message:
        "Too many failed attempts. This account is locked for a short period. Ask an administrator to unlock it, or try again later.",
    });
  }

  if (suspended) {
    throw new APIError("FORBIDDEN", {
      message: "This account has been suspended. Ask an administrator.",
    });
  }

  // Last of the three, because it is the only one the person can clear
  // themselves — and saying so is the whole message.
  if (unverified) {
    throw new APIError("FORBIDDEN", {
      message:
        "This business asks everybody to confirm their email address first. Check your inbox for the link, or ask an administrator to send it again.",
    });
  }
});
