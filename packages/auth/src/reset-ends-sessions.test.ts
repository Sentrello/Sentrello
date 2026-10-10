import { afterAll, expect, test } from "bun:test";
import { db, eq, like, schema } from "@sentrello/db";
import { auth } from "./index";
import { signUpAsOwner } from "./testing";

/**
 * Resetting a password through the emailed link signs everybody else out.
 *
 * The reason somebody resets a password is very often that somebody else has
 * it. The host command, `sentrello reset-password`, already ended every
 * session; the link — the way most people do it — changed the password and
 * left a thief's session open for as long as sessions last, which here is up
 * to thirty days. Found 10 October 2026.
 */

const email = `reset-sessions-${crypto.randomUUID().slice(0, 8)}@example.test`;

afterAll(async () => {
  const [u] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email));
  if (!u) return;
  await db.delete(schema.session).where(eq(schema.session.userId, u.id));
  await db.delete(schema.account).where(eq(schema.account.userId, u.id));
  await db.delete(schema.user).where(eq(schema.user.id, u.id));
});

test("a reset by email ends the sessions that were already open", async () => {
  const signUp = await signUpAsOwner({
    email,
    password: "correct-horse-battery-staple",
    name: "Reset",
  });
  const thief = new Headers({ cookie: signUp.headers.get("set-cookie") ?? "" });
  expect(await auth.api.getSession({ headers: thief })).not.toBeNull();

  await auth.api.requestPasswordReset({ body: { email } });
  const [user] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email));
  const [row] = await db
    .select({ identifier: schema.verification.identifier })
    .from(schema.verification)
    .where(like(schema.verification.value, user?.id ?? "none"));
  const token = row?.identifier.replace("reset-password:", "") ?? "";
  expect(token).not.toBe("");

  await auth.api.resetPassword({
    body: { token, newPassword: "a-completely-different-one" },
  });
  expect(await auth.api.getSession({ headers: thief })).toBeNull();
});
