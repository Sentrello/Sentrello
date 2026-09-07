import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, schema } from "@sentrello/db";
import { dropOrganization } from "@sentrello/db/testing";
import { registerForTest } from "@sentrello/module-sdk";
import { seedDefaults } from "./defaults";
import usersModule from "./index";

/**
 * What the Authentication screen cannot otherwise see about this instance
 * (`docs/plan/Users-IAM-Console-Design.md` §8): the trusted header, what
 * this request resolved to, whether the base URL is `https`, whether mail is
 * configured, and how many administrators can still sign in.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const ownerEmail = `diag-owner-${suffix}@example.test`;
const secondAdminEmail = `diag-admin2-${suffix}@example.test`;
const managerEmail = `diag-manager-${suffix}@example.test`;

const app = registerForTest(usersModule);

let orgId: string;
let otherOrgId: string;
let headers: Headers;
let ownerId: string;

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
    body: { name: `Diag ${suffix}`, slug: `diag-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  // A second organization, so the administrator count answers about this
  // business only, not every administrator on the instance.
  const stranger = await signUpAsOwner({
    email: `diag-stranger-${suffix}@example.test`,
    password: "correct-horse-battery-staple",
    name: "Somebody Else",
  });
  const strangerHeaders = new Headers({
    cookie: stranger.headers.get("set-cookie") ?? "",
    "content-type": "application/json",
  });
  const otherOrg = await auth.api.createOrganization({
    body: { name: `Diag Other ${suffix}`, slug: `diag-other-${suffix}` },
    headers: strangerHeaders,
  });
  if (!otherOrg) throw new Error("could not create the other organization");
  otherOrgId = otherOrg.id;
  // A second administrator in the *other* organization only — proves the
  // count in this org's answer is not simply "every admin on the instance".
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: otherOrgId,
    userId: stranger.response.user.id,
    role: "admin",
    baseRole: "admin",
    createdAt: new Date(),
  });
});

afterAll(async () => {
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.member)
    .where(eq(schema.member.organizationId, otherOrgId));
  await db
    .delete(schema.securityPolicy)
    .where(eq(schema.securityPolicy.organizationId, orgId));
  await dropOrganization(orgId);
  await dropOrganization(otherOrgId);
  for (const email of [
    ownerEmail,
    secondAdminEmail,
    managerEmail,
    `diag-stranger-${suffix}@example.test`,
  ]) {
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

test("names the trusted header, resolves this request's address, and counts one administrator with no mail configured", async () => {
  const withRealIp = new Headers(headers);
  withRealIp.set("x-real-ip", "203.0.113.7");
  const res = await app.request("http://localhost/api/users/diagnostics", {
    headers: withRealIp,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    ipHeader: string;
    resolvedIp: string;
    baseUrl: string;
    https: boolean;
    mailConfigured: boolean;
    administrators: number;
  };

  // The default from `clientIpOptions` — a proxy-set header, not one the
  // client controls.
  expect(body.ipHeader).toBe("x-real-ip");
  expect(body.resolvedIp).toBe("203.0.113.7");
  // Nothing in this suite sets RESEND_API_KEY or SMTP_HOST.
  expect(body.mailConfigured).toBe(false);
  // Just the owner, in this organization.
  expect(body.administrators).toBe(1);
  expect(typeof body.https).toBe("boolean");
  expect(typeof body.baseUrl).toBe("string");
});

test("a request naming no trusted-header value resolves to nothing a client sent", async () => {
  const res = await app.request("http://localhost/api/users/diagnostics", {
    // No x-real-ip, and no live socket behind `app.request()` — `clientIp`
    // falls through to "anon" rather than trusting anything the client set.
    headers,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { resolvedIp: string };
  expect(body.resolvedIp).toBe("anon");
});

test("a second administrator changes the count this organization sees", async () => {
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: (
      await signUpAsOwner({
        email: secondAdminEmail,
        password: "correct-horse-battery-staple",
        name: "Second Admin",
      })
    ).response.user.id,
    role: "admin",
    baseRole: "admin",
    createdAt: new Date(),
  });

  try {
    const res = await app.request("http://localhost/api/users/diagnostics", {
      headers,
    });
    const body = (await res.json()) as { administrators: number };
    expect(body.administrators).toBe(2);
  } finally {
    await db
      .delete(schema.member)
      .where(eq(schema.member.organizationId, orgId));
    await db.insert(schema.member).values({
      id: crypto.randomUUID(),
      organizationId: orgId,
      userId: ownerId,
      role: "admin",
      baseRole: "admin",
      createdAt: new Date(),
    });
  }
});

/**
 * The same rule this branch has shipped a gate for and left unpinned three
 * times already (Ruling 34 twice, and `GET /api/users/sessions`'s own test):
 * a route this administrative gets its own test of the exact permission
 * that guards it, not just a happy path that would stay green if the gate
 * were quietly loosened.
 */
test("a manager — settings:read, not settings:update — cannot read diagnostics", async () => {
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

  try {
    const res = await app.request("http://localhost/api/users/diagnostics", {
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

test("GET /api/users/diagnostics answers with diagnostics, not a person-shaped 404", async () => {
  // The registration-order hazard every other static two-segment route in
  // this module carries a version of this test for: `GET /api/users/:userId`
  // would otherwise capture "diagnostics" as a person id first.
  const res = await app.request("http://localhost/api/users/diagnostics", {
    headers,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { error?: string; ipHeader?: string };
  expect(body.error).toBeUndefined();
  expect(body.ipHeader).toBeDefined();
});
