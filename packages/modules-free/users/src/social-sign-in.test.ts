import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { googleProvider, verifyGoogle } from "@sentrello/auth/providers";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, schema } from "@sentrello/db";
import { registerForTest, secrets } from "@sentrello/module-sdk";
import users from "./index";

/**
 * Google sign-in, set up on a screen instead of in a file on a server.
 *
 * Build rule 6 is not negotiable: a third-party integration is authorised,
 * stored and tested in its own settings. This one was two environment
 * variables, so an owner who wanted it needed shell access to the machine
 * running their business — and the published page promising that anything
 * configurable has a screen was wrong about it.
 *
 * Three things have to hold. The details are proved against Google before
 * anything is stored, because credentials saved and wrong fail later on the
 * sign-in page. The secret is sealed, not written down. And what is stored is
 * what authentication actually reads, or the screen is decoration.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const app = registerForTest(users);

let headers: Headers;
let orgId: string;
const realFetch = globalThis.fetch;
const idWas = process.env.GOOGLE_CLIENT_ID;
const secretWas = process.env.GOOGLE_CLIENT_SECRET;

/** Google's own answers, which are what the check reads. */
function googleSays(error: string, status = 400) {
  globalThis.fetch = (async (url: string) =>
    String(url).includes("oauth2.googleapis.com")
      ? new Response(JSON.stringify({ error }), { status })
      : realFetch(url as string)) as unknown as typeof fetch;
}

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email: `social-${suffix}@example.test`,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const set = signUp.headers.get("set-cookie");
  if (!set) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie: set, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Social ${suffix}`, slug: `social-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: org.id },
    headers,
  });
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await db
    .delete(schema.authProviders)
    .where(eq(schema.authProviders.provider, "google"))
    .catch(() => {});
});

afterAll(async () => {
  /*
   * The organization goes, and every delete on its own. One left behind is
   * not an untidy row: the sign-in log resolves an attempt against an unknown
   * address to the oldest organization there is, so a leftover from here
   * becomes the one another suite writes its events against.
   */
  const tidy = async (run: () => Promise<unknown>) => {
    await run().catch(() => {});
  };
  await tidy(() =>
    db
      .delete(schema.securityEvents)
      .where(eq(schema.securityEvents.organizationId, orgId)),
  );
  await tidy(() =>
    db.delete(schema.member).where(eq(schema.member.organizationId, orgId)),
  );
  await tidy(() =>
    db.delete(schema.organizations).where(eq(schema.organizations.id, orgId)),
  );

  // The whole suite shares one process, so these go back exactly as found.
  if (idWas === undefined)
    Reflect.deleteProperty(process.env, "GOOGLE_CLIENT_ID");
  else process.env.GOOGLE_CLIENT_ID = idWas;
  if (secretWas === undefined) {
    Reflect.deleteProperty(process.env, "GOOGLE_CLIENT_SECRET");
  } else process.env.GOOGLE_CLIENT_SECRET = secretWas;
});

const put = (body: unknown) =>
  app.request("http://localhost/api/users/social-sign-in/google", {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });

test("details Google does not recognise are refused and not stored", async () => {
  googleSays("invalid_client", 401);

  const res = await put({ clientId: "wrong.apps", clientSecret: "nope" });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("does not recognise");

  expect(await db.select().from(schema.authProviders)).toHaveLength(0);
});

test("details Google accepts are sealed, and read back by authentication", async () => {
  /*
   * `invalid_grant` is the answer we want: the client is real and the code
   * we sent it could not be. It costs nothing and needs no consent screen.
   */
  googleSays("invalid_grant");

  const res = await put({
    clientId: `${suffix}.apps.googleusercontent.com`,
    clientSecret: "a-real-looking-secret",
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    verified: boolean;
    restartRequired: boolean;
  };
  expect(body.verified).toBe(true);
  // The one surprising thing, and the screen says it because this does.
  expect(body.restartRequired).toBe(true);

  const [row] = await db.select().from(schema.authProviders);
  expect(row?.clientId).toBe(`${suffix}.apps.googleusercontent.com`);
  // Sealed, not written down.
  expect(row?.clientSecret).not.toBe("a-real-looking-secret");
  expect(secrets.open(row?.clientSecret ?? "")).toBe("a-real-looking-secret");
  expect(row?.verifiedAt).toBeTruthy();

  /*
   * And the half that makes the screen worth having: what was stored is what
   * authentication reads. Without this the settings page would be another
   * control that saves, displays and decides nothing.
   */
  const resolved = await googleProvider();
  expect(resolved).toMatchObject({
    clientId: `${suffix}.apps.googleusercontent.com`,
    clientSecret: "a-real-looking-secret",
    enabled: true,
  });
});

test("with nothing stored and nothing in the environment, there is no button", async () => {
  Reflect.deleteProperty(process.env, "GOOGLE_CLIENT_ID");
  Reflect.deleteProperty(process.env, "GOOGLE_CLIENT_SECRET");

  // `enabled: false` is how the library is told a provider does not exist. An
  // instance nobody configured offers no Google button rather than a broken
  // one that fails at the moment somebody presses it.
  expect(await googleProvider()).toMatchObject({ enabled: false });
});

test("the environment still works, and the screen says which way it is set", async () => {
  process.env.GOOGLE_CLIENT_ID = "from-the-environment";
  process.env.GOOGLE_CLIENT_SECRET = "also-from-the-environment";

  expect(await googleProvider()).toMatchObject({
    clientId: "from-the-environment",
    enabled: true,
  });

  const res = await app.request("http://localhost/api/users/social-sign-in", {
    headers,
  });
  const body = (await res.json()) as {
    google: { connected: boolean; fromEnvironment: boolean };
    redirectUri: string;
  };
  expect(body.google).toMatchObject({
    connected: true,
    fromEnvironment: true,
  });
  // Google refuses anything it was not told about, so the screen has to be
  // able to show somebody exactly what to paste over there.
  expect(body.redirectUri).toContain("/api/auth/callback/google");
});

test("a redirect URI Google has never heard of says which one to add", async () => {
  googleSays("redirect_uri_mismatch");
  const out = await verifyGoogle(
    { clientId: "a", clientSecret: "b" },
    "https://example.test/api/auth/callback/google",
  );
  expect(out).toMatchObject({ ok: false });
  if (!out.ok) {
    expect(out.error).toContain(
      "https://example.test/api/auth/callback/google",
    );
  }
});
