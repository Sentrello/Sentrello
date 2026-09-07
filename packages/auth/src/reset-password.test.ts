import { afterAll, beforeAll, expect, test } from "bun:test";
import { db, eq, schema } from "@sentrello/db";
import { lockState } from "@sentrello/db/lockout";
import { auth } from "./index";
import { resetPasswordForEmail } from "./reset-password";
import { signUpAsOwner } from "./testing";

/**
 * The way back in when email cannot help.
 *
 * A self-hosted instance may have no mail configured at all, and its owner is
 * usually the only administrator — so a forgotten password had no route back
 * except editing the database by hand.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const email = `locked-out-${suffix}@example.test`;
const secondOwnerEmail = `reset-lockout-owner-${suffix}@example.test`;
const orgSlug = `reset-${suffix}`;
const original = "correct-horse-battery-staple";

beforeAll(async () => {
  await signUpAsOwner({ email, password: original, name: "Locked Out" });
});

afterAll(async () => {
  // The organization the lockout test creates goes first, and with it every
  // row scoped to it. An organization left behind is not a tidiness problem:
  // the bootstrap suite refuses to claim an instance that already has one,
  // and `sign-in-events` attributes an orphan address to the *oldest*
  // organization, so one leaked row here fails six tests in two other files
  // for reasons that look nothing like this one.
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, orgSlug));
  if (org) {
    await db
      .delete(schema.securityEvents)
      .where(eq(schema.securityEvents.organizationId, org.id));
    await db
      .delete(schema.securityPolicy)
      .where(eq(schema.securityPolicy.organizationId, org.id));
    await db
      .delete(schema.member)
      .where(eq(schema.member.organizationId, org.id));
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, org.id));
  }

  for (const address of [email, secondOwnerEmail]) {
    const [u] = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, address));
    if (!u) continue;
    await db.delete(schema.session).where(eq(schema.session.userId, u.id));
    await db.delete(schema.account).where(eq(schema.account.userId, u.id));
    await db.delete(schema.user).where(eq(schema.user.id, u.id));
  }
});

const signIn = (password: string) =>
  auth.api
    .signInEmail({ body: { email, password }, asResponse: true })
    .then((r) => r.status)
    .catch(() => 401);

test("the new password works and the old one stops working", async () => {
  expect(await signIn(original)).toBe(200);

  const result = await resetPasswordForEmail(email, "a-brand-new-password");
  expect(result.ok).toBe(true);

  expect(await signIn("a-brand-new-password")).toBe(200);
  expect(await signIn(original)).not.toBe(200);
});

test("existing sessions are ended, not left open", async () => {
  // Resetting because someone else had the password is pointless if their
  // session survives it.
  const [u] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email));
  if (!u) throw new Error("expected the test user");

  await auth.api.signInEmail({
    body: { email, password: "a-brand-new-password" },
    asResponse: true,
  });
  const before = await db
    .select()
    .from(schema.session)
    .where(eq(schema.session.userId, u.id));
  expect(before.length).toBeGreaterThan(0);

  await resetPasswordForEmail(email, "another-new-password");

  const after = await db
    .select()
    .from(schema.session)
    .where(eq(schema.session.userId, u.id));
  expect(after).toHaveLength(0);
});

test("an unknown address is refused without saying more", async () => {
  const result = await resetPasswordForEmail(
    "nobody@example.test",
    "whatever-long",
  );
  expect(result.ok).toBe(false);
});

test("a password too short to be worth setting is refused", async () => {
  const result = await resetPasswordForEmail(email, "short");
  expect(result).toEqual({
    ok: false,
    reason: "the password must be at least 8 characters",
  });
  // And the account still opens with the one it had.
  expect(await signIn("another-new-password")).toBe(200);
});

/**
 * Ruling 32: `docs/self-hosting.md` claims this command clears a lock along
 * with setting a password. It only does so if it writes the `password.reset`
 * event `lockState` (`packages/db/src/lockout.ts`) reads to decide whether
 * the window is cleared — the same event `POST /api/users/:userId/password`
 * writes in-app. Without it, a locked-out sole administrator runs the command
 * the runbook lists, gets a new password, and is still told "too many failed
 * attempts".
 */
test("resetting a locked account's password clears the lock", async () => {
  const [u] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email));
  if (!u) throw new Error("expected the test user");

  const signUp = await signUpAsOwner({
    email: secondOwnerEmail,
    password: "correct-horse-battery-staple",
    name: "Owner Two",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  const orgHeaders = new Headers({
    cookie,
    "content-type": "application/json",
  });
  const org = await auth.api.createOrganization({
    body: { name: `Reset ${suffix}`, slug: orgSlug },
    headers: orgHeaders,
  });
  if (!org) throw new Error("could not create organization");
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: org.id,
    userId: u.id,
    role: "staff",
    baseRole: "staff",
    createdAt: new Date(),
  });

  for (let i = 0; i < 5; i += 1) {
    await db.insert(schema.securityEvents).values({
      organizationId: org.id,
      action: "sign-in.failed",
      detail: { email },
    });
  }
  expect((await lockState(org.id, email)).locked).toBe(true);

  const result = await resetPasswordForEmail(email, "yet-another-new-password");
  expect(result.ok).toBe(true);

  expect((await lockState(org.id, email)).locked).toBe(false);
});

/**
 * The branch's finishing review swept every place an address is written or
 * compared, checking they fold it the same way. This one lowercased without
 * trimming while `unlock.ts` beside it and `lockState` both trim first — and
 * this is a command somebody pastes into a terminal, where a trailing space
 * is an ordinary way to arrive.
 */
test("an address with a stray space is the same address", async () => {
  const result = await resetPasswordForEmail(
    `  ${email.toUpperCase()} `,
    "padded-address-password",
  );
  expect(result.ok).toBe(true);
  expect(await signIn("padded-address-password")).toBe(200);
});
