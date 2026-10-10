import { afterAll, expect, test } from "bun:test";
import { db, eq, schema } from "@sentrello/db";
import { Hono } from "hono";
import { mountAuth } from "./hono";
import { signUpAsOwner } from "./testing";

/**
 * The library's own SSO screens are not ours, and are not reachable.
 *
 * Connecting an identity provider goes through `/api/users/sso`, which asks
 * for `settings: update`, refuses an API key, and allows one connection per
 * domain. The library underneath also answers `/api/auth/sso/register` over
 * HTTP, and its only requirement is a session: anybody signed in, of any role
 * or none, could connect a provider they run themselves. Without an
 * organisation it needs no admin role at all, and nothing stops it claiming a
 * domain a business has already connected — at which point that business's
 * staff typing their address into the sign-in page could be sent to a
 * stranger's login form. It could also mint accounts for addresses holding a
 * pending invitation, and accept that invitation at whatever role it named.
 *
 * Found 10 October 2026. The server still calls the library directly, which
 * never passes through the HTTP handler, so the wrapped route is unaffected.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const email = `sso-direct-${suffix}@example.test`;
const domain = `direct-${suffix}.example`;
const base = process.env.SENTRELLO_BASE_URL ?? "http://localhost:3000";

const app = new Hono();
mountAuth(app as never);

afterAll(async () => {
  await db
    .delete(schema.ssoProvider)
    .where(eq(schema.ssoProvider.domain, domain));
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

test("a signed-in person cannot connect a provider through the library's own endpoint", async () => {
  const signUp = await signUpAsOwner({
    email,
    password: "correct-horse-battery-staple",
    name: "Somebody",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");

  const res = await app.request(`${base}/api/auth/sso/register`, {
    method: "POST",
    headers: { cookie, origin: base, "content-type": "application/json" },
    body: JSON.stringify({
      providerId: `direct-${suffix}`,
      issuer: "https://idp.attacker.example",
      domain,
      samlConfig: {
        entryPoint: "https://idp.attacker.example/sso",
        cert: "MIIC",
        callbackUrl: `${base}/api/auth/sso/saml2/sp/acs/direct-${suffix}`,
        spMetadata: {},
      },
    }),
  });

  expect(res.status).toBe(404);
  const rows = await db
    .select({ id: schema.ssoProvider.id })
    .from(schema.ssoProvider)
    .where(eq(schema.ssoProvider.domain, domain));
  expect(rows).toHaveLength(0);

  for (const path of [
    "/sso/providers",
    "/sso/get-provider",
    "/sso/update-provider",
    "/sso/delete-provider",
    "/sso/request-domain-verification",
    "/sso/verify-domain",
  ]) {
    const other = await app.request(`${base}/api/auth${path}`, {
      method: "POST",
      headers: { cookie, origin: base, "content-type": "application/json" },
      body: "{}",
    });
    expect(`${path} ${other.status}`).toBe(`${path} 404`);
  }
});
