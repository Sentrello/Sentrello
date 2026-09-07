import { afterAll, beforeAll, expect, test } from "bun:test";
import { base32 } from "@better-auth/utils/base32";
import { db, eq, schema, sql } from "@sentrello/db";
import { asRequestHeaders } from "./bootstrap";
import { auth } from "./index";
import { TWO_FACTOR_COOKIE_NAME } from "./sign-in-events";
import { signUpAsOwner } from "./testing";

const suffix = crypto.randomUUID().slice(0, 8);
const email = `signin-events-${suffix}@example.test`;
const password = "correct-horse-battery-staple";
const twoFactorEmail = `signin-events-2fa-${suffix}@example.test`;
const trustDeviceEmail = `signin-events-trust-${suffix}@example.test`;
const orphanEmail = `signin-events-orphan-${suffix}@example.test`;
const totpVerifyEmail = `signin-events-totp-verify-${suffix}@example.test`;
const backupCodeEmail = `signin-events-backup-code-${suffix}@example.test`;
const authedVerifyEmail = `signin-events-authed-verify-${suffix}@example.test`;
const floodEmail = `signin-events-flood-${suffix}@example.test`;
const cookieCheckEmail = `signin-events-cookie-check-${suffix}@example.test`;
const lockedEmail = `signin-events-locked-${suffix}@example.test`;
const lockedTwoFactorEmail = `signin-events-locked-2fa-${suffix}@example.test`;
const lockedRealEmail = `signin-events-locked-real-${suffix}@example.test`;
const lockedStrangerEmail = `signin-events-locked-stranger-${suffix}@example.test`;
const suspendedEmail = `signin-events-suspended-${suffix}@example.test`;
const throwEmail = `signin-events-throw-${suffix}@example.test`;
const lockedSuspendedEmail = `signin-events-locked-suspended-${suffix}@example.test`;
const crossPathSuspendedEmail = `signin-events-cross-path-suspended-${suffix}@example.test`;
const crossPathLiveEmail = `signin-events-cross-path-live-${suffix}@example.test`;
const crossOrgEmail = `signin-events-cross-org-${suffix}@example.test`;
let orgId: string;

beforeAll(async () => {
  const signUp = await signUpAsOwner({ email, password, name: "Owner" });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  const headers = new Headers({ cookie, "content-type": "application/json" });
  const org = await auth.api.createOrganization({
    body: { name: `Events ${suffix}`, slug: `events-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
});

/**
 * Deletes everything this suite's accounts could have left behind: the
 * `twoFactor` row a real enable/verify creates, sessions, accounts, and
 * finally the user row itself. Mirrors two-factor.test.ts's own cleanup.
 */
async function forgetAccount(accountEmail: string) {
  const [user] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, accountEmail));
  if (!user) return;
  await db.delete(schema.twoFactor).where(eq(schema.twoFactor.userId, user.id));
  await db.delete(schema.session).where(eq(schema.session.userId, user.id));
  await db.delete(schema.account).where(eq(schema.account.userId, user.id));
  await db.delete(schema.user).where(eq(schema.user.id, user.id));
}

afterAll(async () => {
  await db.execute(
    sql`delete from security_events where organization_id = ${orgId}`,
  );
  // The orphan-account test's event lands on whichever organization happens
  // to be the database's oldest at that moment — the fallback this suite
  // exercises picks the oldest organization anywhere, not just this suite's
  // own — so it is found and removed by the attempted email rather than by
  // organization id.
  await db.execute(
    sql`delete from security_events where detail ->> 'email' = ${orphanEmail}`,
  );
  // Same reason as the orphan case above: `lockedStrangerEmail` never becomes
  // a real account, so its five failures land on the database's oldest
  // organization at that moment rather than on this suite's own `orgId`.
  await db.execute(
    sql`delete from security_events where detail ->> 'email' = ${lockedStrangerEmail}`,
  );
  // Deleting the organization cascades the membership rows the 2FA and
  // trust-device tests create, but not the accounts they belong to — those
  // are cleaned up separately below.
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  await forgetAccount(twoFactorEmail);
  await forgetAccount(trustDeviceEmail);
  await forgetAccount(orphanEmail);
  await forgetAccount(totpVerifyEmail);
  await forgetAccount(backupCodeEmail);
  await forgetAccount(authedVerifyEmail);
  await forgetAccount(floodEmail);
  await forgetAccount(cookieCheckEmail);
  await forgetAccount(lockedEmail);
  await forgetAccount(lockedTwoFactorEmail);
  await forgetAccount(lockedRealEmail);
  await forgetAccount(suspendedEmail);
  await forgetAccount(throwEmail);
  await forgetAccount(lockedSuspendedEmail);
  await forgetAccount(crossPathSuspendedEmail);
  await forgetAccount(crossPathLiveEmail);
  await forgetAccount(crossOrgEmail);
});

async function eventsOf(action: string) {
  return db
    .select()
    .from(schema.securityEvents)
    .where(
      sql`${schema.securityEvents.organizationId} = ${orgId}
        and ${schema.securityEvents.action} = ${action}`,
    );
}

async function eventsFor(action: string, accountEmail: string) {
  const rows = await eventsOf(action);
  return rows.filter(
    (r) => (r.detail as { email?: string })?.email === accountEmail,
  );
}

/**
 * A signed-up, membership-holding account with a proved TOTP secret and a
 * set of backup codes, mirroring the existing trust-device test's own setup
 * steps above — factored out here because Task 3c needs the same starting
 * point for four separate tests rather than one.
 *
 * The `verifyTOTP` call inside this helper is deliberately made with an
 * *authenticated* session (`authedHeaders`, from sign-up), not a pending
 * two-factor cookie — that is the only way `twoFactorEnabled` and the
 * `twoFactor` row's `verified` flag ever become true (see
 * `two-factor.test.ts`), and it is also the exact call the
 * "proving a code while already signed in" test below asserts is not
 * recorded as a sign-in: this helper's own setup is that test's evidence,
 * not a separate case.
 */
async function setUpTwoFactorAccount(accountEmail: string) {
  const signUp = await signUpAsOwner({
    email: accountEmail,
    password,
    name: "Two Factor",
  });
  const signUpCookie = signUp.headers.get("set-cookie");
  if (!signUpCookie) throw new Error("sign-up returned no session cookie");
  const authedHeaders = new Headers({ cookie: signUpCookie });

  const [user] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, accountEmail))
    .limit(1);
  if (!user) throw new Error("sign-up did not create a user");

  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: user.id,
    role: "member",
    createdAt: new Date(),
  });

  const enabled = await auth.api.enableTwoFactor({
    body: { password },
    headers: authedHeaders,
  });
  const encodedSecret = new URL(enabled.totpURI).searchParams.get("secret");
  if (!encodedSecret) throw new Error("totpURI had no secret");
  const secret = new TextDecoder().decode(base32.decode(encodedSecret));
  const codeFor = async () =>
    (await auth.api.generateTOTP({ body: { secret } })).code;

  await auth.api.verifyTOTP({
    body: { code: await codeFor() },
    headers: authedHeaders,
  });

  return { userId: user.id, codeFor, backupCodes: enabled.backupCodes };
}

/** A pending sign-in's two-factor challenge headers, ready to hand to a `/two-factor/verify-*` call. */
async function twoFactorChallenge(accountEmail: string) {
  const pending = (await auth.api.signInEmail({
    body: { email: accountEmail, password },
    returnHeaders: true,
  })) as { headers: Headers; response: { twoFactorRedirect?: boolean } };
  expect(pending.response.twoFactorRedirect).toBe(true);
  return asRequestHeaders(pending.headers);
}

test("a successful sign-in is recorded", async () => {
  await auth.api.signInEmail({ body: { email, password } });
  const rows = await eventsOf("sign-in.succeeded");
  expect(rows.length).toBeGreaterThan(0);
});

test("a failed sign-in is recorded, without the password", async () => {
  await auth.api
    .signInEmail({ body: { email, password: "not-the-password" } })
    .catch(() => null);
  const rows = await eventsOf("sign-in.failed");
  expect(rows.length).toBeGreaterThan(0);
  const serialised = JSON.stringify(rows);
  expect(serialised).not.toContain("not-the-password");
  expect(serialised).toContain(email);
});

test("an attempt against an address that does not exist is recorded with no actor", async () => {
  const stranger = `nobody-${suffix}@example.test`;
  await auth.api
    .signInEmail({ body: { email: stranger, password: "anything" } })
    .catch(() => null);
  const rows = await eventsOf("sign-in.failed");
  const forStranger = rows.filter(
    (r) => (r.detail as { email?: string })?.email === stranger,
  );
  expect(forStranger.length).toBe(1);
  expect(forStranger[0]?.actorId).toBeNull();
});

test("a wrong password against a real address is not attributed to that address's owner", async () => {
  await auth.api
    .signInEmail({ body: { email, password: "not-the-password" } })
    .catch(() => null);
  const rows = await eventsOf("sign-in.failed");
  const forEmail = rows.filter(
    (r) => (r.detail as { email?: string })?.email === email,
  );
  expect(forEmail.length).toBeGreaterThan(0);
  // The password was wrong; whoever typed it is not known to be the owner
  // of the address they typed. Recording the real account as the actor
  // here would read as "Alice failed to sign in as Alice" to whoever is
  // looking at this during an incident.
  for (const row of forEmail) expect(row.actorId).toBeNull();
});

test("a malformed email in the sign-in body does not crash the request", async () => {
  // Through the real HTTP path (`auth.handler`), not `auth.api`, because the
  // load-bearing claim is about what a raw, unauthenticated, attacker-
  // controlled request does to this hook — `auth.api.signInEmail` would
  // coerce or reject a non-string body before it ever got this far.
  const res = await auth.handler(
    new Request("http://localhost:3000/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: 12345, password: "whatever" }),
    }),
  );
  // Better Auth's own validation rejects this with 400 before this hook
  // would have anything to record; the point of the test is that it stays a
  // 400 and not a 500 from this hook crashing on a non-string email.
  expect(res.status).toBe(400);
});

test("a correct password against a 2FA-pending account is not recorded as a success", async () => {
  await signUpAsOwner({
    email: twoFactorEmail,
    password,
    name: "Two Factor",
  });
  const [twoFactorUser] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, twoFactorEmail))
    .limit(1);
  if (!twoFactorUser) throw new Error("sign-up did not create a user");

  // Membership in the org this suite already created, so what stops an
  // event landing here is the fix under test — the sign-in hook skipping a
  // 2FA-pending attempt — and not simply having nowhere to record one.
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: twoFactorUser.id,
    role: "member",
    createdAt: new Date(),
  });

  // `twoFactorEnabled` is only ever set true by a verified TOTP code in the
  // real flow (see two-factor.test.ts); flipped directly here because this
  // test is about what the sign-in hook does once that state holds, not
  // about reaching it.
  await db
    .update(schema.user)
    .set({ twoFactorEnabled: true })
    .where(eq(schema.user.id, twoFactorUser.id));

  const result = (await auth.api.signInEmail({
    body: { email: twoFactorEmail, password },
  })) as { twoFactorRedirect?: boolean };
  expect(result.twoFactorRedirect).toBe(true);

  const rows = await eventsOf("sign-in.succeeded");
  const forTwoFactor = rows.filter(
    (r) => (r.detail as { email?: string })?.email === twoFactorEmail,
  );
  expect(forTwoFactor.length).toBe(0);
});

test("a trust-device sign-in is recorded as a success; the same account without the cookie is not", async () => {
  const trustPassword = "correct-horse-battery-staple";
  const signUp = await signUpAsOwner({
    email: trustDeviceEmail,
    password: trustPassword,
    name: "Trust Device",
  });
  const signUpCookie = signUp.headers.get("set-cookie");
  if (!signUpCookie) throw new Error("sign-up returned no session cookie");
  const authedHeaders = new Headers({ cookie: signUpCookie });

  const [trustUser] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, trustDeviceEmail))
    .limit(1);
  if (!trustUser) throw new Error("sign-up did not create a user");

  // Membership in the suite's org, so a landed (or missing) event is due to
  // the fix under test, not to having nowhere to record one.
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: trustUser.id,
    role: "member",
    createdAt: new Date(),
  });

  // Real enable + a first verification while fully authenticated — the only
  // way `twoFactorEnabled` and the `twoFactor` row's `verified` flag both
  // become true (see two-factor.test.ts). The totpURI's `secret` param is
  // base32 of the raw secret, not the raw secret itself — decoded here so
  // `generateTOTP` gets what it actually expects.
  const enabled = await auth.api.enableTwoFactor({
    body: { password: trustPassword },
    headers: authedHeaders,
  });
  const encodedSecret = new URL(enabled.totpURI).searchParams.get("secret");
  if (!encodedSecret) throw new Error("totpURI had no secret");
  const secret = new TextDecoder().decode(base32.decode(encodedSecret));
  const codeFor = async () =>
    (await auth.api.generateTOTP({ body: { secret } })).code;

  await auth.api.verifyTOTP({
    body: { code: await codeFor() },
    headers: authedHeaders,
  });

  // Without any trust-device cookie, a fresh sign-in with the correct
  // password is 2FA-pending and records nothing — this is the same
  // assertion the previous test makes, repeated here on the account this
  // test is about to trust, so the "with a cookie" result below is known to
  // be caused by the cookie and not by some other difference between the
  // two accounts.
  const pending = (await auth.api.signInEmail({
    body: { email: trustDeviceEmail, password: trustPassword },
    returnHeaders: true,
  })) as { headers: Headers; response: { twoFactorRedirect?: boolean } };
  expect(pending.response.twoFactorRedirect).toBe(true);
  let succeededRows = await eventsOf("sign-in.succeeded");
  expect(
    succeededRows.filter(
      (r) => (r.detail as { email?: string })?.email === trustDeviceEmail,
    ).length,
  ).toBe(0);

  // Verifying that same pending challenge with `trustDevice: true` is the
  // only path that sets a trust_device cookie (verify-two-factor.mjs's
  // `valid()`), so the pending sign-in's own two_factor cookie is what has
  // to be presented here — not the authenticated session from sign-up.
  const challengeHeaders = asRequestHeaders(pending.headers);
  const verified = await auth.api.verifyTOTP({
    body: { code: await codeFor(), trustDevice: true },
    headers: challengeHeaders,
    returnHeaders: true,
  });
  const trustCookieHeaders = asRequestHeaders(verified.headers);

  // Presenting the trust-device cookie on a fresh sign-in: the plugin lets
  // the credential sign-in through untouched, and this hook now records it.
  const trusted = (await auth.api.signInEmail({
    body: { email: trustDeviceEmail, password: trustPassword },
    headers: trustCookieHeaders,
  })) as { twoFactorRedirect?: boolean; user?: unknown };
  expect(trusted.twoFactorRedirect).toBeUndefined();
  expect(trusted.user).toBeTruthy();

  succeededRows = await eventsOf("sign-in.succeeded");
  expect(
    succeededRows.filter(
      (r) => (r.detail as { email?: string })?.email === trustDeviceEmail,
    ).length,
  ).toBeGreaterThan(0);
});

test("a real account with no membership still has its failed attempt recorded", async () => {
  // Deliberately no membership row and no explicit organization — the shape
  // of `ensureBootstrapped`'s sign-up-then-retry-with-sign-in path
  // (`bootstrap.ts:73-80`): the account exists, no organization has been
  // created for it yet, and this instance's test database already has at
  // least one organization (this suite's own) for the fallback to land on.
  await signUpAsOwner({ email: orphanEmail, password, name: "Orphan" });

  await auth.api
    .signInEmail({ body: { email: orphanEmail, password: "not-the-password" } })
    .catch(() => null);

  // Not scoped to this suite's `orgId`: the fallback this test exercises
  // picks the database's oldest organization, which need not be this one.
  const rows = await db
    .select()
    .from(schema.securityEvents)
    .where(sql`${schema.securityEvents.action} = 'sign-in.failed'`);
  const forOrphan = rows.filter(
    (r) => (r.detail as { email?: string })?.email === orphanEmail,
  );
  expect(forOrphan.length).toBeGreaterThan(0);
});

test("a wrong TOTP code against a pending sign-in is recorded as a failure, without the code; the right one after it is recorded as a success", async () => {
  const { codeFor } = await setUpTwoFactorAccount(totpVerifyEmail);
  const challengeHeaders = await twoFactorChallenge(totpVerifyEmail);

  // Same pending challenge, first with a code that is essentially certain
  // not to be the real one. One wrong attempt is nowhere near
  // `beginAttempt`'s own five-per-challenge limit, so the challenge is still
  // open for the correct code below.
  await auth.api
    .verifyTOTP({ body: { code: "000000" }, headers: challengeHeaders })
    .catch(() => null);

  const failedRows = await eventsFor("sign-in.failed", totpVerifyEmail);
  expect(failedRows.length).toBe(1);
  expect(JSON.stringify(failedRows)).not.toContain("000000");
  // Same rule as `/sign-in/email`: a failure never names an actor, since a
  // wrong code is not known to have come from the account's own owner.
  expect(failedRows[0]?.actorId).toBeNull();

  await auth.api.verifyTOTP({
    body: { code: await codeFor() },
    headers: challengeHeaders,
  });

  const succeededRows = await eventsFor("sign-in.succeeded", totpVerifyEmail);
  expect(succeededRows.length).toBe(1);
});

test("a wrong backup code against a pending sign-in is recorded as a failure, without the code; the right one after it is recorded as a success", async () => {
  const { backupCodes } = await setUpTwoFactorAccount(backupCodeEmail);
  const challengeHeaders = await twoFactorChallenge(backupCodeEmail);

  await auth.api
    .verifyBackupCode({
      body: { code: "not-a-real-backup-code" },
      headers: challengeHeaders,
    })
    .catch(() => null);

  const failedRows = await eventsFor("sign-in.failed", backupCodeEmail);
  expect(failedRows.length).toBe(1);
  expect(JSON.stringify(failedRows)).not.toContain("not-a-real-backup-code");
  expect(failedRows[0]?.actorId).toBeNull();

  const realCode = backupCodes[0];
  if (!realCode) throw new Error("enableTwoFactor returned no backup codes");
  await auth.api.verifyBackupCode({
    body: { code: realCode },
    headers: challengeHeaders,
  });

  const succeededRows = await eventsFor("sign-in.succeeded", backupCodeEmail);
  expect(succeededRows.length).toBe(1);
  expect(JSON.stringify(succeededRows)).not.toContain(realCode);
});

test("proving a code while already signed in — enabling two-factor — is not recorded as a sign-in", async () => {
  // `setUpTwoFactorAccount` itself calls `verifyTOTP` with an authenticated
  // session, not a pending two-factor cookie, to prove the TOTP secret and
  // flip `twoFactorEnabled` on. That call is the one this test is about: it
  // must not appear here as a sign-in, successful or otherwise, because
  // nobody signed in — an already-authenticated person turned a setting on.
  await setUpTwoFactorAccount(authedVerifyEmail);

  const succeededRows = await eventsFor("sign-in.succeeded", authedVerifyEmail);
  const failedRows = await eventsFor("sign-in.failed", authedVerifyEmail);
  expect(succeededRows.length).toBe(0);
  expect(failedRows.length).toBe(0);
});

test("the pending two-factor challenge cookie is really named what TWO_FACTOR_COOKIE_NAME assumes", async () => {
  // Guards the coupling documented on `TWO_FACTOR_COOKIE_NAME` in
  // `sign-in-events.ts`: that constant is not part of Better Auth's public
  // API surface and has to be kept in step by hand on an upgrade. This pins
  // the current, pinned-version (1.6.26) behaviour so a future upgrade that
  // renames the cookie fails this test instead of silently leaving every
  // failed second-factor attempt unattributed.
  await setUpTwoFactorAccount(cookieCheckEmail);
  const challengeHeaders = await twoFactorChallenge(cookieCheckEmail);
  const ctx = await auth.$context;
  const cookie = ctx.createAuthCookie(TWO_FACTOR_COOKIE_NAME);
  expect(challengeHeaders.get("cookie")).toContain(`${cookie.name}=`);
});

test.skipIf(process.env.NODE_ENV === "production")(
  "under NODE_ENV=test, a flood of wrong codes against /two-factor/verify-totp is not capped: every attempt is recorded",
  async () => {
    await setUpTwoFactorAccount(floodEmail);
    const challengeHeaders = await twoFactorChallenge(floodEmail);
    const cookieHeader = challengeHeaders.get("cookie") ?? "";

    const attempts = 5;
    for (let i = 0; i < attempts; i++) {
      await auth.handler(
        new Request("http://localhost:3000/api/auth/two-factor/verify-totp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: cookieHeader,
          },
          body: JSON.stringify({ code: "000000" }),
        }),
      );
    }

    const failedRows = await eventsFor("sign-in.failed", floodEmail);
    // This assertion holds only under `NODE_ENV=test`, which is what `bun
    // test` sets and is why this test can run at all — Better Auth's own
    // `twoFactor()` plugin declares a 3-per-10-second rate limit on every
    // `/two-factor/*` path, enforced by the router ahead of hook dispatch,
    // but that enforcement is gated behind `ctx.rateLimit.enabled`, which
    // defaults to `isProduction` (`NODE_ENV === "production"`). `"test"` is
    // not `"production"`, so the limiter is off here and all five rapid
    // wrong codes land. In the shipped image, where
    // `Infrastructure/build/Dockerfile.core` sets `NODE_ENV=production`, the
    // limiter is on and only the first three would ever reach this hook —
    // see the matching comment on `recordTwoFactorVerify` in
    // `sign-in-events.ts`. The `skipIf` above is what keeps this test from
    // failing with a wrong, misleading count when the suite is run
    // production-flagged instead of quietly asserting a fact that isn't true
    // there.
    expect(failedRows.length).toBe(attempts);
  },
);

test("five wrong passwords lock the account, and the sixth attempt — even with the right password — is refused", async () => {
  await signUpAsOwner({ email: lockedEmail, password, name: "Locked" });
  const [lockedUser] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, lockedEmail))
    .limit(1);
  if (!lockedUser) throw new Error("sign-up did not create a user");

  // Membership in the suite's org, the same way every other account here
  // gets one, so the failures below land where this test can see them
  // instead of on whichever organization the database's oldest-first
  // fallback happens to pick.
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: lockedUser.id,
    role: "member",
    createdAt: new Date(),
  });

  for (let i = 0; i < 5; i += 1) {
    await auth.api
      .signInEmail({ body: { email: lockedEmail, password: "wrong" } })
      .catch(() => null);
  }

  // The default policy locks at five failures inside fifteen minutes (see
  // `securityPolicy.lockoutAfterAttempts` in `packages/db/src/schema.ts`),
  // and this suite creates no `security_policy` row of its own, so
  // `lockState`'s `policyFor` call falls back to exactly that default.
  const refused = await auth.api
    .signInEmail({ body: { email: lockedEmail, password } })
    .catch((err: Error) => err);
  expect(String(refused)).toContain("locked");
});

test("an account locked by five wrong two-factor codes refuses even a correct code presented on a challenge opened before the lock", async () => {
  const { codeFor } = await setUpTwoFactorAccount(lockedTwoFactorEmail);

  // A challenge opened with the correct password before any failure exists —
  // held here untouched, to prove the lock below blocks even an attempt
  // whose password step already succeeded and whose two-factor challenge
  // predates the account becoming locked. This is the case a lock scoped to
  // `/sign-in/email` alone would miss entirely.
  const earlyChallenge = await twoFactorChallenge(lockedTwoFactorEmail);

  // Five wrong codes against five separate challenges, not the same one
  // repeated: one wrong code per challenge stays well under Better Auth's
  // own five-per-challenge `beginAttempt` limit (see
  // `userAwaitingTwoFactorChallenge` in `sign-in-events.ts`), so what locks
  // the account here is `lockState`'s count of recorded failures and nothing
  // to do with that separate, unconditional mechanism.
  for (let i = 0; i < 5; i += 1) {
    const challengeHeaders = await twoFactorChallenge(lockedTwoFactorEmail);
    await auth.api
      .verifyTOTP({ body: { code: "000000" }, headers: challengeHeaders })
      .catch(() => null);
  }

  const failedRows = await eventsFor("sign-in.failed", lockedTwoFactorEmail);
  expect(failedRows.length).toBe(5);

  // The correct code, against the challenge opened before any of this —
  // refused by the lock, not by a wrong code, since `signInLockGuard` runs
  // before `/two-factor/verify-totp`'s own handler ever looks at it.
  const refusedVerify = await auth.api
    .verifyTOTP({ body: { code: await codeFor() }, headers: earlyChallenge })
    .catch((err: Error) => err);
  expect(String(refusedVerify)).toContain("locked");

  // A fresh sign-in with the correct password is refused too, before a new
  // challenge is even issued.
  const refusedSignIn = await auth.api
    .signInEmail({ body: { email: lockedTwoFactorEmail, password } })
    .catch((err: Error) => err);
  expect(String(refusedSignIn)).toContain("locked");
});

test("a locked real address and a locked address that does not exist are refused identically", async () => {
  // Pins the property `organizationFor` is what actually provides: it
  // resolves an organization the same way whether or not `user` exists, so
  // `signInLockGuard` checks — and reports on — a real account and a made-up
  // one through the identical code path. Removing the "no `if (!user)
  // return`" that makes that true is a one-line change that looks like a
  // tidy-up, keeps all 761 other tests green, and turns this refusal into an
  // oracle for which addresses are real (a locked real address answers 429,
  // an unknown one answers 401 from the credential check itself). This test
  // is what fails if that happens.
  await signUpAsOwner({ email: lockedRealEmail, password, name: "Real" });
  const [realUser] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, lockedRealEmail))
    .limit(1);
  if (!realUser) throw new Error("sign-up did not create a user");
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: realUser.id,
    role: "member",
    createdAt: new Date(),
  });

  for (let i = 0; i < 5; i += 1) {
    await auth.api
      .signInEmail({ body: { email: lockedRealEmail, password: "wrong" } })
      .catch(() => null);
  }
  for (let i = 0; i < 5; i += 1) {
    await auth.api
      .signInEmail({ body: { email: lockedStrangerEmail, password: "wrong" } })
      .catch(() => null);
  }

  const realRefusal = await auth.api
    .signInEmail({ body: { email: lockedRealEmail, password } })
    .catch((err: Error) => err);
  const strangerRefusal = await auth.api
    .signInEmail({ body: { email: lockedStrangerEmail, password: "anything" } })
    .catch((err: Error) => err);

  expect(String(realRefusal)).toContain("locked");
  expect(String(strangerRefusal)).toContain("locked");
  expect(String(realRefusal)).toBe(String(strangerRefusal));
});

test("a suspended member is refused at sign-in, even with the right password", async () => {
  await signUpAsOwner({ email: suspendedEmail, password, name: "Suspended" });
  const [suspendedUser] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, suspendedEmail))
    .limit(1);
  if (!suspendedUser) throw new Error("sign-up did not create a user");

  // Membership in the suite's org, with `disabledAt` already set — this
  // suite exercises `signInLockGuard` directly, not the Users module's own
  // suspend route, so the row is written straight rather than through
  // `PATCH /api/users/:userId`.
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: suspendedUser.id,
    role: "member",
    disabledAt: new Date(),
    createdAt: new Date(),
  });

  const refused = await auth.api
    .signInEmail({ body: { email: suspendedEmail, password } })
    .catch((err: Error) => err);
  expect(String(refused)).toContain("suspended");
});

test("a locked account whose suspension lookup throws is still refused for the lock (Ruling 18)", async () => {
  await signUpAsOwner({ email: throwEmail, password, name: "Throw" });
  const [throwUser] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, throwEmail))
    .limit(1);
  if (!throwUser) throw new Error("sign-up did not create a user");

  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: throwUser.id,
    role: "member",
    createdAt: new Date(),
  });

  for (let i = 0; i < 5; i += 1) {
    await auth.api
      .signInEmail({ body: { email: throwEmail, password: "wrong" } })
      .catch(() => null);
  }

  // The account is genuinely locked now, through the real, unpatched
  // `lockState`. What is faked below is only the *second* determination
  // `signInLockGuard` makes after that — the suspension lookup, keyed on its
  // distinctive `{ disabledAt: schema.member.disabledAt }` selection — made
  // to throw once the lock is already known. Before Ruling 18's fix, the
  // `catch` this lands in returned early and discarded the already-computed
  // `locked`, and the sign-in below would have gone through with the right
  // password.
  const originalSelect = db.select.bind(db);
  (db as unknown as { select: typeof db.select }).select = ((
    fields: unknown,
  ) => {
    const keys =
      fields && typeof fields === "object" ? Object.keys(fields) : [];
    if (
      keys.length === 1 &&
      (fields as Record<string, unknown>).disabledAt ===
        schema.member.disabledAt
    ) {
      throw new Error("simulated suspension-lookup failure");
    }
    return originalSelect(fields as never);
  }) as unknown as typeof db.select;

  try {
    const refused = await auth.api
      .signInEmail({ body: { email: throwEmail, password } })
      .catch((err: Error) => err);
    expect(String(refused)).toContain("locked");
  } finally {
    (db as unknown as { select: typeof db.select }).select = originalSelect;
  }
});

test("an account both locked and suspended is refused for the lock, not the suspension (Ruling 22)", async () => {
  await signUpAsOwner({
    email: lockedSuspendedEmail,
    password,
    name: "Locked Suspended",
  });
  const [user] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, lockedSuspendedEmail))
    .limit(1);
  if (!user) throw new Error("sign-up did not create a user");

  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: user.id,
    role: "member",
    createdAt: new Date(),
  });

  for (let i = 0; i < 5; i += 1) {
    await auth.api
      .signInEmail({ body: { email: lockedSuspendedEmail, password: "wrong" } })
      .catch(() => null);
  }

  // Suspended only after the lock is already earned. An account suspended
  // from the start never reaches the credential check at all (see the
  // "suspended member" test above) — every attempt is refused for
  // suspension before a single failure could ever be recorded, so there
  // would be nothing to lock in the first place.
  await db
    .update(schema.member)
    .set({ disabledAt: new Date() })
    .where(eq(schema.member.userId, user.id));

  const refused = await auth.api
    .signInEmail({ body: { email: lockedSuspendedEmail, password } })
    .catch((err: Error) => err);
  expect(String(refused)).toContain("locked");
  expect(String(refused)).not.toContain("suspended");
});

test("a member's suspension in a different organization does not block a sign-in resolved to this one (org filter)", async () => {
  await signUpAsOwner({ email: crossOrgEmail, password, name: "Cross Org" });
  const [user] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, crossOrgEmail))
    .limit(1);
  if (!user) throw new Error("sign-up did not create a user");

  // A second organization, where this same person is suspended — inserted
  // first, physically, so a suspension lookup with its `organizationId`
  // filter removed (a plain `where(eq(member.userId, ...))` with no
  // ordering) is likely to surface this row rather than the live one below.
  // Given a *later* `createdAt` than the live membership, though, so
  // `organizationFor`'s own oldest-membership-first resolution still picks
  // this suite's own organization — the row the correctly-filtered
  // suspension lookup is actually supposed to check.
  const otherOrgId = `signin-events-other-org-${suffix}`;
  await db.insert(schema.organizations).values({
    id: otherOrgId,
    name: "Other Org",
    slug: `signin-events-other-org-${suffix}`,
    createdAt: new Date(),
  });
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: otherOrgId,
    userId: user.id,
    role: "member",
    disabledAt: new Date(),
    createdAt: new Date(),
  });

  // The live membership in this suite's own org, backdated so it is the
  // older of the two and therefore the one `organizationFor` resolves to.
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: user.id,
    role: "member",
    createdAt: new Date(Date.now() - 60_000),
  });

  // In a `finally`: this organization is not this suite's own and nothing
  // else cleans it up, so an assertion failure here — including one forced
  // deliberately while mutation-testing the fix this test exists for — must
  // not leave it behind for the next test file to trip over.
  try {
    const result = await auth.api
      .signInEmail({ body: { email: crossOrgEmail, password } })
      .catch((err: Error) => err);
    expect(String(result)).not.toContain("suspended");
  } finally {
    await db
      .delete(schema.member)
      .where(eq(schema.member.organizationId, otherOrgId));
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, otherOrgId));
  }
});

test("a fresh session issued to a suspended member, on a path signInLockGuard does not watch, is deleted and the call refused (Ruling 21)", async () => {
  const signUp = await signUpAsOwner({
    email: crossPathSuspendedEmail,
    password,
    name: "Cross Path Suspended",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  const authedHeaders = new Headers({ cookie });

  const [user] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, crossPathSuspendedEmail))
    .limit(1);
  if (!user) throw new Error("sign-up did not create a user");

  // Membership, suspended — written directly rather than through the Users
  // module's suspend route, which would also delete this very session and
  // defeat the point. This is a session that predates the suspension, the
  // exact shape `refuseIfSuspendedSession` exists for: nobody re-checks it
  // at the door because it is not signing in through the door, it already
  // has a working key.
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: user.id,
    role: "member",
    disabledAt: new Date(),
    createdAt: new Date(),
  });

  // `/change-password` is not one of the three paths `signInLockGuard`
  // enumerates, and — called with `revokeOtherSessions: true` — it is one of
  // the paths in Better Auth that calls `setSessionCookie` to issue a fresh
  // session outside of sign-in entirely, the same mechanism an SSO callback
  // uses (see the long comment on `refuseIfSuspendedSession`). This proves
  // the after-hook catches that shape without needing an actual identity
  // provider configured to do it.
  const refused = await auth.api
    .changePassword({
      body: {
        newPassword: "another-correct-horse-battery",
        currentPassword: password,
        revokeOtherSessions: true,
      },
      headers: authedHeaders,
    })
    .catch((err: Error) => err);
  expect(String(refused)).toContain("suspended");

  // Not merely refused in the response — the session `/change-password`
  // just issued is actually gone, along with the one it revoked.
  const rows = await db
    .select({ id: schema.session.id })
    .from(schema.session)
    .where(eq(schema.session.userId, user.id));
  expect(rows.length).toBe(0);
});

test("the same call succeeds normally for a member who is not suspended (Ruling 21 control)", async () => {
  const signUp = await signUpAsOwner({
    email: crossPathLiveEmail,
    password,
    name: "Cross Path Live",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  const authedHeaders = new Headers({ cookie });

  const [user] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, crossPathLiveEmail))
    .limit(1);
  if (!user) throw new Error("sign-up did not create a user");

  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: user.id,
    role: "member",
    createdAt: new Date(),
  });

  const result = (await auth.api.changePassword({
    body: {
      newPassword: "another-correct-horse-battery",
      currentPassword: password,
      revokeOtherSessions: true,
    },
    headers: authedHeaders,
  })) as { token: string | null };
  expect(result.token).toBeTruthy();

  // A hook that deletes sessions it should not is worse than the bug it
  // fixes — this is what proves `refuseIfSuspendedSession` left a live
  // member's freshly issued session standing.
  const rows = await db
    .select({ id: schema.session.id })
    .from(schema.session)
    .where(eq(schema.session.userId, user.id));
  expect(rows.length).toBe(1);
});

/**
 * A business that requires a confirmed address refuses an unconfirmed one —
 * and the refusal says the one thing that helps, which is that the person can
 * fix it themselves.
 *
 * Checked last of the three, after the lock and the suspension, because it is
 * the only one of them the person is able to clear.
 */
test("an unconfirmed address is refused where the business requires one", async () => {
  const unconfirmed = `unconfirmed-${suffix}@example.test`;
  await signUpAsOwner({ email: unconfirmed, password, name: "Unconfirmed" });
  const [who] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, unconfirmed))
    .limit(1);
  if (!who) throw new Error("sign-up did not create a user");
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: who.id,
    role: "member",
    createdAt: new Date(),
  });
  await db
    .update(schema.user)
    .set({ emailVerified: false })
    .where(eq(schema.user.id, who.id));

  // Off: they sign in as normal.
  const allowed = await auth.api
    .signInEmail({ body: { email: unconfirmed, password } })
    .catch((e: Error) => e);
  expect(String(allowed)).not.toContain("confirm");

  await db
    .update(schema.securityPolicy)
    .set({ requireEmailVerified: true })
    .where(eq(schema.securityPolicy.organizationId, orgId));
  try {
    const refused = await auth.api
      .signInEmail({ body: { email: unconfirmed, password } })
      .catch((e: Error) => e);
    expect(String(refused)).toContain("confirm");

    // A confirmed address is unaffected, which is what makes this a rule
    // about the address rather than about the business.
    await db
      .update(schema.user)
      .set({ emailVerified: true })
      .where(eq(schema.user.id, who.id));
    const now = await auth.api
      .signInEmail({ body: { email: unconfirmed, password } })
      .catch((e: Error) => e);
    expect(String(now)).not.toContain("confirm");
  } finally {
    await db
      .update(schema.securityPolicy)
      .set({ requireEmailVerified: false })
      .where(eq(schema.securityPolicy.organizationId, orgId));
    await forgetAccount(unconfirmed);
  }
});
