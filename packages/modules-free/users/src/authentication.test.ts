import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { and, db, desc, eq, schema } from "@sentrello/db";
import { lockState } from "@sentrello/db/lockout";
import {
  DEFAULT_IDLE_MINUTES,
  forgetSessionLength,
  idleMinutesFor,
} from "@sentrello/db/security-events";
import { dropOrganization } from "@sentrello/db/testing";
import { registerForTest } from "@sentrello/module-sdk";
import { seedDefaults } from "./defaults";
import usersModule from "./index";

/**
 * The rules for signing in, and the way back in when they lock somebody out.
 *
 * `GET`/`PUT /api/users/policy` moved here from `groups.ts` unchanged, and
 * now also carries the lockout and retention settings that used to be
 * writable only by hand in the database. `POST /api/users/:userId/unlock` is
 * new outright — until it existed, nothing in the repository could clear an
 * account lock except waiting.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const ownerEmail = `auth-owner-${suffix}@example.test`;
const memberEmail = `auth-member-${suffix}@example.test`;
const managerEmail = `auth-manager-${suffix}@example.test`;
const strangerEmail = `auth-stranger-${suffix}@example.test`;
const otherOrgSlug = `auth-other-${suffix}`;

const app = registerForTest(usersModule);

let orgId: string;
let headers: Headers;
let ownerId: string;
let memberId: string;

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email: ownerEmail,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const set = signUp.headers.get("set-cookie");
  if (!set) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie: set, "content-type": "application/json" });
  ownerId = signUp.response.user.id;

  const org = await auth.api.createOrganization({
    body: { name: `Auth ${suffix}`, slug: `auth-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  // A second person, whose lock this suite exercises. Added directly, as
  // `groups.test.ts` does for its own staff fixture — this suite is about
  // policy and lockout, not the invitation flow.
  const member = await signUpAsOwner({
    email: memberEmail,
    password: "correct-horse-battery-staple",
    name: "A Person",
  });
  memberId = member.response.user.id;
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: memberId,
    role: "staff",
    baseRole: "staff",
    createdAt: new Date(),
  });
});

afterAll(async () => {
  await db
    .delete(schema.securityEvents)
    .where(eq(schema.securityEvents.organizationId, orgId));
  await db
    .delete(schema.securityPolicy)
    .where(eq(schema.securityPolicy.organizationId, orgId));
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await dropOrganization(orgId);
  const [otherOrg] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, otherOrgSlug));
  if (otherOrg) {
    await db
      .delete(schema.securityEvents)
      .where(eq(schema.securityEvents.organizationId, otherOrg.id));
    await db
      .delete(schema.securityPolicy)
      .where(eq(schema.securityPolicy.organizationId, otherOrg.id));
    await db
      .delete(schema.member)
      .where(eq(schema.member.organizationId, otherOrg.id));
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, otherOrg.id));
  }
  for (const email of [ownerEmail, memberEmail, managerEmail, strangerEmail]) {
    const [u] = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, email));
    if (u) {
      await db.delete(schema.session).where(eq(schema.session.userId, u.id));
      await db.delete(schema.account).where(eq(schema.account.userId, u.id));
      await db.delete(schema.user).where(eq(schema.user.id, u.id));
    }
  }
});

async function putPolicy(body: unknown) {
  return app.request("http://localhost/api/users/policy", {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
}

async function latestEvent(action: string) {
  const [event] = await db
    .select()
    .from(schema.securityEvents)
    .where(
      and(
        eq(schema.securityEvents.organizationId, orgId),
        eq(schema.securityEvents.action, action),
      ),
    )
    .orderBy(desc(schema.securityEvents.at))
    .limit(1);
  return event;
}

// Moved from groups.test.ts unchanged, along with the route itself.

test("the rules say who must have a second factor, and the person is told", async () => {
  const saved = await putPolicy({
    requireTwoFactorFor: ["admin"],
    minPasswordLength: 14,
  });
  expect(saved.status).toBe(200);

  const mine = (await (
    await app.request("http://localhost/api/users/me/security", { headers })
  ).json()) as {
    twoFactorRequired: boolean;
    twoFactorEnabled: boolean;
    minPasswordLength: number;
  };

  // The owner is an admin and has no second factor yet, so they are told
  // plainly rather than being refused something later with an error about
  // permissions.
  expect(mine.twoFactorRequired).toBe(true);
  expect(mine.twoFactorEnabled).toBe(false);
  expect(mine.minPasswordLength).toBe(14);

  /*
   * And they are actually refused, which until 2026-09-28 they were not.
   *
   * The checkbox saved, the line above appeared on the profile screen, and no
   * guard anywhere read the column — so the business believed it was covered
   * and the person believed they were blocked, and neither was true. A
   * security control that is displayed and not applied is worse than one that
   * is absent.
   */
  const refused = await app.request("http://localhost/api/users", { headers });
  expect(refused.status).toBe(403);
  expect(((await refused.json()) as { error: string }).error).toContain(
    "second factor",
  );

  /*
   * Two doors stay open. Complying is one — enabling a factor is served
   * without this guard — and undoing it is the other, because an
   * administrator who names their own role by mistake must not be locked out
   * of the screen that would unname it.
   */
  const stillOpen = await app.request(
    "http://localhost/api/users/me/security",
    { headers },
  );
  expect(stillOpen.status).toBe(200);

  const undone = await putPolicy({ requireTwoFactorFor: [] });
  expect(undone.status).toBe(200);

  // And with the rule gone, everything answers again.
  expect(
    (await app.request("http://localhost/api/users", { headers })).status,
  ).toBe(200);
});

test("a password minimum is kept inside what the platform can enforce", async () => {
  const res = await putPolicy({ minPasswordLength: 2 });
  const { policy } = (await res.json()) as {
    policy: { minPasswordLength: number };
  };
  /*
   * Twelve is the floor, and it used to say eight.
   *
   * The thing that enforces passwords has always asked for twelve, so a
   * business that set eight was shown eight and had twelve — two floors
   * disagreeing, with the screen holding the wrong one. A business that sets
   * two has not made a decision anybody should honour either way.
   */
  expect(policy.minPasswordLength).toBe(12);
});

// Lockout and retention settings, writable for the first
// time.

test("a policy change records what changed, lockout and retention included", async () => {
  const res = await putPolicy({
    lockoutAfterAttempts: 3,
    lockoutMinutes: 20,
    eventRetentionDays: 40,
  });
  expect(res.status).toBe(200);
  const { policy } = (await res.json()) as {
    policy: {
      lockoutAfterAttempts: number;
      lockoutMinutes: number;
      eventRetentionDays: number;
    };
  };
  expect(policy.lockoutAfterAttempts).toBe(3);
  expect(policy.lockoutMinutes).toBe(20);
  expect(policy.eventRetentionDays).toBe(40);

  const event = await latestEvent("policy.changed");
  expect(event?.detail).toMatchObject({
    lockoutAfterAttempts: 3,
    lockoutMinutes: 20,
    eventRetentionDays: 40,
  });
});

test("retention cannot be set shorter than the lockout window", async () => {
  // A 2-day lockout window with a 1-day retention would mean the failures
  // that decide the lock are pruned before the window they matter in closes
  // — pruning silently unlocks, and pruning the clearing events silently
  // extends it. The write is refused, not clamped.
  const res = await putPolicy({ lockoutMinutes: 2880, eventRetentionDays: 1 });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error?: string; field?: string };
  // The message names both settings in the words the screen labels them with,
  // because the refusal is about the pair and either one is the fix. `field`
  // names the one the caller sent, for anything that is not a person reading.
  expect(body.error).toMatch(/Keep history for/);
  expect(body.error).toMatch(/Locked for/);
  expect(body.field).toBe("eventRetentionDays");

  // And nothing was changed by the refused write.
  const [policy] = await db
    .select({ eventRetentionDays: schema.securityPolicy.eventRetentionDays })
    .from(schema.securityPolicy)
    .where(eq(schema.securityPolicy.organizationId, orgId));
  expect(policy?.eventRetentionDays).not.toBe(1);
});

test("retention of zero means keep forever, and is not held to the lockout window", async () => {
  const res = await putPolicy({ lockoutMinutes: 2880, eventRetentionDays: 0 });
  expect(res.status).toBe(200);
  const { policy } = (await res.json()) as {
    policy: { eventRetentionDays: number };
  };
  expect(policy.eventRetentionDays).toBe(0);
});

test("a negative lockoutAfterAttempts is rejected, not silently treated as off", async () => {
  // Zero is documented as off. A negative number was never a choice to mean
  // that, and letting it collapse into 0 silently would hide the difference
  // between the two.
  const res = await putPolicy({ lockoutAfterAttempts: -1 });
  expect(res.status).toBe(400);
  const [policy] = await db
    .select({
      lockoutAfterAttempts: schema.securityPolicy.lockoutAfterAttempts,
    })
    .from(schema.securityPolicy)
    .where(eq(schema.securityPolicy.organizationId, orgId));
  expect(policy?.lockoutAfterAttempts).not.toBeLessThan(0);
});

test("lockoutMinutes must be at least one", async () => {
  const res = await putPolicy({ lockoutMinutes: 0 });
  expect(res.status).toBe(400);
});

test("a negative eventRetentionDays is rejected outright", async () => {
  const res = await putPolicy({ eventRetentionDays: -5 });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error?: string; field?: string };
  expect(body.error).toMatch(/Keep history for/);
  expect(body.field).toBe("eventRetentionDays");
});

// The unlock route itself.

test("unlocking clears the lock and is itself recorded", async () => {
  for (let i = 0; i < 5; i += 1) {
    await db.insert(schema.securityEvents).values({
      organizationId: orgId,
      action: "sign-in.failed",
      detail: { email: memberEmail },
    });
  }
  expect((await lockState(orgId, memberEmail)).locked).toBe(true);

  const res = await app.request(
    `http://localhost/api/users/${memberId}/unlock`,
    { method: "POST", headers },
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ unlocked: true });

  expect((await lockState(orgId, memberEmail)).locked).toBe(false);

  const event = await latestEvent("account.unlocked");
  expect(event?.detail).toEqual({ email: memberEmail });
  expect(event?.subjectId).toBe(memberId);
});

test("unlocking somebody who is not a member here is refused", async () => {
  const res = await app.request(
    "http://localhost/api/users/does-not-exist/unlock",
    { method: "POST", headers },
  );
  expect(res.status).toBe(404);
});

// These are static two-segment paths, and would be
// silently captured by `GET /api/users/:userId` if registered after
// `registerPeople`. Proven here by actually reaching them, not by reasoning
// about registration order alone.

test("GET and PUT /api/users/policy answer with a policy, not a person-shaped 404", async () => {
  const res = await app.request("http://localhost/api/users/policy", {
    headers,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { policy?: unknown; error?: string };
  expect(body.error).toBeUndefined();
  expect(body.policy).toBeDefined();
});

/**
 * Changing this route's gate from `settings:["update"]` to
 * `["read"]` left the entire suite green before this test existed — and the
 * seeded `managers` policy carries `read`, so a manager could clear an
 * account lock. This route removes a security control rather than reading
 * one, which makes it the last route in the module that should have been
 * left unpinned; its sibling `GET /api/users/sessions` got this test in the
 * same commit and it did not.
 */
test("a manager — settings:read, not settings:update — cannot unlock anybody", async () => {
  await seedDefaults(orgId, headers);

  const manager = await signUpAsOwner({
    email: managerEmail,
    password: "correct-horse-battery-staple",
    name: "A Manager",
  });
  const managerCookie = manager.headers.get("set-cookie");
  if (!managerCookie) throw new Error("sign-up returned no session cookie");
  const managerHeaders = new Headers({
    cookie: managerCookie,
    "content-type": "application/json",
  });
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: manager.response.user.id,
    role: "managers",
    baseRole: "managers",
    createdAt: new Date(),
  });
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers: managerHeaders,
  });

  const res = await app.request(
    `http://localhost/api/users/${memberId}/unlock`,
    { method: "POST", headers: managerHeaders },
  );
  expect(res.status).toBe(403);
});

/**
 * Dropping `eq(schema.member.organizationId, orgId)`
 * from the unlock route's member lookup also left the whole suite green: the
 * only other test of a refusal uses an id that belongs to nobody at all, so
 * a real person in a different business took the same path as a stranger.
 * An unlock that reaches across organizations clears a lock in a business
 * the caller has no membership of.
 */
test("unlocking somebody who belongs to another business is refused", async () => {
  const stranger = await signUpAsOwner({
    email: strangerEmail,
    password: "correct-horse-battery-staple",
    name: "Somebody Else",
  });
  const strangerCookie = stranger.headers.get("set-cookie");
  if (!strangerCookie) throw new Error("sign-up returned no session cookie");
  const otherOrg = await auth.api.createOrganization({
    body: { name: `Auth Other ${suffix}`, slug: otherOrgSlug },
    headers: new Headers({
      cookie: strangerCookie,
      "content-type": "application/json",
    }),
  });
  if (!otherOrg) throw new Error("could not create the other organization");

  // Locked in their own business, so a leak would have something to clear.
  for (let i = 0; i < 5; i += 1) {
    await db.insert(schema.securityEvents).values({
      organizationId: otherOrg.id,
      action: "sign-in.failed",
      detail: { email: strangerEmail },
    });
  }
  expect((await lockState(otherOrg.id, strangerEmail)).locked).toBe(true);

  const res = await app.request(
    `http://localhost/api/users/${stranger.response.user.id}/unlock`,
    { method: "POST", headers },
  );
  expect(res.status).toBe(404);

  // And they are still locked, which is the half a 404 alone would not prove.
  expect((await lockState(otherOrg.id, strangerEmail)).locked).toBe(true);
});

/**
 * All three columns are `integer` — pg `int4` — so before the
 * upper bounds existed these answered 500 from the database rather than 400
 * from the route, while every field beside them was bounded both ways.
 */
test("a setting past what an integer column holds is refused, not answered with a 500", async () => {
  for (const body of [
    { lockoutAfterAttempts: 3_000_000_000 },
    { lockoutMinutes: 3_000_000_000 },
    { eventRetentionDays: 3_000_000_000 },
    { eventRetentionDays: Number.MAX_SAFE_INTEGER },
  ]) {
    const res = await putPolicy(body);
    expect(res.status).toBe(400);
  }
});

test("a setting that is not a whole number is refused for that reason, not another", async () => {
  for (const body of [
    { lockoutAfterAttempts: "abc" },
    { lockoutAfterAttempts: 1.5 },
    { lockoutMinutes: null },
  ]) {
    const res = await putPolicy(body);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("whole number");
  }
});

/**
 * A refusal is read under an input, so it names what the input is called.
 *
 * These said "lockoutAfterAttempts must be between 0 (off) and 1000" beneath
 * a field labelled "Lock after", so the one word connecting the message to the
 * thing the reader had just typed in was the word they did not have. Naming
 * the label alone would have left an API caller guessing which of six fields
 * was meant, so both: prose for the person, `field` for the caller.
 */
test("a refused setting is named the way the screen names it, and still says which field", async () => {
  for (const [body, label, field] of [
    [{ lockoutAfterAttempts: -1 }, "Lock after", "lockoutAfterAttempts"],
    [{ lockoutMinutes: 0 }, "Locked for", "lockoutMinutes"],
    [{ eventRetentionDays: -5 }, "Keep history for", "eventRetentionDays"],
    [{ lockoutAfterAttempts: "abc" }, "Lock after", "lockoutAfterAttempts"],
  ] as const) {
    const res = await putPolicy(body);
    expect(res.status).toBe(400);
    const answer = (await res.json()) as { error?: string; field?: string };
    expect(answer.error).toContain(label);
    expect(answer.field).toBe(field);
  }
});

/**
 * The setting that could lock a business out of its own software, and the two
 * things that stop it.
 *
 * Requiring a confirmed address on an instance that cannot send mail means
 * nobody can ever confirm one — including the person who would have to undo
 * it. The route refuses to switch it on, and the owner's own address is
 * already confirmed by the time they could try, because reading the setup
 * token off the server proves it better than a link in an inbox.
 */
test("requiring a confirmed address is refused while no mail is configured", async () => {
  const before = process.env.SMTP_HOST;
  const beforeFrom = process.env.EMAIL_FROM;
  const beforeKey = process.env.RESEND_API_KEY;
  process.env.SMTP_HOST = undefined;
  process.env.EMAIL_FROM = undefined;
  process.env.RESEND_API_KEY = undefined;
  try {
    const res = await putPolicy({ requireEmailVerified: true });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; field?: string };
    expect(body.error).toContain("email is configured");
    expect(body.field).toBe("requireEmailVerified");
  } finally {
    process.env.SMTP_HOST = before;
    process.env.EMAIL_FROM = beforeFrom;
    process.env.RESEND_API_KEY = beforeKey;
  }

  // And it really did not take effect.
  const [policy] = await db
    .select({ v: schema.securityPolicy.requireEmailVerified })
    .from(schema.securityPolicy)
    .where(eq(schema.securityPolicy.organizationId, orgId));
  expect(policy?.v).toBe(false);
});

test("switching it off is allowed with no mail, because that is the way back", async () => {
  // Whatever put a business in this state, the route out of it must not
  // itself require the thing that is broken.
  const res = await putPolicy({ requireEmailVerified: false });
  expect(res.status).toBe(200);
});

/**
 * Requiring a second factor of a role that does not exist is refused.
 *
 * It was filtered out and saved without it: the business asked for a
 * safeguard, was answered 200, and got no safeguard from anybody. Every other
 * field on this route refuses rather than clamps, for the same reason.
 */
test("a two-factor rule naming an undefined role is refused, not quietly dropped", async () => {
  const res = await app.request("http://localhost/api/users/policy", {
    method: "PUT",
    headers,
    body: JSON.stringify({ requireTwoFactorFor: ["admins", "bookkeepers"] }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string; field: string };
  expect(body.field).toBe("requireTwoFactorFor");
  expect(body.error).toContain("bookkeepers");

  // And nothing was saved: not the invented role, and not the real one
  // sitting beside it in the same request.
  const after = await app.request("http://localhost/api/users/policy", {
    headers,
  });
  const { policy } = (await after.json()) as {
    policy: { requireTwoFactorFor: string[] };
  };
  expect(policy.requireTwoFactorFor).not.toContain("bookkeepers");
  expect(policy.requireTwoFactorFor).not.toContain("admins");
});

/**
 * How long a session may sit idle, which every instance ignored.
 *
 * "Stay signed in for" saved, appeared on the Authentication screen and was
 * read by nothing: the library was configured with a thirty-minute rolling
 * window and that is what every business got, whatever number was on its own
 * screen. Third of three found on 2026-09-28, beside the per-role second
 * factor and the minimum password length — all three saved, displayed, and
 * applied by no code at all.
 */
test("how long a session may sit idle is the business's own number", async () => {
  // A day, which the guard turns into minutes.
  const saved = await putPolicy({ sessionDays: 1 });
  expect(saved.status).toBe(200);
  forgetSessionLength(orgId);
  expect(await idleMinutesFor(orgId)).toBe(24 * 60);

  /*
   * And bounded by what the product can honour.
   *
   * The clamp allowed a year, and the library's own session ceiling is
   * thirty days — so anything above that was a figure on the screen nothing
   * could deliver, which is the shape of the bug this setting was.
   */
  const tooLong = await putPolicy({ sessionDays: 400 });
  const { policy } = (await tooLong.json()) as {
    policy: { sessionDays: number | null };
  };
  expect(policy.sessionDays).toBe(30);

  // Cleared, and the default returns rather than the last number lingering.
  const cleared = await putPolicy({ sessionDays: null });
  expect(cleared.status).toBe(200);
  forgetSessionLength(orgId);
  expect(await idleMinutesFor(orgId)).toBe(DEFAULT_IDLE_MINUTES);
});

/**
 * And it actually signs somebody out.
 *
 * The number being stored and read is half of it; the half that matters is a
 * request being refused. Driven by ageing the session row rather than by
 * waiting, which is the only way to test a thirty-minute rule in a suite that
 * runs in a second.
 */
test("a session idle past the business's window is refused", async () => {
  const [mine] = await db
    .select({
      token: schema.session.token,
      updatedAt: schema.session.updatedAt,
    })
    .from(schema.session)
    .where(eq(schema.session.userId, ownerId))
    .orderBy(desc(schema.session.createdAt))
    .limit(1);
  if (!mine) throw new Error("the owner has no session to age");

  // The default, which is what every instance had whatever it set.
  await putPolicy({ sessionDays: null });
  forgetSessionLength(orgId);

  const anHourAgo = new Date(Date.now() - 60 * 60_000);
  await db
    .update(schema.session)
    .set({ updatedAt: anHourAgo })
    .where(eq(schema.session.token, mine.token));

  const out = await app.request("http://localhost/api/users", { headers });
  expect(out.status).toBe(401);
  expect(((await out.json()) as { error: string }).error).toContain(
    "30 minutes",
  );

  /*
   * And there is no special door back, because none is needed.
   *
   * The second-factor rule beside this one keeps two routes reachable, since
   * signing in again does not give somebody a factor they have not set up.
   * An idle timeout is not that: being signed out is not being locked out,
   * and the way back is the way in. So the policy screen is refused too while
   * the session is stale, and answers the moment somebody signs in.
   */
  const staleAttempt = await app.request("http://localhost/api/users/policy", {
    method: "PUT",
    headers,
    body: JSON.stringify({ sessionDays: 7 }),
  });
  expect(staleAttempt.status).toBe(401);

  // Signing in again, which is all an idle timeout ever asks of anybody.
  await db
    .update(schema.session)
    .set({ updatedAt: new Date() })
    .where(eq(schema.session.token, mine.token));

  const widened = await app.request("http://localhost/api/users/policy", {
    method: "PUT",
    headers,
    body: JSON.stringify({ sessionDays: 7 }),
  });
  expect(widened.status).toBe(200);
  forgetSessionLength(orgId);

  // An hour idle again, and now it is well inside the week they asked for.
  await db
    .update(schema.session)
    .set({ updatedAt: anHourAgo })
    .where(eq(schema.session.token, mine.token));

  const back = await app.request("http://localhost/api/users", { headers });
  expect(back.status).toBe(200);

  // Put the clock back, so the tests after this one have a live session.
  await db
    .update(schema.session)
    .set({ updatedAt: new Date() })
    .where(eq(schema.session.token, mine.token));
  await putPolicy({ sessionDays: null });
  forgetSessionLength(orgId);
});
