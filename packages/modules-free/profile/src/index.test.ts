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

/**
 * Changing the address you sign in with.
 *
 * `sendChangeEmailConfirmation` (`packages/auth/src/index.ts`) is stubbed by
 * pointing `emailAdapter()` at a fake Resend and capturing what it was asked
 * to send — the same technique `invitations.test.ts` uses for the same
 * reason: a real send would reach the network from a test.
 */
function stubResend() {
  const realFetch = globalThis.fetch;
  const sent: { to: string; html: string }[] = [];
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("https://api.resend.com/")) {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        to: string;
        html: string;
      };
      sent.push(payload);
      return new Response(JSON.stringify({ id: "stubbed" }), { status: 200 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  return {
    sent,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

/** The token a mailed confirm/verify link carries, out of its raw HTML. */
const tokenIn = (html: string) => html.match(/token=([^&"]+)/)?.[1];

test("confirming from the old address, then verifying the new one, moves the sign-in email", async () => {
  // The bootstrapped owner's address counts as confirmed the moment setup
  // finishes (`bootstrap.ts`); `signUpAsOwner` skips that step, so this test
  // sets it explicitly to exercise the two-step, verified-account flow.
  await db
    .update(schema.user)
    .set({ emailVerified: true })
    .where(eq(schema.user.id, userId));

  const savedKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = "re_test_never_sent";
  const { sent, restore } = stubResend();
  const newEmail = `changed-${suffix}@x.test`;

  try {
    const res = await app.request("http://localhost/api/profile/email", {
      method: "POST",
      headers,
      body: JSON.stringify({ newEmail }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { requested: boolean; message: string };
    expect(body.requested).toBe(true);
    // This account is verified, so it is told to check the address it
    // already has — not the new one, which has not been told anything yet.
    expect(body.message).toContain("current inbox");

    // Nothing moved: a link went out, and nobody has followed it yet.
    const [pending] = await db
      .select({ email: schema.user.email })
      .from(schema.user)
      .where(eq(schema.user.id, userId));
    expect(pending?.email).toBe(email);

    // The old address is the one that heard about it, and the only one so far.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(email);
    const confirmToken = tokenIn(sent[0]?.html ?? "");
    if (!confirmToken) throw new Error("no confirm token in the email");

    // Following that link still does not move the email — it mints and
    // mails a second, ordinary verification link, to the new address.
    const confirmed = await auth.api.verifyEmail({
      query: { token: confirmToken },
      headers,
    });
    expect(confirmed.status).toBe(true);
    const [stillPending] = await db
      .select({ email: schema.user.email })
      .from(schema.user)
      .where(eq(schema.user.id, userId));
    expect(stillPending?.email).toBe(email);

    expect(sent).toHaveLength(2);
    expect(sent[1]?.to).toBe(newEmail);
    const verifyToken = tokenIn(sent[1]?.html ?? "");
    if (!verifyToken) throw new Error("no verify token in the email");

    // Following *that* one is what actually moves it.
    await auth.api.verifyEmail({ query: { token: verifyToken }, headers });
    const [moved] = await db
      .select({
        email: schema.user.email,
        emailVerified: schema.user.emailVerified,
      })
      .from(schema.user)
      .where(eq(schema.user.id, userId));
    expect(moved?.email).toBe(newEmail);
    expect(moved?.emailVerified).toBe(true);
  } finally {
    restore();
    process.env.RESEND_API_KEY = savedKey;
    // Put it back, so every test after this one still means what it says
    // about `email`, `headers` and this account's verified state.
    await db
      .update(schema.user)
      .set({ email, emailVerified: false })
      .where(eq(schema.user.id, userId));
  }
});

test("requesting a change does not move the address, which keeps signing in, until it's confirmed", async () => {
  const savedKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = "re_test_never_sent";
  const { restore } = stubResend();

  try {
    const res = await app.request("http://localhost/api/profile/email", {
      method: "POST",
      headers,
      body: JSON.stringify({ newEmail: `pending-${suffix}@x.test` }),
    });
    expect(res.status).toBe(200);

    const [row] = await db
      .select({ email: schema.user.email })
      .from(schema.user)
      .where(eq(schema.user.id, userId));
    expect(row?.email).toBe(email);

    // Not the cookie already in hand — an actual sign-in, with the password
    // set two tests ago, against the address that was never touched.
    const signIn = await auth.api.signInEmail({
      body: { email, password: "a-much-better-passphrase" },
      returnHeaders: true,
    });
    expect(signIn.headers.get("set-cookie")).toBeTruthy();
  } finally {
    restore();
    process.env.RESEND_API_KEY = savedKey;
  }
});

test("naming an address another account already holds neither succeeds nor reveals it", async () => {
  const takenEmail = `taken-${suffix}@x.test`;
  await signUpAsOwner({
    email: takenEmail,
    password: "correct-horse-battery-staple",
    name: "Someone Else",
  });
  const [otherUser] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, takenEmail));

  const savedKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = "re_test_never_sent";
  const { sent, restore } = stubResend();

  try {
    const collide = await app.request("http://localhost/api/profile/email", {
      method: "POST",
      headers,
      body: JSON.stringify({ newEmail: takenEmail }),
    });
    const collideBody = (await collide.json()) as Record<string, unknown>;

    const free = await app.request("http://localhost/api/profile/email", {
      method: "POST",
      headers,
      body: JSON.stringify({ newEmail: `definitely-free-${suffix}@x.test` }),
    });
    const freeBody = (await free.json()) as Record<string, unknown>;

    // Same status, same shape, either way — nothing here says which address
    // already belongs to somebody.
    expect(collide.status).toBe(free.status);
    expect(Object.keys(collideBody).sort()).toEqual(
      Object.keys(freeBody).sort(),
    );

    // And the collision really did not happen — no email went anywhere
    // about it, because there is nobody it would be safe to mail; only the
    // second, non-colliding request actually sent one.
    expect(sent).toHaveLength(1);

    const [mine] = await db
      .select({ email: schema.user.email })
      .from(schema.user)
      .where(eq(schema.user.id, userId));
    expect(mine?.email).toBe(email);
  } finally {
    restore();
    process.env.RESEND_API_KEY = savedKey;
    if (otherUser) {
      await db
        .delete(schema.session)
        .where(eq(schema.session.userId, otherUser.id));
      await db
        .delete(schema.account)
        .where(eq(schema.account.userId, otherUser.id));
      await db.delete(schema.user).where(eq(schema.user.id, otherUser.id));
    }
  }
});

test("with no mail server configured, changing email says so instead of pretending", async () => {
  const savedKey = process.env.RESEND_API_KEY;
  const savedHost = process.env.SMTP_HOST;
  process.env.RESEND_API_KEY = undefined;
  process.env.SMTP_HOST = undefined;

  try {
    const res = await app.request("http://localhost/api/profile/email", {
      method: "POST",
      headers,
      body: JSON.stringify({ newEmail: `no-mail-${suffix}@x.test` }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("no mail server");

    const [row] = await db
      .select({ email: schema.user.email })
      .from(schema.user)
      .where(eq(schema.user.id, userId));
    expect(row?.email).toBe(email);
  } finally {
    process.env.RESEND_API_KEY = savedKey;
    process.env.SMTP_HOST = savedHost;
  }
});
