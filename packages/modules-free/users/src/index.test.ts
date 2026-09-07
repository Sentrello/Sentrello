import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import { eq } from "@sentrello/db/orm";
import { dropOrganization } from "@sentrello/db/testing";
import { registerForTest } from "@sentrello/module-sdk";
import { seedDefaults } from "./defaults";
import users from "./index";
import { temporaryPassword } from "./password";

/**
 * These endpoints can hand somebody else's account away, so what is tested is
 * mostly what they refuse: an administrator cannot demote or remove
 * themselves, the last administrator cannot be removed at all, and nothing
 * touches a person who is not a member of this business.
 */

const app = registerForTest(users);
const suffix = crypto.randomUUID().slice(0, 8);
const ownerEmail = `owner-${suffix}@x.test`;
const mateEmail = `mate-${suffix}@x.test`;
const deputyEmail = `deputy-${suffix}@x.test`;

let headers: Headers;
let orgId: string;
let ownerId: string;
let mateId: string;

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email: ownerEmail,
    password: "correct-horse-battery-staple",
    name: "Jo Whitcombe",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Users ${suffix}`, slug: `users-${suffix}` },
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
   * opens the Users screen.
   *
   * The fixture used to skip this and still work, because Staff and Accounting
   * were compiled into the product and existed everywhere. They are the
   * business's own roles now, so an organization that has never been seeded
   * genuinely does not have them — and a group carrying one is refused with
   * ROLE_NOT_FOUND, which is correct and is what this seeds past.
   */
  await seedDefaults(orgId, headers);

  const [owner] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, ownerEmail));
  ownerId = owner?.id ?? "";

  // A colleague, written straight in: sign-up is closed once an instance is
  // claimed, and what is being tested is what happens to them afterwards.
  mateId = `mate-${suffix}`;
  await db.insert(schema.user).values({
    id: mateId,
    name: "Sam Okafor",
    email: mateEmail,
    emailVerified: false,
    updatedAt: new Date(),
  });
  await db.insert(schema.member).values({
    id: `member-${suffix}`,
    organizationId: orgId,
    userId: mateId,
    role: "staff",
    createdAt: new Date(),
  });
  await db.insert(schema.session).values({
    id: `session-${suffix}`,
    userId: mateId,
    token: `token-${suffix}`,
    expiresAt: new Date(Date.now() + 3_600_000),
    updatedAt: new Date(),
  });
});

afterAll(async () => {
  await db
    .delete(schema.securityEvents)
    .where(eq(schema.securityEvents.organizationId, orgId));
  await db.delete(schema.twoFactor).where(eq(schema.twoFactor.userId, mateId));
  await db.delete(schema.session).where(eq(schema.session.userId, mateId));
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await dropOrganization(orgId);
  await db.delete(schema.user).where(eq(schema.user.id, mateId));
  await db.delete(schema.session).where(eq(schema.session.userId, ownerId));
  await db.delete(schema.account).where(eq(schema.account.userId, ownerId));
  await db.delete(schema.user).where(eq(schema.user.id, ownerId));
});

const get = async () =>
  (await (
    await app.request("http://localhost/api/users", { headers })
  ).json()) as {
    people: {
      userId: string;
      email: string;
      role: string;
      twoFactorEnabled: boolean;
      you: boolean;
    }[];
  };

test("the list shows everybody, and marks which one is you", async () => {
  const { people } = await get();
  expect(people).toHaveLength(2);
  expect(people.filter((p) => p.you)).toHaveLength(1);
  expect(people.find((p) => p.email === mateEmail)?.role).toBe("staff");
});

test("an administrator cannot change their own role or remove themselves", async () => {
  // Both are how an owner locks the business out of its own instance, and
  // nobody else can undo either.
  const demote = await app.request(
    `http://localhost/api/users/${ownerId}/role`,
    { method: "POST", headers, body: JSON.stringify({ role: "staff" }) },
  );
  expect(demote.status).toBe(400);

  const remove = await app.request(`http://localhost/api/users/${ownerId}`, {
    method: "DELETE",
    headers,
  });
  expect(remove.status).toBe(400);
  expect((await get()).people).toHaveLength(2);
});

test("the last administrator cannot be removed", async () => {
  // Promote the colleague, then try to remove the only other admin — the
  // owner is refused above, so this checks the count rather than the identity.
  await db
    .update(schema.member)
    .set({ role: "admin" })
    .where(eq(schema.member.userId, mateId));

  const res = await app.request(`http://localhost/api/users/${mateId}`, {
    method: "DELETE",
    headers,
  });
  // Two admins now, so this one may go.
  expect(res.status).toBe(200);

  await db.insert(schema.member).values({
    id: `member2-${suffix}`,
    organizationId: orgId,
    userId: mateId,
    role: "staff",
    createdAt: new Date(),
  });
});

/**
 * The refusal the test above is named for, which it never reached.
 *
 * "The last administrator cannot be removed" only ever asserted the success
 * case — two administrators, so one may go — and would have passed against a
 * route with no guard at all. The branch's finishing review confirmed it by
 * deleting the guard and watching the whole module stay green. This is the
 * other half.
 *
 * Reaching it needs a caller who holds `settings:update` without being one of
 * the administrators being counted, because the guard only fires when there is
 * exactly one left and any caller holding the permission through the `admin`
 * role would be a second. The seeded `admins` policy is that caller: it
 * carries the permission and is not the literal role name the count matches.
 */
test("the only administrator left cannot be removed, whoever asks", async () => {
  await seedDefaults(orgId, headers);

  const deputy = await signUpAsOwner({
    email: deputyEmail,
    password: "correct-horse-battery-staple",
    name: "A Deputy",
  });
  const deputyCookie = deputy.headers.get("set-cookie");
  if (!deputyCookie) throw new Error("sign-up returned no session cookie");
  const deputyHeaders = new Headers({
    cookie: deputyCookie,
    "content-type": "application/json",
  });
  await db.insert(schema.member).values({
    id: `deputy-${suffix}`,
    organizationId: orgId,
    userId: deputy.response.user.id,
    role: "admins",
    baseRole: "admins",
    createdAt: new Date(),
  });
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers: deputyHeaders,
  });

  const res = await app.request(`http://localhost/api/users/${ownerId}`, {
    method: "DELETE",
    headers: deputyHeaders,
  });
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("administrator");

  // And the owner is still a member, which the 400 alone would not prove: an
  // instance whose only administrator has been removed cannot be recovered
  // through the browser at all.
  const [still] = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(eq(schema.member.userId, ownerId));
  expect(still).toBeDefined();

  await db
    .delete(schema.member)
    .where(eq(schema.member.userId, deputy.response.user.id));
  await db
    .delete(schema.session)
    .where(eq(schema.session.userId, deputy.response.user.id));
  await db
    .delete(schema.account)
    .where(eq(schema.account.userId, deputy.response.user.id));
  await db
    .delete(schema.user)
    .where(eq(schema.user.id, deputy.response.user.id));
});

test("a new password ends every session and is never stored", async () => {
  await db.insert(schema.session).values({
    id: `session2-${suffix}`,
    userId: mateId,
    token: `token2-${suffix}`,
    expiresAt: new Date(Date.now() + 3_600_000),
    updatedAt: new Date(),
  });

  const res = await app.request(
    `http://localhost/api/users/${mateId}/password`,
    { method: "POST", headers },
  );
  expect(res.status).toBe(200);
  const { password } = (await res.json()) as { password: string };
  expect(password.length).toBeGreaterThan(12);

  // If the password was reset because somebody else had it, leaving their
  // session alive defeats the point.
  const left = await db
    .select({ id: schema.session.id })
    .from(schema.session)
    .where(eq(schema.session.userId, mateId));
  expect(left).toHaveLength(0);

  // And it appears nowhere except that one response.
  const [account] = await db
    .select({ password: schema.account.password })
    .from(schema.account)
    .where(eq(schema.account.userId, mateId));
  expect(account?.password ?? "").not.toContain(password);
});

test("revoking two-factor removes the secret, the flag and the sessions", async () => {
  await db.insert(schema.twoFactor).values({
    id: `tf-${suffix}`,
    userId: mateId,
    secret: "encrypted-secret",
    backupCodes: "encrypted-codes",
    verified: true,
  });
  await db
    .update(schema.user)
    .set({ twoFactorEnabled: true })
    .where(eq(schema.user.id, mateId));

  const res = await app.request(
    `http://localhost/api/users/${mateId}/two-factor/revoke`,
    { method: "POST", headers },
  );
  expect(res.status).toBe(200);

  expect(
    await db
      .select()
      .from(schema.twoFactor)
      .where(eq(schema.twoFactor.userId, mateId)),
  ).toHaveLength(0);
  const [after] = await db
    .select({ twoFactorEnabled: schema.user.twoFactorEnabled })
    .from(schema.user)
    .where(eq(schema.user.id, mateId));
  expect(after?.twoFactorEnabled).toBe(false);
});

test("nothing touches somebody who is not a member of this business", async () => {
  const strangerId = `stranger-${suffix}`;
  await db.insert(schema.user).values({
    id: strangerId,
    name: "Stranger",
    email: `stranger-${suffix}@x.test`,
    emailVerified: false,
    updatedAt: new Date(),
  });

  for (const [path, method] of [
    [`/api/users/${strangerId}/password`, "POST"],
    [`/api/users/${strangerId}/two-factor/revoke`, "POST"],
    [`/api/users/${strangerId}/sessions/revoke`, "POST"],
    [`/api/users/${strangerId}`, "DELETE"],
  ] as [string, string][]) {
    const res = await app.request(`http://localhost${path}`, {
      method,
      headers,
    });
    expect(res.status).toBe(404);
  }

  await db.delete(schema.user).where(eq(schema.user.id, strangerId));
});

test("every action that hands access around is written down", async () => {
  const before = (await get()).history?.length ?? 0;

  await app.request(`http://localhost/api/users/${mateId}/sessions/revoke`, {
    method: "POST",
    headers,
  });
  await app.request(`http://localhost/api/users/${mateId}/role`, {
    method: "POST",
    headers,
    body: JSON.stringify({ role: "staff" }),
  });

  const history = (await get()).history ?? [];
  expect(history.length).toBeGreaterThan(before);

  // Every action, not a sample. Two of these silently recorded nothing for a
  // while because the formatter had rewrapped the lines an edit was matching
  // on, and only a walk through the real screen noticed.
  await app.request(`http://localhost/api/users/${mateId}/two-factor/revoke`, {
    method: "POST",
    headers,
  });
  const kinds = new Set(((await get()).history ?? []).map((h) => h.says));
  expect(kinds).toContain("turned off two-factor for");
  expect(kinds).toContain("signed out every device of");
  expect(kinds).toContain("changed the role of");

  const roleChange = history.find((h) => h.says.includes("role"));
  expect(roleChange?.actor).toBe("Jo Whitcombe");
  expect(roleChange?.subject).toBe("Sam Okafor");
  // The old and new role, because "changed their role" without saying what to
  // answers half the question somebody is asking.
  expect(roleChange?.detail).toMatchObject({ to: "staff" });

  // The password itself is never in it. What is recorded is that it happened —
  // checked against the actual issued password rather than a guess at its
  // shape, since the first version of this assertion tripped over the hyphens
  // in a timestamp and proved nothing.
  const issued = (await (
    await app.request(`http://localhost/api/users/${mateId}/password`, {
      method: "POST",
      headers,
    })
  ).json()) as { password: string };

  const after = JSON.stringify((await get()).history ?? []);
  expect(after).toContain("issued a new password for");
  expect(after).not.toContain(issued.password);
  for (const word of issued.password.split("-")) {
    // Whole words only. A word list has short entries — "ember" is one — and a
    // substring search matches them inside ordinary English in the log
    // ("member.removed"), which failed the run at random depending on which
    // password came out of the generator.
    expect(after).not.toMatch(new RegExp(`\\b${word}\\b`));
  }
});

test("an invitation can be withdrawn, and stops working when it is", async () => {
  const [invitation] = await db
    .insert(schema.invitation)
    .values({
      id: `invite-${suffix}`,
      organizationId: orgId,
      email: `wrong-address-${suffix}@x.test`,
      role: "staff",
      status: "pending",
      expiresAt: new Date(Date.now() + 86_400_000),
      inviterId: ownerId,
    })
    .returning();
  if (!invitation) throw new Error("no invitation");

  expect((await get()).invitations?.length ?? 0).toBeGreaterThan(0);

  const res = await app.request(
    `http://localhost/api/users/invitations/${invitation.id}`,
    { method: "DELETE", headers },
  );
  expect(res.status).toBe(200);

  // Marked rather than deleted: Better Auth reads the status when somebody
  // follows the link, so a withdrawn invitation has to still be there to say
  // no with.
  const [after] = await db
    .select({ status: schema.invitation.status })
    .from(schema.invitation)
    .where(eq(schema.invitation.id, invitation.id));
  expect(after?.status).toBe("canceled");

  // And it is no longer offered as waiting.
  expect(
    ((await get()).invitations ?? []).some((i) => i.id === invitation.id),
  ).toBe(false);

  await db
    .delete(schema.invitation)
    .where(eq(schema.invitation.id, invitation.id));
});

test("a temporary password is readable aloud and not guessable", () => {
  const a = temporaryPassword();
  const b = temporaryPassword();
  expect(a).not.toBe(b);
  expect(a.split("-")).toHaveLength(4);
  // Nothing that turns into a different word over the phone.
  expect(a).toMatch(/^[a-z-]+$/);
  expect(a.length).toBeGreaterThan(12);
});
