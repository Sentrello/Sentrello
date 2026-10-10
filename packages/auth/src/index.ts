import { sso } from "@better-auth/sso";
import { db, schema } from "@sentrello/db";
import { asc, eq } from "@sentrello/db/orm";
import { emailAdapter, systemFrom, systemReplyTo } from "@sentrello/email";
import {
  confirmEmailChangeEmail,
  passwordResetEmail,
  verifyEmailEmail,
} from "@sentrello/email/templates";
import { callerAddress, trustedHeaderName } from "@sentrello/module-sdk";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { createAuthMiddleware } from "better-auth/api";
import { hashPassword as defaultHashPassword } from "better-auth/crypto";
import { organization, twoFactor } from "better-auth/plugins";
import type { Context } from "hono";
import { organizationGuard } from "./organization-policy";
import { passwordFloorGuard } from "./password-floor";
import { ac, roles } from "./permissions";
import { googleProvider } from "./providers";
import { signInEventsPlugin, signInLockGuard } from "./sign-in-events";
import { signUpGuard, socialSignUpGuard } from "./signup-policy";
import { weakPasswordReason } from "./weak-passwords";

/**
 * BYO Google sign-in, configured on a screen rather than in a file.
 *
 * A function rather than an object, which the library resolves once while it
 * builds itself: `null` means the provider does not exist and is filtered
 * out, so an instance nobody has configured offers no Google button instead
 * of a broken one. `providers.ts` reads the database first and the
 * environment second — the second path is what keeps Google sign-in working
 * on instances that already had it.
 */
const socialProviders = { google: googleProvider };

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
} {
  /*
   * Asked of the SDK rather than worked out again here.
   *
   * This file held its own copy of both — the `x-real-ip` default and the
   * comma-splitting — beside the copy in `caller.ts` that every other reader of
   * the caller's address now uses. Two copies of one rule, and the consequence if
   * they drift is the worst shape available: the library believing one header
   * while the product believes another, so a sign-in is rate-limited on one
   * address and the lockout counts a different one.
   *
   * No `trustedProxies`. The header the library reads is the one
   * `withDecidedAddress` below writes: one address, already checked against
   * the hops. Handing the library the list too would make it discard a caller
   * whose own address falls inside a listed range, and count them as nobody.
   */
  return { ipAddressHeaders: [trustedHeaderName(env)] };
}

/**
 * The request Better Auth is handed, with the caller's address already decided.
 *
 * The library reads its header and never asks where the connection came from:
 * its `trustedProxies` strips hops off a forwarded chain, which is a different
 * question. So it believed `x-real-ip` from anybody who sent one, while the
 * product believed it only from loopback or a listed hop — its sign-in rate
 * limit and the address beside a session were the caller's choice even after
 * the lockout stopped being. The header is rewritten here to the one answer
 * `callerAddress` gives, or removed when there is none, and the library reads
 * that.
 */
export function withDecidedAddress(c: Context): Request {
  const header = trustedHeaderName(process.env);
  const { ip } = callerAddress(c);
  const headers = new Headers(c.req.raw.headers);
  if (ip) headers.set(header, ip);
  else headers.delete(header);
  return new Request(c.req.raw, { headers });
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
  return clientAddress(c).ip ?? "anon";
}

/**
 * The caller's address in full: ip, source port where it is knowable, and
 * whether the answer came through a proxy.
 *
 * The distinction the port hangs on: a proxy forwards the caller's *address*
 * in the trusted header but not the port their connection came from — that
 * number dies at the proxy's socket. Only when this server holds the caller's
 * socket itself is the port real, so `port` is set exactly then and absent
 * otherwise. HMRC's fraud-prevention headers want that port when it exists
 * and want its absence explained when it does not, which is what `proxied`
 * is for.
 */
export function clientAddress(c: Context): {
  ip?: string;
  port?: string;
  proxied: boolean;
} {
  /*
   * One decision, in the SDK.
   *
   * This and `callerKey` in `@sentrello/module-sdk` each read the trusted header
   * themselves, and only this one honoured `SENTRELLO_TRUSTED_PROXIES` — so an
   * operator who set that variable had it applied to sign-in attempts and the
   * lockout, and ignored by every public rate limit in every module. The logic
   * moved to `caller.ts` in the SDK, which this package already depends on, and
   * the reasoning about which header and which hops lives there.
   *
   * The port is part of the same answer: a proxy forwards the caller's address
   * and not the port their connection came from, so `port` is set exactly when
   * this server holds the socket itself. HMRC's fraud-prevention headers want
   * that port when it exists and want its absence explained when it does not,
   * which is what `proxied` is for.
   */
  return callerAddress(c);
}

export const auth = betterAuth({
  baseURL: process.env.SENTRELLO_BASE_URL ?? "http://localhost:3000",
  secret: process.env.BETTER_AUTH_SECRET,
  advanced: {
    ipAddress: clientIpOptions(process.env),
    /**
     * Mail is sent after the answer, never before it.
     *
     * "Forgot password" answers the same words whether or not the address has
     * an account, and then took as long as the mail server took — a second
     * for an address that exists, a millisecond for one that does not. The
     * words said nothing and the clock said everything, to anybody wanting
     * the list of who works here. The library sends in the background when
     * given a place to; this is that place. Found 10 October 2026.
     */
    backgroundTasks: {
      handler: (task: Promise<unknown>) => {
        void task.catch((err) => console.error("[auth] mail failed", err));
      },
    },
  },
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false, // flip on once email is wired
    /**
     * Twelve characters, and no composition rules.
     *
     * NIST SP 800-63B is explicit that forcing a capital, a digit and a symbol
     * makes passwords *worse* — people produce `Password1!` and reuse it — and
     * that length plus a check against known-bad values is what actually helps.
     * So: a longer minimum, no rules about shape, and the blocklist below.
     *
     * Set here rather than only in the setup form, which is where it was: a
     * rule enforced by a screen is a rule the API does not have, and every
     * other way an account is created — an invitation, a password reset, the
     * CLI — went past it.
     */
    minPasswordLength: 12,
    /**
     * Refuse the passwords that are actually used.
     *
     * 800-63B §5.1.1.2 asks that a chosen password be compared against a list
     * of commonly-used or compromised values. Checking an online breach service
     * would be the thorough version and is the wrong trade for a self-hosted
     * product: it sends a hash of a customer's password to a third party from a
     * machine that otherwise talks to nobody, and it has to decide what to do
     * when that service is unreachable — fail open and the check is theatre,
     * fail closed and an outage stops people setting passwords.
     *
     * Hooked on hashing rather than validated in each route, because hashing is
     * the one thing every path that sets a password does: sign-up, invitation,
     * reset, and the CLI. A check in the routes we happen to remember is a
     * check the other ways round it.
     */
    password: {
      hash: async (password: string) => {
        const reason = weakPasswordReason(password);
        if (reason) {
          throw new APIError("BAD_REQUEST", { message: reason });
        }
        return defaultHashPassword(password);
      },
    },
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
    /*
     * And everybody else is signed out, as the host command already did.
     *
     * A reset is very often because somebody else has the password; leaving
     * their session open for up to thirty days answered the wrong half of
     * that. Found 10 October 2026.
     */
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      const mail = passwordResetEmail({ url, expiresInMinutes: 60 });
      await emailAdapter().send({
        from: systemFrom(),
        to: user.email,
        subject: mail.subject,
        html: mail.html,
        headers: systemReplyTo(),
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
        from: systemFrom(),
        to: user.email,
        subject: mail.subject,
        html: mail.html,
        headers: systemReplyTo(),
      });
    },
  },
  /**
   * Changing the address you sign in with.
   *
   * Two confirmations, not one. Better Auth calls `sendChangeEmailConfirmation`
   * below with the *old* address still on the session; only once that link is
   * followed does it mint a second token and hand it to
   * `sendVerificationEmail` above, which mails *that* one to the new address.
   * So the old address always hears first, and the new one sees nothing until
   * whoever holds the old inbox has said yes. `updateEmailWithoutVerification`
   * is left at its default of off: nothing in the `user` row moves for either
   * step until both links are followed, which is what keeps the old address
   * signed in throughout rather than stranding somebody mid-change.
   *
   * A request naming an address another account already holds is handled
   * inside Better Auth itself, before either send fires: it mints a token
   * nobody can use and answers exactly as it would for one that succeeded, so
   * nothing here ever has to decide what to leak.
   */
  user: {
    changeEmail: {
      enabled: true,
      sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
        const mail = confirmEmailChangeEmail({ newEmail, url });
        await emailAdapter().send({
          from: systemFrom(),
          to: user.email,
          subject: mail.subject,
          html: mail.html,
          headers: systemReplyTo(),
        });
      },
    },
  },
  socialProviders,
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
      // One business per instance, because every public page answers for "the
      // organisation here" and a second one takes all of them down in silence.
      await organizationGuard(ctx);
      // The business's own minimum, which nothing read until 2026-09-28.
      await passwordFloorGuard(ctx);
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
    /*
     * The ceiling, not the clock.
     *
     * This was thirty minutes, and because the library refreshes a session on
     * use it *was* the idle window — for every instance, whatever a business
     * had set on its own Authentication screen. "Stay signed in for" was
     * saved, displayed and read by nothing.
     *
     * One number read once at startup cannot be a business's decision, and
     * the session cookie's lifetime comes from the same number — so a longer
     * window set here would hand out a cookie that outlived nothing. The
     * business's own figure is enforced per request in `requireSession`
     * (`hono.ts`, `idleRefusal`), which can read it, can be changed without
     * a restart, and is where HIPAA's own timeout already lives.
     *
     * Thirty days because that is the longest the setting allows, so this
     * never cuts a session shorter than the business asked for. It still
     * bounds anything that does not pass through our own middleware — the
     * library's own endpoints under `/api/auth`, which is where a password
     * is changed — so an abandoned session cannot live for ever.
     */
    expiresIn: 30 * 24 * 60 * 60,
    updateAge: 60,
  },
  databaseHooks: {
    user: {
      create: {
        // Closed sign-up holds for a Google sign-in too. See `socialSignUpGuard`.
        before: async (user, context) => {
          await socialSignUpGuard(user.email, context?.path);
        },
      },
    },
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
      // Better Auth's organization IS the tenant boundary every business table
      // scopes to; point it at the `organizations` table rather than keeping two.
      schema: { organization: { modelName: "organizations" } },
    }),
  ],
});

export type Auth = typeof auth;
export { ac, roles, statement } from "./permissions";
