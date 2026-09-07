import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import { and, eq } from "@sentrello/db/orm";
import { dropOrganization } from "@sentrello/db/testing";
import { registerForTest } from "@sentrello/module-sdk";
import { seedDefaults } from "./defaults";
import users from "./index";

/**
 * Suspending an account, rather than deleting it.
 *
 * A person who has left should stop being able to sign in without their
 * invoices losing their author. Deleting the member takes the history with
 * it; suspending does not — the member row and every record it wrote stay
 * exactly where they are, only `disabledAt` and the person's sessions change.
 */

const app = registerForTest(users);
const suffix = crypto.randomUUID().slice(0, 8);
const email = `people-owner-${suffix}@example.test`;

let headers: Headers;
let orgId: string;
let ownerId: string;

/** Everybody `inviteAndAccept` creates, so `afterAll` can take them out too. */
const invited: string[] = [];

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email,
    password: "correct-horse-battery-staple",
    name: "Jo Whitcombe",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });
  ownerId = signUp.response.user.id;

  const org = await auth.api.createOrganization({
    body: { name: `People ${suffix}`, slug: `people-${suffix}` },
    headers,
  });
  if (!org) throw new Error("no organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  /**
   * The default policies, as a real instance gets them the first time somebody
   * opens the Users screen. Needed here so "admins" — used below to reach the
   * last-administrator guard without going through the owner's own account —
   * is an assignable role rather than one that does not exist yet.
   */
  await seedDefaults(orgId, headers);
});

afterAll(async () => {
  await db
    .delete(schema.securityEvents)
    .where(eq(schema.securityEvents.organizationId, orgId));
  await db
    .delete(schema.userGroupMembers)
    .where(eq(schema.userGroupMembers.organizationId, orgId));
  await db
    .delete(schema.userGroups)
    .where(eq(schema.userGroups.organizationId, orgId));
  await db
    .delete(schema.securityPolicy)
    .where(eq(schema.securityPolicy.organizationId, orgId));
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await dropOrganization(orgId);
  for (const id of [ownerId, ...invited]) {
    await db.delete(schema.session).where(eq(schema.session.userId, id));
    await db.delete(schema.account).where(eq(schema.account.userId, id));
    await db.delete(schema.user).where(eq(schema.user.id, id));
  }
});

/**
 * Invites an address and accepts on its behalf, the way a real person joins.
 *
 * Sign-up is closed on a claimed instance except through an invitation (see
 * `signUpAllowed` in `@sentrello/auth`), so the invitation has to exist before
 * `signUpEmail` is called — a pending invitation for this exact address is
 * one of the four ways `signUpAllowed` opens the door. Accepting is done as
 * the invited person, from the session `signUpEmail` itself returns, because
 * `/organization/accept-invitation` refuses anybody whose session email does
 * not match the invitation's.
 */
async function inviteAndAccept(
  address: string,
): Promise<{ userId: string; headers: Headers }> {
  const invitation = await auth.api.createInvitation({
    body: { email: address, role: "staff", organizationId: orgId },
    headers,
  });
  if (!invitation) throw new Error(`could not invite ${address}`);

  const signUp = await auth.api.signUpEmail({
    body: {
      email: address,
      password: "correct-horse-battery-staple",
      name: "Invited Person",
    },
    returnHeaders: true,
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  const personHeaders = new Headers({
    cookie,
    "content-type": "application/json",
  });

  await auth.api.acceptInvitation({
    body: { invitationId: invitation.id },
    headers: personHeaders,
  });

  invited.push(signUp.response.user.id);
  return { userId: signUp.response.user.id, headers: personHeaders };
}

test("a member can be suspended and restored, and cannot sign in while suspended", async () => {
  const person = await inviteAndAccept(`suspend-${suffix}@example.test`);

  const off = await app.request(`http://localhost/api/users/${person.userId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ disabled: true }),
  });
  expect(off.status).toBe(200);
  const [member] = await db
    .select({ disabledAt: schema.member.disabledAt })
    .from(schema.member)
    .where(eq(schema.member.userId, person.userId));
  expect(member?.disabledAt).not.toBeNull();

  // Suspending ends their sessions: an account that cannot sign in but stays
  // signed in has not been suspended.
  const live = await db
    .select({ id: schema.session.id })
    .from(schema.session)
    .where(eq(schema.session.userId, person.userId));
  expect(live.length).toBe(0);

  const on = await app.request(`http://localhost/api/users/${person.userId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ disabled: false }),
  });
  expect(on.status).toBe(200);
  const [restored] = await db
    .select({ disabledAt: schema.member.disabledAt })
    .from(schema.member)
    .where(eq(schema.member.userId, person.userId));
  expect(restored?.disabledAt).toBeNull();

  // Restoring only ever adds an administrator back; it has no business
  // touching a session at all. A session created after the restore, deleted
  // by a second, no-op restore call, would mean the route always clears
  // sessions rather than only while actually suspending.
  await db.insert(schema.session).values({
    id: `session-restored-${suffix}`,
    userId: person.userId,
    token: `token-restored-${suffix}`,
    expiresAt: new Date(Date.now() + 3_600_000),
    updatedAt: new Date(),
  });
  const onAgain = await app.request(
    `http://localhost/api/users/${person.userId}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({ disabled: false }),
    },
  );
  expect(onAgain.status).toBe(200);
  const stillLive = await db
    .select({ id: schema.session.id })
    .from(schema.session)
    .where(eq(schema.session.userId, person.userId));
  expect(stillLive).toHaveLength(1);

  // Both directions land in the audit log, not just one of them.
  const actions = (
    await db
      .select({ action: schema.securityEvents.action })
      .from(schema.securityEvents)
      .where(eq(schema.securityEvents.organizationId, orgId))
  ).map((e) => e.action);
  expect(actions).toContain("account.disabled");
  expect(actions).toContain("account.enabled");
});

test("disabled must be true or false, not left to guesswork", async () => {
  const person = await inviteAndAccept(`badbody-${suffix}@example.test`);
  const res = await app.request(`http://localhost/api/users/${person.userId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ disabled: "yes" }),
  });
  expect(res.status).toBe(400);
  const [member] = await db
    .select({ disabledAt: schema.member.disabledAt })
    .from(schema.member)
    .where(eq(schema.member.userId, person.userId));
  expect(member?.disabledAt).toBeNull();
});

test("you cannot suspend yourself", async () => {
  const res = await app.request(`http://localhost/api/users/${ownerId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ disabled: true }),
  });
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("yourself");
});

/**
 * `requirePermission({ settings: ["update"] })` is only ever granted to the
 * literal built-in `admin` role (see `packages/auth/src/permissions.ts`) —
 * no seeded policy other than that literal role carries it, except the
 * business's own `admins` policy (plural, seeded by `seedDefaults`, distinct
 * from the reserved `admin`). That is what makes this test possible without
 * going through the owner's own account: a caller who holds `admins` has
 * `settings:update` without being counted by `mine.role === "admin"`, so it
 * can target the sole literal administrator without ever tripping the
 * self-suspension guard. Written this way on purpose — a version of this test
 * that PATCHes the caller's own account would pass even if the
 * last-administrator guard did not exist at all, because the self-check alone
 * would already return 400.
 */
test("the last administrator cannot be suspended", async () => {
  const helper = await inviteAndAccept(`helper-${suffix}@example.test`);
  const promoted = await app.request(
    `http://localhost/api/users/${helper.userId}/role`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ role: "admins" }),
    },
  );
  expect(promoted.status).toBe(200);

  // An instance with no administrator cannot be recovered through the
  // browser — helper is not the last administrator, but a caller who holds
  // `settings:update` without being one of the counted admins may not use
  // this route to remove the one that is.
  const res = await app.request(`http://localhost/api/users/${ownerId}`, {
    method: "PATCH",
    headers: helper.headers,
    body: JSON.stringify({ disabled: true }),
  });
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("administrator");

  // The guard only ever stops the *last* administrator from being taken
  // away — it has no reason to stop one coming back. Written directly rather
  // than through the suspend route, since the route itself refuses to create
  // this state (that is exactly what the assertion above just proved).
  await db
    .update(schema.member)
    .set({ disabledAt: new Date() })
    .where(eq(schema.member.userId, ownerId));
  const restore = await app.request(`http://localhost/api/users/${ownerId}`, {
    method: "PATCH",
    headers: helper.headers,
    body: JSON.stringify({ disabled: false }),
  });
  expect(restore.status).toBe(200);
  const [row] = await db
    .select({ disabledAt: schema.member.disabledAt })
    .from(schema.member)
    .where(eq(schema.member.userId, ownerId));
  expect(row?.disabledAt).toBeNull();
});

/**
 * `isLastAdministrator` in `people.ts` splits `member.role` on the comma
 * `applyRoles` (`roles.ts`) joins it with, rather than testing for the
 * literal string `"admin"` — an administrator who is also in a group holds
 * `"admin,<group role>"`, and the old check stopped seeing them the moment
 * that happened. Written directly against the row rather than by actually
 * adding the owner to a group: the guard's bug is in the string shape it
 * reads, not in how that shape arrives, and `roles.test.ts`/`groups.test.ts`
 * already cover `applyRoles` producing it.
 */
test("an administrator who also holds a role through a group is still the last administrator", async () => {
  await db
    .update(schema.member)
    .set({ role: "admin,staff" })
    .where(eq(schema.member.userId, ownerId));

  const helper = await inviteAndAccept(
    `grouped-admin-helper-${suffix}@example.test`,
  );
  const promoted = await app.request(
    `http://localhost/api/users/${helper.userId}/role`,
    { method: "POST", headers, body: JSON.stringify({ role: "admins" }) },
  );
  expect(promoted.status).toBe(200);

  const res = await app.request(`http://localhost/api/users/${ownerId}`, {
    method: "PATCH",
    headers: helper.headers,
    body: JSON.stringify({ disabled: true }),
  });
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("administrator");

  const [row] = await db
    .select({ disabledAt: schema.member.disabledAt })
    .from(schema.member)
    .where(eq(schema.member.userId, ownerId));
  expect(row?.disabledAt).toBeNull();

  // Restored so later tests see the plain role they expect.
  await db
    .update(schema.member)
    .set({ role: "admin" })
    .where(eq(schema.member.userId, ownerId));
});

/**
 * The other half of the same fix: a suspended administrator cannot sign in,
 * approve anything, or promote anybody back, so counting them toward the
 * total is what let two separate calls suspend both administrators of an
 * organization in turn — neither call ever saw fewer than two. A second,
 * literal `"admin"` is promoted here (not the `admins` policy) because the
 * point is specifically about the `member.role === "admin"` count, not about
 * `settings:update`.
 */
test("a suspended administrator does not count toward the total", async () => {
  const second = await inviteAndAccept(`second-admin-${suffix}@example.test`);
  await db
    .update(schema.member)
    .set({ role: "admin", baseRole: "admin" })
    .where(eq(schema.member.userId, second.userId));
  // Suspended by writing the row directly: going through the route here is
  // exactly the shape that used to be possible because of this bug — two
  // administrators, each suspendable in turn, since the old check never saw
  // fewer than two live-looking rows.
  await db
    .update(schema.member)
    .set({ disabledAt: new Date() })
    .where(eq(schema.member.userId, second.userId));

  const helper = await inviteAndAccept(
    `helper-for-suspended-admin-${suffix}@example.test`,
  );
  await app.request(`http://localhost/api/users/${helper.userId}/role`, {
    method: "POST",
    headers,
    body: JSON.stringify({ role: "admins" }),
  });

  const res = await app.request(`http://localhost/api/users/${ownerId}`, {
    method: "PATCH",
    headers: helper.headers,
    body: JSON.stringify({ disabled: true }),
  });
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("administrator");

  const [row] = await db
    .select({ disabledAt: schema.member.disabledAt })
    .from(schema.member)
    .where(eq(schema.member.userId, ownerId));
  expect(row?.disabledAt).toBeNull();

  // Restored so later tests are unaffected by this account's role/state.
  await db
    .update(schema.member)
    .set({ role: "staff", baseRole: "staff", disabledAt: null })
    .where(eq(schema.member.userId, second.userId));
});

/** Pins `requirePermission({ settings: ["update"] }) — removing it currently
 * leaves the whole suite green, since nothing else exercises this route with
 * a caller who lacks the permission. */
test("an ordinary staff member cannot suspend anyone", async () => {
  const staffPerson = await inviteAndAccept(`staff-${suffix}@example.test`);
  const target = await inviteAndAccept(`staff-target-${suffix}@example.test`);

  const res = await app.request(`http://localhost/api/users/${target.userId}`, {
    method: "PATCH",
    headers: staffPerson.headers,
    body: JSON.stringify({ disabled: true }),
  });
  expect(res.status).toBe(403);
});

/**
 * Ruling 20: `defaults.ts` grants `settings:["read"]` to executives, managers
 * and accounting, so this route being gated on `settings:["read"]` handed any
 * of them the target's email, roles, groups and 2FA state while
 * `GET /api/users` beside it correctly refuses the same caller with 403.
 * `settings:["update"]`, matching every other route in this file, closes it.
 */
test("a manager — settings:read, not settings:update — cannot read a person's detail", async () => {
  const manager = await inviteAndAccept(`manager-${suffix}@example.test`);
  const promoted = await app.request(
    `http://localhost/api/users/${manager.userId}/role`,
    { method: "POST", headers, body: JSON.stringify({ role: "managers" }) },
  );
  expect(promoted.status).toBe(200);

  const res = await app.request(`http://localhost/api/users/${ownerId}`, {
    headers: manager.headers,
  });
  expect(res.status).toBe(403);
});

test("one person's detail carries what the screen needs", async () => {
  const res = await app.request(`http://localhost/api/users/${ownerId}`, {
    headers,
  });
  expect(res.status).toBe(200);
  const { person } = (await res.json()) as {
    person: { email: string; disabledAt: string | null; joinedAt: string };
  };
  expect(person.email).toBe(email);
  expect(person.disabledAt).toBeNull();
  expect(person.joinedAt).toBeTruthy();
});

test("nothing touches somebody who is not a member of this business", async () => {
  const strangerId = `stranger-people-${suffix}`;
  await db.insert(schema.user).values({
    id: strangerId,
    name: "Stranger",
    email: `stranger-people-${suffix}@x.test`,
    emailVerified: false,
    updatedAt: new Date(),
  });

  const get = await app.request(`http://localhost/api/users/${strangerId}`, {
    headers,
  });
  expect(get.status).toBe(404);

  const patch = await app.request(`http://localhost/api/users/${strangerId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ disabled: true }),
  });
  expect(patch.status).toBe(404);

  await db.delete(schema.user).where(eq(schema.user.id, strangerId));
});

/**
 * `personDetail`'s `where` clause filters on both `organizationId` and
 * `userId` — dropping the former currently breaks nothing, because the only
 * other "stranger" test above uses a user with no member row anywhere at
 * all. This uses a member of a *different* organization instead, so a query
 * keyed on `userId` alone would find them and hand this business their
 * details.
 */
test("a member of a different organization is invisible here", async () => {
  const strangerId = `stranger-other-org-${suffix}`;
  const otherOrgId = `people-other-org-${suffix}`;
  await db.insert(schema.user).values({
    id: strangerId,
    name: "Other Org Person",
    email: `stranger-other-org-${suffix}@x.test`,
    emailVerified: false,
    updatedAt: new Date(),
  });
  await db.insert(schema.organizations).values({
    id: otherOrgId,
    name: "Other Org",
    slug: otherOrgId,
    createdAt: new Date(),
  });
  await db.insert(schema.member).values({
    id: `other-org-member-${suffix}`,
    organizationId: otherOrgId,
    userId: strangerId,
    role: "admin",
    createdAt: new Date(),
  });

  // In a `finally`: this organization and user are not this suite's own —
  // `afterAll` only knows to clean up `orgId` and `invited` — so an
  // assertion failure here must not leave them behind for the next file.
  try {
    const get = await app.request(`http://localhost/api/users/${strangerId}`, {
      headers,
    });
    expect(get.status).toBe(404);
  } finally {
    await db
      .delete(schema.member)
      .where(eq(schema.member.organizationId, otherOrgId));
    await dropOrganization(otherOrgId);
    await db.delete(schema.user).where(eq(schema.user.id, strangerId));
  }
});

test("resetting a password writes the address, so it can clear an account lock", async () => {
  // Task 8's addendum: this is the remedy an administrator actually reaches
  // for, and until now it wrote a `password.reset` event with no
  // `detail.email` — which `lockState` needs to count this as clearing the
  // window (`packages/db/src/lockout.ts`). Without it, the owner gets a
  // fresh password and is still told "too many failed attempts".
  const target = await inviteAndAccept(`reset-target-${suffix}@example.test`);
  const res = await app.request(
    `http://localhost/api/users/${target.userId}/password`,
    { method: "POST", headers },
  );
  expect(res.status).toBe(200);

  const [event] = await db
    .select()
    .from(schema.securityEvents)
    .where(
      and(
        eq(schema.securityEvents.organizationId, orgId),
        eq(schema.securityEvents.action, "password.reset"),
        eq(schema.securityEvents.subjectId, target.userId),
      ),
    );
  expect(event?.detail).toEqual({
    email: `reset-target-${suffix}@example.test`,
  });
});

test("the recent-changes history excludes sign-in noise", async () => {
  // Carried from Task 3's review: once sign-in events exist, twenty-five bot
  // attempts evict every administrative action from this card. Self-contained
  // rather than relying on administrative events other tests in this file
  // happened to record first — this test's own `password.reset` below is the
  // administrative action the positive assertion needs, and it is always the
  // most recent row by the time the history is read, so it survives the
  // 25-row window regardless of how many events came before it.
  const target = await inviteAndAccept(`noise-target-${suffix}@example.test`);
  await db.insert(schema.securityEvents).values([
    {
      organizationId: orgId,
      action: "sign-in.failed",
      detail: { email: target.userId },
    },
    {
      organizationId: orgId,
      action: "sign-in.succeeded",
      detail: { email: target.userId },
    },
    { organizationId: orgId, action: "events.pruned", detail: { removed: 1 } },
  ]);
  const reset = await app.request(
    `http://localhost/api/users/${target.userId}/password`,
    { method: "POST", headers },
  );
  expect(reset.status).toBe(200);

  const res = await app.request("http://localhost/api/users", { headers });
  const body = (await res.json()) as { history: { action: string }[] };
  const actions = body.history.map((h) => h.action);
  expect(actions).toContain("password.reset");
  expect(actions).not.toContain("sign-in.failed");
  expect(actions).not.toContain("sign-in.succeeded");
  expect(actions).not.toContain("events.pruned");
});

/**
 * Task 13's Definition of Done walk found this: the lock had been derivable
 * since Task 4 and clearable by route since Task 8, and no screen knew there
 * was anything to clear, because `personDetail` never asked. A lock nobody
 * can see is a lock nobody can lift.
 */
test("a person's record says whether they are locked, and stops saying it once unlocked", async () => {
  const person = await inviteAndAccept(`lockview-${suffix}@example.test`);

  const before = await app.request(
    `http://localhost/api/users/${person.userId}`,
    { headers },
  );
  const { person: quiet } = (await before.json()) as {
    person: { locked: boolean; failedAttempts: number };
  };
  expect(quiet.locked).toBe(false);
  expect(quiet.failedAttempts).toBe(0);

  for (let i = 0; i < 5; i += 1) {
    await db.insert(schema.securityEvents).values({
      organizationId: orgId,
      action: "sign-in.failed",
      detail: { email: `lockview-${suffix}@example.test` },
    });
  }

  const during = await app.request(
    `http://localhost/api/users/${person.userId}`,
    { headers },
  );
  const { person: locked } = (await during.json()) as {
    person: {
      locked: boolean;
      failedAttempts: number;
      lockedUntil: string | null;
    };
  };
  expect(locked.locked).toBe(true);
  expect(locked.failedAttempts).toBe(5);
  // The countdown is the sliding window's, so it has to be a real moment
  // rather than null — a card that cannot say when it lifts is a card that
  // sends somebody to ask.
  expect(locked.lockedUntil).toBeTruthy();

  const cleared = await app.request(
    `http://localhost/api/users/${person.userId}/unlock`,
    { method: "POST", headers },
  );
  expect(cleared.status).toBe(200);

  const after = await app.request(
    `http://localhost/api/users/${person.userId}`,
    { headers },
  );
  const { person: free } = (await after.json()) as {
    person: { locked: boolean; lockedUntil: string | null };
  };
  expect(free.locked).toBe(false);
  expect(free.lockedUntil).toBeNull();
});
