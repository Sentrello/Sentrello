import { sso } from "@better-auth/sso";
import { db, schema } from "@sentrello/db";
import { asc, eq } from "@sentrello/db/orm";
import { emailAdapter } from "@sentrello/email";
import {
  passwordResetEmail,
  verifyEmailEmail,
} from "@sentrello/email/templates";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware } from "better-auth/api";
import { organization, twoFactor } from "better-auth/plugins";
import type { Context } from "hono";
import { getConnInfo } from "hono/bun";
import { ac, roles } from "./permissions";
import { signInEventsPlugin, signInLockGuard } from "./sign-in-events";
import { signUpGuard } from "./signup-policy";

// BYO Google OAuth: only enabled if the instance owner configured it.
const google =
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        },
      }
    : undefined;

/**
 * Which header carries the caller's real address.
 *
 * Broken out so `clientIpOptions` and `clientIp` agree on a single default —
 * an operator who changes `SENTRELLO_CLIENT_IP_HEADER` should not have to
 * find and change a second copy of `"x-real-ip"` sitting somewhere else in
 * this file.
 */
function trustedIpHeader(env: Record<string, string | undefined>): string {
  return env.SENTRELLO_CLIENT_IP_HEADER?.trim() || "x-real-ip";
}

/**
 * Which header carries the caller's real address.
 *
 * Better Auth defaults to `x-forwarded-for`, which the caller sets. Anything
 * keyed on it — the rate limit on sign-in, the lockout in the Users module,
 * the address shown beside a session — is then keyed on a value the attacker
 * chooses.
 *
 * `x-real-ip` is set by our own nginx from `$remote_addr` and cannot be
 * forged through it, so it is the right default for every instance deployed
 * the documented way. It is configurable because on-premises somebody may sit
 * behind Caddy, Traefik, a load balancer using a different header, or nothing
 * at all — and an instance reached directly must not be reading a forwarded
 * header at all.
 */
export function clientIpOptions(env: Record<string, string | undefined>): {
  ipAddressHeaders: string[];
  trustedProxies?: string[];
} {
  const header = trustedIpHeader(env);
  const proxies = env.SENTRELLO_TRUSTED_PROXIES?.split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return {
    ipAddressHeaders: [header],
    ...(proxies && proxies.length > 0 ? { trustedProxies: proxies } : {}),
  };
}

/**
 * A rate-limit key for the caller of a hand-rolled route — one that sits
 * outside Better Auth entirely, so `clientIpOptions` above never runs for it.
 * `bootstrap.ts`'s setup-token guard and the invoicing module's customer
 * portal both need this, and used to answer it themselves.
 *
 * The order matters and is deliberate. First, the same header
 * `clientIpOptions` trusts — one answer to "which header do we believe," not
 * two, so an operator who names `SENTRELLO_CLIENT_IP_HEADER` fixes every
 * caller at once. Second, when nothing set that header — no proxy in front,
 * which is exactly the case a header can never cover — the socket address
 * from `getConnInfo`, wrapped in `try`/`catch` because it throws on anything
 * that is not a running Bun server, which includes every test that drives a
 * route through `app.request()` rather than an actual listening socket.
 * Third, `"anon"`: everyone who reaches this point shares one bucket, and for
 * a rate limiter over-limiting a crowd is the safe failure, not under-limiting
 * an attacker.
 *
 * `x-forwarded-for` never appears here. Reading it was the bug this function
 * replaces: it is the one header any caller can set for themselves, so a rate
 * limit keyed on it lets each attacker pick their own bucket and stops being
 * a rate limit. Behind the nginx this project ships that was invisible —
 * nginx always sets `x-real-ip` first, so the forgeable fallback never fired
 * — and it fired on exactly the deployment this function exists for: an
 * instance reached directly, or through a proxy that names its own header.
 */
export function clientIp(c: Context): string {
  const header = trustedIpHeader(process.env);
  const fromHeader = c.req.header(header);
  if (fromHeader) return fromHeader;

  try {
    const info = getConnInfo(c);
    if (info.remote.address) return info.remote.address;
  } catch {
    // Not a Bun server — every test driving a route through `app.request()`
    // lands here rather than on a real socket.
  }

  return "anon";
}

export const auth = betterAuth({
  baseURL: process.env.SENTRELLO_BASE_URL ?? "http://localhost:3000",
  secret: process.env.BETTER_AUTH_SECRET,
  advanced: {
    ipAddress: clientIpOptions(process.env),
  },
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false, // flip on once email is wired
    /**
     * Without this an owner who forgets their password has no way back in
     * except editing the database — and on a self-hosted instance they are
     * usually the only administrator, so there is nobody to ask.
     *
     * An hour, not a day: the link is a bearer credential sitting in an inbox.
     * Instances with no mail configured cannot use this at all, which is what
     * `sentrello reset-password` on the host is for.
     */
    resetPasswordTokenExpiresIn: 60 * 60,
    sendResetPassword: async ({ user, url }) => {
      const mail = passwordResetEmail({ url, expiresInMinutes: 60 });
      await emailAdapter().send({
        to: user.email,
        subject: mail.subject,
        html: mail.html,
      });
    },
  },
  /**
   * Confirming an address, for the businesses that ask for it.
   *
   * `requireEmailVerification` above stays false: whether an unverified
   * address may sign in is a decision each business makes on its
   * Authentication screen, and Better Auth reads this config once at
   * startup — so the refusal lives in `signInLockGuard`, beside the lock and
   * the suspension, where it can read that business's own policy.
   *
   * What is configured here is only the sending, which is the same either
   * way: a link, by mail, to whoever asked for one.
   */
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      const mail = verifyEmailEmail({ url });
      await emailAdapter().send({
        to: user.email,
        subject: mail.subject,
        html: mail.html,
      });
    },
  },
  ...(google ? { socialProviders: google } : {}),
  // Closed by default: first-run owner, invitation, or an explicit opt-in.
  // What is tried at the front door is recorded by `signInEventsPlugin` in
  // the `plugins` array below, not here — it has to run after the
  // two-factor plugin's own after-hook, and a plugin's hooks always run
  // after whatever is passed to this `hooks.after` (see sign-in-events.ts).
  //
  // `signInLockGuard` chains after `signUpGuard` here rather than needing
  // its own position in the `plugins` array the way `signInEventsPlugin`
  // does: it is a `before` hook, so there is no equivalent "after the
  // two-factor plugin's hook" ordering constraint to satisfy — every
  // `before` hook passed to `betterAuth({...})` runs ahead of every route
  // handler regardless of plugin order, so simply awaiting both in sequence
  // is enough.
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      await signUpGuard(ctx);
      // `await`, never `return`. A `before` hook that resolves to any object
      // other than `{ context }` short-circuits the request and is sent as
      // the response (`runBeforeHooks`, dispatch.mjs:91-102) — and a guard
      // built by `createAuthMiddleware` never resolves to a bare `undefined`
      // here: `runBeforeHooks` calls this hook with `returnHeaders: true`,
      // `createInternalContext` spreads that flag into the `ctx` we hand on,
      // so the inner call returns `{ headers, response: undefined }`
      // (middleware.mjs:18-22). Returning it answered every endpoint —
      // sign-up included — with that wrapper instead of running the route.
      await signInLockGuard(ctx);
    }),
  },
  /**
   * Signed in until you sign out, or thirty minutes idle.
   *
   * Better Auth extends a session when it is used, but only once per
   * `updateAge` — so those two together are what make it a rolling window
   * rather than a hard cut-off. Left at the defaults (seven days, refreshed
   * daily) a shared or walked-away-from screen stays signed in for a week,
   * which is the wrong default for software holding a business's books.
   *
   * `updateAge` of a minute rather than zero: zero writes to the session row
   * on every single request, and one write a minute gives the same thirty
   * minutes to within a rounding error.
   *
   * This also makes `session.updated_at` mean what it looks like it means —
   * the last time somebody did something. The demo's idle reset reads it, and
   * at the default of a day it was stale during active use, so the demo wiped
   * itself out from under whoever was using it.
   */
  session: {
    expiresIn: 30 * 60,
    updateAge: 60,
  },
  databaseHooks: {
    session: {
      create: {
        /**
         * Give every new session an active organization.
         *
         * Without this, signing in leaves `activeOrganizationId` null, and
         * since every business query is scoped by it the whole application
         * quietly behaves as though the business were empty: lists come back
         * with nothing in them and writes are refused as unauthorised. One
         * organization per instance is the norm, so the first membership is
         * the right answer; a user in several keeps whichever they pick.
         */
        before: async (session) => {
          const [membership] = await db
            .select({ organizationId: schema.member.organizationId })
            .from(schema.member)
            .where(eq(schema.member.userId, session.userId))
            .orderBy(asc(schema.member.createdAt))
            .limit(1);

          return membership
            ? {
                data: {
                  ...session,
                  activeOrganizationId: membership.organizationId,
                },
              }
            : undefined;
        },
      },
    },
  },
  plugins: [
    /**
     * Optional, per person, and off until proved.
     *
     * `twoFactorEnabled` is only written once a code from the authenticator
     * has actually verified, which is the property that stops somebody
     * locking themselves out of their own books by scanning a code into an
     * app they then delete.
     *
     * The issuer is what the authenticator app lists it under. A business
     * running this sees "Sentrello" beside the account it belongs to.
     */
    twoFactor({ issuer: process.env.SENTRELLO_ISSUER ?? "Sentrello" }),
    /**
     * Records what was tried at the front door — successes and failures at
     * `/sign-in/email`, and at the two second-factor completion endpoints,
     * `/two-factor/verify-totp` and `/two-factor/verify-backup-code` — for
     * the audit log. Placed immediately after `twoFactor(...)` because it
     * has to run after that plugin's own after-hook, not before it: see the
     * long comment on `ctx.context.newSession` in `sign-in-events.ts` for
     * why the order is load-bearing.
     */
    signInEventsPlugin,
    /**
     * Signing in with the account a business already has.
     *
     * A firm on Google Workspace or Microsoft 365 has decided who works there
     * and who has left; asking them to keep a second list here is asking them
     * to forget to remove somebody. OpenID Connect covers both, and SAML
     * covers the identity providers that only speak it.
     *
     * A person who arrives through it joins as a member and nothing more.
     * Roles are given here, by somebody who can see what they mean — an
     * identity provider says who somebody is, not what they may do in the
     * books.
     */
    sso({
      organizationProvisioning: { disabled: false, defaultRole: "member" },
      // Every sign-in, so somebody whose name or email changed at their
      // employer is not two people here.
      provisionUserOnEveryLogin: true,
    }),
    organization({
      ac,
      roles,
      /**
       * Roles a business can define for itself.
       *
       * The five built in cover a handyman with three staff; they do not cover
       * a business with a workshop manager who may see jobs and stock but not
       * the books. Better Auth stores these in a table and merges them with
       * the built-ins when it checks a permission, so `requirePermission`
       * needs no changes at all.
       *
       * A new role cannot grant more than its creator already holds, which is
       * the property that makes this safe to expose to an admin rather than
       * only to us.
       */
      dynamicAccessControl: { enabled: true },
      creatorRole: "admin", // instance owner
      /**
       * Five hundred, because a small business is not always five people.
       *
       * The usual instance has twenty-five or fewer, and the limit exists so a
       * runaway invite loop cannot fill the table. A hundred was a guess, and
       * it is a guess that turns into a support conversation the day a
       * customer with three sites tries to add their ninth manager.
       */
      membershipLimit: 500,
      // Better Auth's organization IS the tenant boundary from Build Plan §6.1;
      // point it at the `organizations` table rather than keeping two.
      schema: { organization: { modelName: "organizations" } },
    }),
  ],
});

export type Auth = typeof auth;
export { ac, roles, statement } from "./permissions";
