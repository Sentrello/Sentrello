import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import { registerForTest } from "@sentrello/module-sdk";
import { eq } from "drizzle-orm";
import profile from "./index";
import { DEFAULTS, normalize } from "./preferences";

const app = registerForTest(profile);
let headers: Headers;
let orgId: string;
let userId: string;

const suffix = crypto.randomUUID().slice(0, 8);
const email = `profile-${suffix}@x.test`;

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Profile ${suffix}`, slug: `profile-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  const [u] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email));
  if (!u) throw new Error("no user");
  userId = u.id;
});

afterAll(async () => {
  await db
    .delete(schema.userPreferences)
    .where(eq(schema.userPreferences.organizationId, orgId));
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  await db.delete(schema.session).where(eq(schema.session.userId, userId));
  await db.delete(schema.account).where(eq(schema.account.userId, userId));
  await db.delete(schema.user).where(eq(schema.user.id, userId));
});

const get = () =>
  app
    .request("http://localhost/api/profile", { headers })
    .then((r) => r.json());

test("an account nobody has configured still answers with something usable", async () => {
  const body = (await get()) as {
    user: { email: string };
    preferences: typeof DEFAULTS;
    sessions: { current: boolean }[];
  };
  expect(body.user.email).toBe(email);
  expect(body.preferences).toEqual(DEFAULTS);
  // The session doing the asking is in the list and knows it is the one in
  // front of you — otherwise "sign out everywhere else" has no meaning.
  expect(body.sessions.filter((s) => s.current)).toHaveLength(1);
});

test("preferences survive a save", async () => {
  const res = await app.request("http://localhost/api/profile", {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      name: "Jane Owner",
      preferences: {
        timezone: "America/Denver",
        dateFormat: "DMY",
        currency: "gbp",
        landingPage: "invoicing",
        workingHours: { start: "07:30", end: "16:00", days: [1, 3, 5] },
      },
    }),
  });
  expect(res.status).toBe(200);

  const body = (await get()) as {
    user: { name: string };
    preferences: typeof DEFAULTS;
  };
  expect(body.user.name).toBe("Jane Owner");
  expect(body.preferences.timezone).toBe("America/Denver");
  expect(body.preferences.currency).toBe("GBP");
  expect(body.preferences.workingHours).toEqual({
    start: "07:30",
    end: "16:00",
    days: [1, 3, 5],
  });
});

/**
 * These values are interpolated into dates, money and a landing route. A
 * timezone nobody checked throws inside `Intl` on somebody else's screen.
 */
test("nonsense falls back rather than being stored", () => {
  const p = normalize({
    timezone: "Mars/Olympus",
    dateFormat: "swedish",
    currency: "US DOLLARS",
    landingPage: "../../etc/passwd",
    workingHours: { start: "25:00", end: "nope", days: [9, 9, 2] },
  });
  expect(p.timezone).toBe("");
  expect(p.dateFormat).toBe(DEFAULTS.dateFormat);
  expect(p.currency).toBe("USD");
  expect(p.landingPage).toBe("");
  expect(p.workingHours.start).toBe(DEFAULTS.workingHours.start);
  expect(p.workingHours.days).toEqual([2]);
  // A week with no working days is somebody who cleared the boxes by accident.
  expect(normalize({ workingHours: { days: [] } }).workingHours.days).toEqual(
    DEFAULTS.workingHours.days,
  );
});

test("you cannot sign out the session you are using, or anyone else's", async () => {
  const body = (await get()) as {
    sessions: { id: string; current: boolean }[];
  };
  const mine = body.sessions.find((s) => s.current);
  if (!mine) throw new Error("no current session");

  const refused = await app.request(
    `http://localhost/api/profile/sessions/${mine.id}`,
    { method: "DELETE", headers },
  );
  expect(refused.status).toBe(400);

  // Somebody else's session row, which this endpoint must not be able to see
  // let alone delete. It is filtered by the caller's own user id, and that
  // filter is what stands in for a permission check here.
  //
  // Written straight into the tables rather than by signing a second person
  // up: the instance is claimed by now, so sign-up is closed and the check
  // would quietly skip itself — which would look like it had passed.
  const strangerId = `stranger-${suffix}`;
  await db.insert(schema.user).values({
    id: strangerId,
    name: "Stranger",
    email: `stranger-${suffix}@x.test`,
    emailVerified: false,
    updatedAt: new Date(),
  });
  await db.insert(schema.session).values({
    id: `stranger-session-${suffix}`,
    userId: strangerId,
    token: `stranger-token-${suffix}`,
    expiresAt: new Date(Date.now() + 3_600_000),
    updatedAt: new Date(),
  });

  const res = await app.request(
    `http://localhost/api/profile/sessions/stranger-session-${suffix}`,
    { method: "DELETE", headers },
  );
  expect(((await res.json()) as { revoked: number }).revoked).toBe(0);
  const still = await db
    .select({ id: schema.session.id })
    .from(schema.session)
    .where(eq(schema.session.id, `stranger-session-${suffix}`));
  expect(still).toHaveLength(1);

  await db.delete(schema.session).where(eq(schema.session.userId, strangerId));
  await db.delete(schema.user).where(eq(schema.user.id, strangerId));
});

test("changing a password needs the old one", async () => {
  const wrong = await app.request("http://localhost/api/profile/password", {
    method: "POST",
    headers,
    body: JSON.stringify({
      currentPassword: "not-the-password",
      newPassword: "a-much-better-passphrase",
    }),
  });
  expect(wrong.status).toBe(400);

  const right = await app.request("http://localhost/api/profile/password", {
    method: "POST",
    headers,
    body: JSON.stringify({
      currentPassword: "correct-horse-battery-staple",
      newPassword: "a-much-better-passphrase",
    }),
  });
  expect(right.status).toBe(200);
});

/**
 * A billing account: signed in, a member of nothing, on the instance that
 * sells Sentrello. It has sessions to see and no preferences to read.
 *
 * This threw, and the 500 landed on every such sign-in — the shell fetches
 * this before it can decide what to draw, so a customer's first impression of
 * the product was a server error in the console.
 */
test("somebody who belongs to no organization gets their profile, not a 500", async () => {
  const loose = `profile-loose-${crypto.randomUUID().slice(0, 8)}@x.test`;
  const signUp = await signUpAsOwner({
    email: loose,
    password: "correct-horse-battery-staple",
    name: "Billing Only",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");

  const res = await app.request("http://localhost/api/profile", {
    headers: new Headers({ cookie }),
  });
  expect(res.status).toBe(200);

  const body = (await res.json()) as {
    preferences: typeof DEFAULTS;
    sessions: { id: string }[];
  };
  expect(body.preferences).toEqual(DEFAULTS);
  expect(body.sessions.length).toBeGreaterThan(0);

  const [u] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, loose));
  if (u) {
    await db.delete(schema.session).where(eq(schema.session.userId, u.id));
    await db.delete(schema.account).where(eq(schema.account.userId, u.id));
    await db.delete(schema.user).where(eq(schema.user.id, u.id));
  }
});
