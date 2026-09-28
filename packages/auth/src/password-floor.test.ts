import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { db, eq, schema } from "@sentrello/db";
import { auth } from "./index";
import { forgetPasswordFloor, passwordFloor } from "./password-floor";
import { signUpAsOwner } from "./testing";

/**
 * The shortest password this business will accept, which nothing read.
 *
 * `security_policy.min_password_length` has been on the screen, validated on
 * write and stored since the Users module shipped. The effective floor stayed
 * the twelve characters configured on the auth library, so a business that set
 * sixteen — because its own framework or its insurer asks for sixteen — was
 * told it had sixteen and had twelve.
 *
 * Found 2026-09-28, beside the per-role second factor, which was the same
 * failure exactly: saved, displayed, applied by no code at all.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const owner = `floor-${suffix}@example.test`;
const orgSlug = `floor-${suffix}`;
let orgId: string;

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email: owner,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  const headers = new Headers({ cookie, "content-type": "application/json" });
  const org = await auth.api.createOrganization({
    body: { name: `Floor ${suffix}`, slug: orgSlug },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
});

afterEach(async () => {
  await db
    .delete(schema.securityPolicy)
    .where(eq(schema.securityPolicy.organizationId, orgId));
  forgetPasswordFloor();
});

afterAll(async () => {
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  await db.delete(schema.user).where(eq(schema.user.email, owner));
});

test("with no policy written, the library's own twelve is the floor", async () => {
  expect(await passwordFloor()).toBe(12);
});

test("a business that asks for more gets more", async () => {
  await db
    .insert(schema.securityPolicy)
    .values({ organizationId: orgId, minPasswordLength: 16 });
  forgetPasswordFloor();
  expect(await passwordFloor()).toBe(16);
});

/**
 * And never less.
 *
 * Twelve is what 800-63B asks of a memorised secret standing on its own, and
 * it is not a business's to waive. The screen's own clamp now agrees — it said
 * eight until today, which meant a business could be shown a number the
 * product would not honour.
 */
test("a business that asks for less is still held to twelve", async () => {
  await db
    .insert(schema.securityPolicy)
    .values({ organizationId: orgId, minPasswordLength: 8 });
  forgetPasswordFloor();
  expect(await passwordFloor()).toBe(12);
});

/**
 * Every way a password is set, not only the form.
 *
 * A rule enforced on one screen is a rule the API does not have. This walks
 * the sign-up endpoint itself, which is where the invitation flow, the CLI
 * and the setup form all end up.
 */
test("a password under the business's floor is refused at the endpoint", async () => {
  await db
    .insert(schema.securityPolicy)
    .values({ organizationId: orgId, minPasswordLength: 20 });
  forgetPasswordFloor();

  const short = `floor-short-${suffix}@example.test`;
  let refusal: string | null = null;
  try {
    await signUpAsOwner({
      email: short,
      password: "correct-horse",
      name: "Too Short",
    });
  } catch (err) {
    // better-auth wraps the refusal, so the message may be on the error or on
    // the body it carries. Both are read rather than guessing which.
    const thrown = err as {
      message?: string;
      body?: { message?: string };
    };
    refusal = thrown.body?.message ?? thrown.message ?? null;
  }
  expect(refusal ?? "").toContain("20 characters");

  // And nothing was created, which is the half worth checking: a refusal
  // that still writes the row is not a refusal.
  const [made] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, short));
  expect(made).toBeUndefined();
});
