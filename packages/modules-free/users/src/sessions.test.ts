import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, schema } from "@sentrello/db";
import { dropOrganization } from "@sentrello/db/testing";
import { registerForTest } from "@sentrello/module-sdk";
import { seedDefaults } from "./defaults";
import usersModule from "./index";

/**
 * Every live session across the organization, for an administrator.
 *
 * `GET /api/users/:userId/sessions` already answers this for one person;
 * this is the aggregate an administrator actually wants when a foreman has
 * been dismissed and every device of theirs has to go, or when checking who
 * is signed in at all. The tests are about whether it really carries whose
 * session each row is, and whether it stays inside the organization.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const ownerEmail = `sessions-owner-${suffix}@example.test`;
const memberEmail = `sessions-member-${suffix}@example.test`;
const strangerEmail = `sessions-stranger-${suffix}@example.test`;

const app = registerForTest(usersModule);

let orgId: string;
let otherOrgId: string;
let headers: Headers;
let ownerId: string;
let memberId: string;
let strangerId: string;

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
    body: { name: `Sessions ${suffix}`, slug: `sessions-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

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
  // A live session of theirs, distinct from the one their sign-up left
  // behind, so the fixture is explicit about what the assertion depends on.
  await db.insert(schema.session).values({
    id: `session-member-${suffix}`,
    userId: memberId,
    token: `token-member-${suffix}`,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0",
    expiresAt: new Date(Date.now() + 3_600_000),
    updatedAt: new Date(),
  });

  // Somebody in a different organization entirely — their session must never
  // appear here, however live it is.
  const stranger = await signUpAsOwner({
    email: strangerEmail,
    password: "correct-horse-battery-staple",
    name: "A Stranger",
  });
  strangerId = stranger.response.user.id;
  const strangerCookie = stranger.headers.get("set-cookie");
  if (!strangerCookie) throw new Error("sign-up returned no session cookie");
  const strangerHeaders = new Headers({
    cookie: strangerCookie,
    "content-type": "application/json",
  });
  const otherOrg = await auth.api.createOrganization({
    body: { name: `Other ${suffix}`, slug: `sessions-other-${suffix}` },
    headers: strangerHeaders,
  });
  if (!otherOrg) throw new Error("could not create the other organization");
  otherOrgId = otherOrg.id;
});

afterAll(async () => {
  await db
    .delete(schema.session)
    .where(eq(schema.session.id, `session-member-${suffix}`));
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.member)
    .where(eq(schema.member.organizationId, otherOrgId));
  await db
    .delete(schema.userGroupMembers)
    .where(eq(schema.userGroupMembers.organizationId, orgId));
  await db
    .delete(schema.userGroups)
    .where(eq(schema.userGroups.organizationId, orgId));
  await db
    .delete(schema.securityPolicy)
    .where(eq(schema.securityPolicy.organizationId, orgId));
  await dropOrganization(orgId);
  await dropOrganization(otherOrgId);
  for (const email of [ownerEmail, memberEmail, strangerEmail]) {
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

test("the instance-wide session list carries who each session belongs to", async () => {
  const res = await app.request("http://localhost/api/users/sessions", {
    headers,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    sessions: {
      userId: string;
      name: string | null;
      email: string | null;
      device: string;
    }[];
  };
  // Positive assertion first: real sessions really do come back.
  expect(body.sessions.length).toBeGreaterThan(0);

  const mine = body.sessions.find((s) => s.userId === memberId);
  expect(mine).toBeDefined();
  expect(mine?.email).toBe(memberEmail);
  expect(mine?.device).toBe("a Windows PC, in Chrome");

  // Nobody from the other organization is in the list at all.
  expect(body.sessions.some((s) => s.userId === strangerId)).toBe(false);
});

test("a manager — settings:read, not settings:update — cannot read the instance-wide list", async () => {
  // The seeded `managers` policy carries settings:read, not settings:update
  // (`defaults.ts`) — this route is deliberately not on the read side,
  // because it aggregates every person's live sessions across the whole
  // organization, the same class of cross-person read as the people list
  // and the access route, both of which are also settings:update.
  await seedDefaults(orgId, headers);

  const manager = await signUpAsOwner({
    email: `sessions-manager-${suffix}@example.test`,
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

  try {
    const res = await app.request("http://localhost/api/users/sessions", {
      headers: managerHeaders,
    });
    expect(res.status).toBe(403);
  } finally {
    await db
      .delete(schema.member)
      .where(eq(schema.member.userId, manager.response.user.id));
    await db
      .delete(schema.session)
      .where(eq(schema.session.userId, manager.response.user.id));
    await db
      .delete(schema.account)
      .where(eq(schema.account.userId, manager.response.user.id));
    await db
      .delete(schema.user)
      .where(eq(schema.user.id, manager.response.user.id));
  }
});
