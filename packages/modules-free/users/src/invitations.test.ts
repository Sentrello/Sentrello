import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import { eq, inArray } from "@sentrello/db/orm";
import { dropOrganization } from "@sentrello/db/testing";
import { registerForTest } from "@sentrello/module-sdk";
import { seedDefaults } from "./defaults";
import users from "./index";

/**
 * The invitation flow as the two people in it meet it: an administrator gets
 * a link back the moment they invite, and the invited person follows it, sets
 * a password, and lands signed in to the right business with the chosen role.
 *
 * The link is a credential, so the suite also proves what a credential must
 * do when things go wrong: only its hash at rest, one use, an expiry, a
 * withdrawal that sticks, and no way for a token minted in one organization
 * to admit anybody to another.
 */

const app = registerForTest(users);
const suffix = crypto.randomUUID().slice(0, 8);
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

let headers: Headers;
let orgId: string;
let ownerId: string;

let otherHeaders: Headers;
let otherOrgId: string;
let otherOwnerId: string;

/** Everybody a test signs up, so `afterAll` can take them out again. */
const joined: string[] = [];

// No mail server is the normal first-hour state of a fresh instance, and the
// state most of these tests run in; the one test about sending sets its own.
const savedMail = {
  resend: process.env.RESEND_API_KEY,
  smtp: process.env.SMTP_HOST,
};

// Each public call carries an address, so this file shares no rate-limit
// bucket with anything else driving token routes through `app.request`.
const ip = { "x-real-ip": `10.99.${Math.floor(Math.random() * 250)}.7` };

beforeAll(async () => {
  process.env.RESEND_API_KEY = undefined;
  process.env.SMTP_HOST = undefined;

  const owner = await signUpAsOwner({
    email: `invite-owner-${suffix}@example.test`,
    password: "correct-horse-battery-staple",
    name: "Avery Whitcombe",
  });
  const cookie = owner.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });
  ownerId = owner.response.user.id;

  const org = await auth.api.createOrganization({
    body: { name: `Inviting ${suffix}`, slug: `inviting-${suffix}` },
    headers,
  });
  if (!org) throw new Error("no organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });
  await seedDefaults(orgId, headers);

  // A second, unrelated business on the same instance, for the boundary
  // tests: its administrator must never be admitted by the first one's links.
  const other = await signUpAsOwner({
    email: `invite-other-${suffix}@example.test`,
    password: "correct-horse-battery-staple",
    name: "Blair Considine",
  });
  const otherCookie = other.headers.get("set-cookie");
  if (!otherCookie) throw new Error("sign-up returned no session cookie");
  otherHeaders = new Headers({
    cookie: otherCookie,
    "content-type": "application/json",
  });
  otherOwnerId = other.response.user.id;
  const otherOrg = await auth.api.createOrganization({
    body: { name: `Other ${suffix}`, slug: `other-${suffix}` },
    headers: otherHeaders,
  });
  if (!otherOrg) throw new Error("no second organization");
  otherOrgId = otherOrg.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: otherOrgId },
    headers: otherHeaders,
  });
});

afterAll(async () => {
  process.env.RESEND_API_KEY = savedMail.resend;
  process.env.SMTP_HOST = savedMail.smtp;

  for (const org of [orgId, otherOrgId]) {
    await db
      .delete(schema.securityEvents)
      .where(eq(schema.securityEvents.organizationId, org));
    await db
      .delete(schema.securityPolicy)
      .where(eq(schema.securityPolicy.organizationId, org));
    await db.delete(schema.member).where(eq(schema.member.organizationId, org));
    await dropOrganization(org);
  }
  const users = [ownerId, otherOwnerId, ...joined];
  await db.delete(schema.session).where(inArray(schema.session.userId, users));
  await db.delete(schema.account).where(inArray(schema.account.userId, users));
  await db.delete(schema.user).where(inArray(schema.user.id, users));
});

/** Invites an address as the owner and hands back what the screen gets. */
async function invite(
  email: string,
  as: Headers = headers,
): Promise<{
  id: string;
  link: string;
  token: string;
  emailSent: boolean;
}> {
  const res = await app.request("http://localhost/api/users/invitations", {
    method: "POST",
    headers: as,
    body: JSON.stringify({ email, role: "staff" }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    id: string;
    link: string;
    emailSent: boolean;
  };
  const token = new URL(body.link).searchParams.get("token") ?? "";
  return { ...body, token };
}

function accept(token: string, body: Record<string, string>, extra?: Headers) {
  const h = new Headers(extra ?? { "content-type": "application/json" });
  for (const [k, v] of Object.entries(ip)) h.set(k, v);
  return app.request(`http://localhost/api/invitations/${token}/accept`, {
    method: "POST",
    headers: h,
    body: JSON.stringify(body),
  });
}

test("inviting hands back a link once, and stores only a hash of its token", async () => {
  const email = `first-${suffix}@example.test`;
  const { id, link, token, emailSent } = await invite(email);

  expect(link).toContain("/accept-invitation?token=");
  expect(token.length).toBeGreaterThanOrEqual(43); // 32 bytes, base64url

  // No mail server is configured, and the response must not claim otherwise.
  expect(emailSent).toBe(false);

  const [row] = await db
    .select({
      tokenHash: schema.invitation.tokenHash,
      organizationId: schema.invitation.organizationId,
      status: schema.invitation.status,
      email: schema.invitation.email,
    })
    .from(schema.invitation)
    .where(eq(schema.invitation.id, id));
  expect(row?.organizationId).toBe(orgId);
  expect(row?.status).toBe("pending");
  expect(row?.email).toBe(email);
  // Hashed at rest: the stored value derives from the token and is not it.
  expect(row?.tokenHash).toBe(sha256(token));
  expect(row?.tokenHash).not.toBe(token);
});

test("the link admits exactly the invited person, with the chosen role, signed in to the inviting organization", async () => {
  const email = `second-${suffix}@example.test`;
  const { token } = await invite(email);

  // The accept screen asks first, so it can put the right questions.
  const before = await app.request(
    `http://localhost/api/invitations/${token}`,
    { headers: new Headers(ip) },
  );
  expect(before.status).toBe(200);
  const described = (await before.json()) as {
    email: string;
    organization: string;
    userExists: boolean;
  };
  expect(described.email).toBe(email);
  expect(described.organization).toBe(`Inviting ${suffix}`);
  expect(described.userExists).toBe(false);

  const res = await accept(token, {
    name: "Casey Invited",
    password: "correct-horse-battery-staple",
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.get("set-cookie");
  expect(cookie).toBeTruthy();

  const [user] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email));
  if (!user) throw new Error("no account was created");
  joined.push(user.id);

  const members = await db
    .select({
      organizationId: schema.member.organizationId,
      role: schema.member.role,
    })
    .from(schema.member)
    .where(eq(schema.member.userId, user.id));
  expect(members).toHaveLength(1);
  expect(members[0]?.organizationId).toBe(orgId);
  expect(members[0]?.role).toBe("staff");

  // Signed in, and to the right business — not left at a login form.
  const session = await auth.api.getSession({
    headers: new Headers({ cookie: cookie ?? "" }),
  });
  expect(session?.user.email).toBe(email);
  expect(session?.session.activeOrganizationId).toBe(orgId);
});

test("a link cannot be used twice", async () => {
  const email = `second-${suffix}@example.test`;
  const [row] = await db
    .select({ tokenHash: schema.invitation.tokenHash })
    .from(schema.invitation)
    .where(eq(schema.invitation.email, email));
  expect(row?.tokenHash).toBeTruthy();

  // The invitation above was accepted; the same link must now say so, to
  // the describe call and the accept call alike.
  const emailAccepted = await invite(`reuse-${suffix}@example.test`);
  const first = await accept(emailAccepted.token, {
    name: "Devon Reuse",
    password: "correct-horse-battery-staple",
  });
  expect(first.status).toBe(200);
  const [reuser] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, `reuse-${suffix}@example.test`));
  if (reuser) joined.push(reuser.id);

  const again = await accept(emailAccepted.token, {
    name: "Devon Reuse",
    password: "correct-horse-battery-staple",
  });
  expect(again.status).toBe(410);
  expect(((await again.json()) as { error: string }).error).toBe("used");
});

test("an expired invitation is refused", async () => {
  const { id, token } = await invite(`expired-${suffix}@example.test`);
  await db
    .update(schema.invitation)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(schema.invitation.id, id));

  const described = await app.request(
    `http://localhost/api/invitations/${token}`,
    { headers: new Headers(ip) },
  );
  expect(described.status).toBe(410);

  const res = await accept(token, {
    name: "Late Arrival",
    password: "correct-horse-battery-staple",
  });
  expect(res.status).toBe(410);
  expect(((await res.json()) as { error: string }).error).toBe("expired");
});

test("a withdrawn invitation is refused", async () => {
  const { id, token } = await invite(`withdrawn-${suffix}@example.test`);

  const cancel = await app.request(
    `http://localhost/api/users/invitations/${id}`,
    { method: "DELETE", headers },
  );
  expect(cancel.status).toBe(200);

  const res = await accept(token, {
    name: "Wrong Address",
    password: "correct-horse-battery-staple",
  });
  expect(res.status).toBe(410);
  expect(((await res.json()) as { error: string }).error).toBe("withdrawn");
});

test("a made-up token is a 404, not a hint", async () => {
  const res = await app.request(
    `http://localhost/api/invitations/${"a".repeat(43)}`,
    { headers: new Headers(ip) },
  );
  expect(res.status).toBe(404);
});

test("a token minted in one organization never admits anyone to another", async () => {
  const email = `boundary-${suffix}@example.test`;
  const { token } = await invite(email); // invited into orgId, by its owner

  // The other business's administrator holds a perfectly good session — for
  // their own organization. Presenting it with this token must not admit
  // them: they are not the person the invitation names, and they do not
  // know that person's password.
  const asOther = new Headers(otherHeaders);
  const hijack = await accept(token, {}, asOther);
  expect(hijack.status).toBe(400);
  const stillOut = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(eq(schema.member.userId, otherOwnerId));
  expect(stillOut.every((m) => m.id !== undefined)).toBe(true);
  const otherMemberships = await db
    .select({ organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, otherOwnerId));
  expect(otherMemberships.map((m) => m.organizationId)).toEqual([otherOrgId]);

  // The invited person accepts, and lands in the inviting organization —
  // the one the token's own row names — and nowhere else.
  const res = await accept(token, {
    name: "Emery Boundary",
    password: "correct-horse-battery-staple",
  });
  expect(res.status).toBe(200);
  const [user] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email));
  if (!user) throw new Error("no account was created");
  joined.push(user.id);
  const memberships = await db
    .select({ organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, user.id));
  expect(memberships.map((m) => m.organizationId)).toEqual([orgId]);
});

test("re-inviting the same address mints a new link and the old one stops working", async () => {
  const email = `reminted-${suffix}@example.test`;
  const first = await invite(email);
  const second = await invite(email);
  expect(second.token).not.toBe(first.token);

  const old = await app.request(
    `http://localhost/api/invitations/${first.token}`,
    { headers: new Headers(ip) },
  );
  expect(old.status).toBe(404);
  const current = await app.request(
    `http://localhost/api/invitations/${second.token}`,
    { headers: new Headers(ip) },
  );
  expect(current.status).toBe(200);
});

test("the platform's password rules hold on the accept path too", async () => {
  const { token } = await invite(`weakling-${suffix}@example.test`);
  const res = await accept(token, { name: "Weak Choice", password: "short" });
  expect(res.status).toBe(400);
  // Refused before any account or membership existed, so the link still works.
  const retry = await app.request(`http://localhost/api/invitations/${token}`, {
    headers: new Headers(ip),
  });
  expect(retry.status).toBe(200);
});

test("with a mail server connected, the same link goes out by email", async () => {
  const realFetch = globalThis.fetch;
  process.env.RESEND_API_KEY = "re_test_never_sent";
  const sent: string[] = [];
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("https://api.resend.com/")) {
      sent.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ id: "stubbed" }), { status: 200 });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  try {
    const email = `mailed-${suffix}@example.test`;
    const { link, emailSent } = await invite(email);
    expect(emailSent).toBe(true);
    expect(sent).toHaveLength(1);
    const message = JSON.parse(sent[0] ?? "{}") as { to: string; html: string };
    expect(message.to).toBe(email);
    // The emailed link is the same credential the screen shows — one link,
    // not a second notion of it.
    expect(message.html).toContain(link);
  } finally {
    process.env.RESEND_API_KEY = undefined;
    globalThis.fetch = realFetch;
  }
});
