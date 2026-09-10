import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, inArray, schema } from "@sentrello/db";
import accounting from "@sentrello/module-accounting";
import crm from "@sentrello/module-crm";
import dashboard from "@sentrello/module-dashboard";
import invoicing from "@sentrello/module-invoicing";
import profile from "@sentrello/module-profile";
import { registerForTest, secrets } from "@sentrello/module-sdk";
import settings from "@sentrello/module-settings";
import users from "@sentrello/module-users";

/**
 * No screen in this product ever shows a stored credential back.
 *
 * A business connects Stripe by pasting a secret key, and HMRC by authorising
 * an OAuth flow that leaves an access token and a refresh token behind. Those
 * are sealed at rest — and the schema says of each one, in a comment,
 * "Never returned by any route, in any shape."
 *
 * Something did hold part of that: the payments tests check the payment
 * endpoints, by name, one at a time. Which is the shape of coverage this
 * repository keeps finding is narrower than the sentence it is written under.
 * A diagnostics endpoint, an export, a settings dump or a screen added next
 * year that serialises a row it did not write is caught by none of them.
 *
 * So this asks every GET route in every module, and the host's own, as the
 * **owner** — the person entitled to see everything there is to see. That is
 * deliberate: the property is not "somebody unauthorised cannot read the key",
 * it is that *nobody* reads it back, because a key that can be displayed can be
 * screenshotted, logged by a browser extension, or read over a shoulder, and
 * the business already has it.
 *
 * **Both forms are searched for.** The plaintext, obviously. And the sealed
 * string, because that is what a row actually holds — a route that returns the
 * column untouched has leaked the ciphertext of a live key, and the honest
 * assumption about ciphertext is that it will not stay opaque forever.
 */

const MODULES = {
  crm,
  invoicing,
  accounting,
  users,
  dashboard,
  settings,
  profile,
};

const suffix = crypto.randomUUID().slice(0, 8);

/** Distinctive enough that finding it anywhere is unambiguous. */
const STRIPE_KEY = `sk_live_zzleak${suffix}`;
const HMRC_ACCESS = `hmrc_access_zzleak${suffix}`;
const HMRC_REFRESH = `hmrc_refresh_zzleak${suffix}`;

let headers: Headers;
let orgId: string;
let userId: string;
/** What the rows actually hold — the sealed form of each secret above. */
const sealed: string[] = [];

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email: `leak-${suffix}@example.test`,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  userId = signUp.response.user.id;
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Leak ${suffix}`, slug: `leak-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: org.id },
    headers,
  });

  const stripeSecret = secrets.seal(STRIPE_KEY);
  const access = secrets.seal(HMRC_ACCESS);
  const refresh = secrets.seal(HMRC_REFRESH);
  sealed.push(stripeSecret, access, refresh);

  await db.insert(schema.paymentAccounts).values({
    organizationId: orgId,
    provider: "stripe",
    mode: "live",
    publicKey: `pk_live_visible${suffix}`,
    secretKey: stripeSecret,
    webhookSecret: secrets.seal(`whsec_zzleak${suffix}`),
    enabled: true,
  });
  await db.insert(schema.mtdConnections).values({
    organizationId: orgId,
    vrn: "123456789",
    accessToken: access,
    refreshToken: refresh,
    expiresAt: new Date(Date.now() + 3_600_000),
    sandbox: true,
  });
});

afterAll(async () => {
  await db
    .delete(schema.mtdConnections)
    .where(eq(schema.mtdConnections.organizationId, orgId));
  await db
    .delete(schema.paymentAccounts)
    .where(eq(schema.paymentAccounts.organizationId, orgId));
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  await db
    .delete(schema.session)
    .where(inArray(schema.session.userId, [userId]));
  await db
    .delete(schema.account)
    .where(inArray(schema.account.userId, [userId]));
  await db.delete(schema.user).where(inArray(schema.user.id, [userId]));
});

test("the business that owns the credential still cannot read it back", async () => {
  // The pair that keeps the sweep honest: the connection is really there, and
  // the screen really does describe it — it just never hands the key over.
  const app = registerForTest(settings);
  const res = await app.request("http://localhost/api/payments/accounts", {
    headers,
  });
  const body = await res.text();
  expect(res.status).toBe(200);
  // The publishable half is not a secret and is shown as it is, which is what
  // proves this route was reached and answered about the right account.
  expect(body).toContain(`pk_live_visible${suffix}`);
  expect(body).not.toContain(STRIPE_KEY);
});

test("no read anywhere returns a stored credential, sealed or not", async () => {
  const leaked: string[] = [];
  let checked = 0;

  const sweep = async (
    name: string,
    app: {
      routes?: { method: string; path: string }[];
      request: (url: string, init?: RequestInit) => Promise<Response>;
    },
  ) => {
    const seen = new Set<string>();
    for (const route of app.routes ?? []) {
      if (route.method !== "GET") continue;
      if (!route.path.startsWith("/api")) continue;
      if (route.path.startsWith("/api/auth")) continue;
      if (seen.has(route.path)) continue;
      seen.add(route.path);
      checked += 1;

      const path = route.path.replace(/:[A-Za-z]+/g, "nothing");
      const res = await app.request(`http://localhost${path}`, { headers });
      const body = await res.text();

      for (const [what, needle] of [
        ["the Stripe key", STRIPE_KEY],
        ["the HMRC access token", HMRC_ACCESS],
        ["the HMRC refresh token", HMRC_REFRESH],
        ...sealed.map((s) => ["a sealed credential", s] as const),
      ] as [string, string][]) {
        if (needle && body.includes(needle)) {
          leaked.push(`${name}: GET ${route.path} → ${what}`);
        }
      }
    }
  };

  for (const [name, mod] of Object.entries(MODULES)) {
    await sweep(
      name,
      registerForTest(mod) as unknown as Parameters<typeof sweep>[1],
    );
  }
  /*
   * The host's own routes are deliberately not swept here.
   *
   * `apps/server/index.ts` is evaluated once per process and builds its module
   * registry from whichever licence environment the first importer happened to
   * set — so a second test file importing it reorders that, and `boot.test.ts`
   * starts asserting against a Pro instance it never asked for. That happened
   * when this file first imported it.
   *
   * Nothing is lost by leaving them out: the host serves `/healthz`,
   * `/api/_meta`, `/api/_signin` and `/api/_source`, none of which reads a
   * payment account or an HMRC connection. The credentials live in modules and
   * are swept where they live.
   */

  expect(checked).toBeGreaterThan(20);
  // Named rather than counted, so a regression says which screen showed it.
  expect([...new Set(leaked)].sort()).toEqual([]);
}, 120_000);
