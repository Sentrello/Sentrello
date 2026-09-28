import { afterAll, expect, test } from "bun:test";
import { db, schema } from "@sentrello/db";
import { eq } from "drizzle-orm";
import { auth } from "./index";
import { signUpAsOwner } from "./testing";

/**
 * The property worth defending: turning 2FA on does not turn it on.
 *
 * Better Auth writes `twoFactorEnabled` only after a code from the app has
 * actually verified. Without that order, somebody scans a code into an app
 * they then delete and is locked out of their own books, on a self-hosted
 * instance where there is no support desk to ring.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const email = `twofactor-${suffix}@x.test`;
const password = "correct-horse-battery-staple";

afterAll(async () => {
  const [u] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email));
  if (!u) return;
  await db.delete(schema.twoFactor).where(eq(schema.twoFactor.userId, u.id));
  await db.delete(schema.member).where(eq(schema.member.userId, u.id));
  await db.delete(schema.session).where(eq(schema.session.userId, u.id));
  await db.delete(schema.account).where(eq(schema.account.userId, u.id));
  await db.delete(schema.user).where(eq(schema.user.id, u.id));
});

test("enabling hands back codes but leaves 2FA off until one is proved", async () => {
  const signUp = await signUpAsOwner({ email, password, name: "Owner" });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  const headers = new Headers({ cookie });

  const enabled = await auth.api.enableTwoFactor({
    body: { password },
    headers,
  });

  expect(enabled.totpURI).toContain("otpauth://totp/");
  // A secret to type in, since there is no QR code to scan.
  expect(new URL(enabled.totpURI).searchParams.get("secret")).toBeTruthy();
  expect(enabled.backupCodes.length).toBeGreaterThan(0);

  const [user] = await db
    .select({ twoFactorEnabled: schema.user.twoFactorEnabled })
    .from(schema.user)
    .where(eq(schema.user.email, email));
  expect(user?.twoFactorEnabled ?? false).toBe(false);

  // The row exists and knows it is unproved, which is what makes the next
  // sign-in ask for a password only rather than a code nobody can produce.
  const [record] = await db
    .select({ verified: schema.twoFactor.verified })
    .from(schema.twoFactor)
    .innerJoin(schema.user, eq(schema.twoFactor.userId, schema.user.id))
    .where(eq(schema.user.email, email));
  expect(record?.verified).toBe(false);
});

test("a wrong password does not start the process at all", async () => {
  const signIn = await auth.api.signInEmail({
    body: { email, password },
    returnHeaders: true,
  });
  const cookie = signIn.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-in returned no session cookie");

  await expect(
    auth.api.enableTwoFactor({
      body: { password: "not-the-password" },
      headers: new Headers({ cookie }),
    }),
  ).rejects.toThrow();
});
