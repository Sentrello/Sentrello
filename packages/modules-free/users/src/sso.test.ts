import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, schema } from "@sentrello/db";
import { dropOrganization } from "@sentrello/db/testing";
import { registerForTest } from "@sentrello/module-sdk";
import usersModule from "./index";
import { cleanDomain } from "./sso";

/**
 * Signing in through the account a business already has.
 *
 * The provider itself is somebody else's server, so what is checked here is
 * our half: which domain a connection claims, what a stranger can learn from
 * asking, and what happens to people when it is disconnected.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const email = `sso-${suffix}@example.test`;

const app = registerForTest(usersModule);

let orgId: string;
let headers: Headers;

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const set = signUp.headers.get("set-cookie");
  if (!set) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie: set, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `SSO ${suffix}`, slug: `sso-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });
});

afterAll(async () => {
  await db
    .delete(schema.ssoProvider)
    .where(eq(schema.ssoProvider.organizationId, orgId));
  await db
    .delete(schema.securityEvents)
    .where(eq(schema.securityEvents.organizationId, orgId));
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await dropOrganization(orgId);
  const [u] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email));
  if (u) {
    await db.delete(schema.session).where(eq(schema.session.userId, u.id));
    await db.delete(schema.account).where(eq(schema.account.userId, u.id));
    await db.delete(schema.user).where(eq(schema.user.id, u.id));
  }
});

test("a domain is taken from whatever somebody typed", () => {
  expect(cleanDomain("example.com")).toBe("example.com");
  expect(cleanDomain("  HTTPS://Example.com/path  ")).toBe("example.com");
  // The likeliest mistake, and one nobody would notice until no sign-in
  // worked: pasting an address rather than a domain.
  expect(cleanDomain("someone@example.com")).toBe("example.com");
  expect(cleanDomain("@example.com")).toBe("example.com");
  expect(cleanDomain("not a domain")).toBeNull();
  expect(cleanDomain("localhost")).toBeNull();
});

test("connecting needs everything the provider will ask for", async () => {
  const noKind = await app.request("http://localhost/api/users/sso", {
    method: "POST",
    headers,
    body: JSON.stringify({ domain: "example.com" }),
  });
  expect(noKind.status).toBe(400);

  const noSecret = await app.request("http://localhost/api/users/sso", {
    method: "POST",
    headers,
    body: JSON.stringify({
      kind: "google",
      domain: "example.com",
      clientId: "only-an-id",
    }),
  });
  expect(noSecret.status).toBe(400);
  expect((await noSecret.json()) as { error: string }).toMatchObject({
    error: "a client id and secret are both needed",
  });

  const badDomain = await app.request("http://localhost/api/users/sso", {
    method: "POST",
    headers,
    body: JSON.stringify({
      kind: "saml",
      domain: "nonsense",
      entryPoint: "https://idp.example/sso",
      certificate: "cert",
      issuer: "https://idp.example",
    }),
  });
  expect(badDomain.status).toBe(400);
});

test("two connections cannot claim the same domain", async () => {
  // Written directly: registering for real would call somebody else's server,
  // and what is being checked is our own refusal.
  await db.insert(schema.ssoProvider).values({
    id: `existing-${suffix}`,
    issuer: "https://accounts.google.com",
    providerId: `google-taken-${suffix}`,
    organizationId: orgId,
    domain: `taken-${suffix}.example`,
    oidcConfig: "{}",
  });

  const again = await app.request("http://localhost/api/users/sso", {
    method: "POST",
    headers,
    body: JSON.stringify({
      kind: "google",
      domain: `taken-${suffix}.example`,
      clientId: "id",
      clientSecret: "secret",
    }),
  });
  // Two providers claiming one email domain is a sign-in that goes to
  // whichever row was found first.
  expect(again.status).toBe(409);
});

test("the list never hands back the client secret", async () => {
  await db.insert(schema.ssoProvider).values({
    id: `secretive-${suffix}`,
    issuer: "https://accounts.google.com",
    providerId: `google-secretive-${suffix}`,
    organizationId: orgId,
    domain: `secretive-${suffix}.example`,
    oidcConfig: JSON.stringify({
      clientId: "public-id",
      clientSecret: "sh-do-not-print-me",
    }),
  });

  const res = await app.request("http://localhost/api/users/sso", { headers });
  const text = await res.text();
  expect(text).toContain(`secretive-${suffix}.example`);
  // A screen that can show it is a screen a screenshot can leak.
  expect(text).not.toContain("sh-do-not-print-me");
  expect(text).toContain('"configured":true');
});

test("the sign-in page can ask about a domain without learning anything else", async () => {
  await db.insert(schema.ssoProvider).values({
    id: `checkable-${suffix}`,
    issuer: "https://accounts.google.com",
    providerId: `google-checkable-${suffix}`,
    organizationId: orgId,
    domain: `checkable-${suffix}.example`,
    oidcConfig: "{}",
  });

  // No session at all: this is asked before anybody has signed in.
  const yes = await app.request("http://localhost/api/users/sso/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `somebody@checkable-${suffix}.example` }),
  });
  expect((await yes.json()) as { sso: boolean }).toEqual({ sso: true });

  const no = await app.request("http://localhost/api/users/sso/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "somebody@nowhere.example" }),
  });
  const body = (await no.json()) as Record<string, unknown>;
  // Yes or no, and nothing about which provider or which business.
  expect(body).toEqual({ sso: false });
});

test("disconnecting stops sign-ins and keeps the people", async () => {
  const [row] = await db
    .insert(schema.ssoProvider)
    .values({
      id: `doomed-${suffix}`,
      issuer: "https://accounts.google.com",
      providerId: `google-doomed-${suffix}`,
      organizationId: orgId,
      domain: `doomed-${suffix}.example`,
      oidcConfig: "{}",
    })
    .returning();

  const gone = await app.request(`http://localhost/api/users/sso/${row?.id}`, {
    method: "DELETE",
    headers,
  });
  expect(gone.status).toBe(200);

  const check = await app.request("http://localhost/api/users/sso/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `x@doomed-${suffix}.example` }),
  });
  expect((await check.json()) as { sso: boolean }).toEqual({ sso: false });

  // The owner is still here, still an owner. Disconnecting is "stop accepting
  // sign-ins from there", not "delete half the staff".
  const [member] = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(eq(schema.member.organizationId, orgId));
  expect(member).toBeTruthy();

  const events = await db
    .select({ action: schema.securityEvents.action })
    .from(schema.securityEvents)
    .where(eq(schema.securityEvents.organizationId, orgId));
  expect(events.map((e) => e.action)).toContain("sso.disconnected");
});

test("another business's connection is not this one's to delete", async () => {
  const [theirs] = await db
    .insert(schema.ssoProvider)
    .values({
      id: `theirs-${suffix}`,
      issuer: "https://accounts.google.com",
      providerId: `google-theirs-${suffix}`,
      organizationId: "some-other-org",
      domain: `theirs-${suffix}.example`,
      oidcConfig: "{}",
    })
    .returning();

  const res = await app.request(
    `http://localhost/api/users/sso/${theirs?.id}`,
    { method: "DELETE", headers },
  );
  expect(res.status).toBe(404);

  await db
    .delete(schema.ssoProvider)
    .where(eq(schema.ssoProvider.id, theirs?.id ?? ""));
});
