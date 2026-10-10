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
const raceEmail = `reset-race-${crypto.randomUUID().slice(0, 8)}@example.test`;

afterAll(async () => {
  for (const address of [email, raceEmail]) {
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

/** The token a reset email would have carried for this address. */
async function resetTokenFor(address: string): Promise<string> {
  await auth.api.requestPasswordReset({ body: { email: address } });
  const [user] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, address));
  const [row] = await db
    .select({ identifier: schema.verification.identifier })
    .from(schema.verification)
    .where(like(schema.verification.value, user?.id ?? "none"));
  return row?.identifier.replace("reset-password:", "") ?? "";
}

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

test("one reset link used ten times at once sets one password", async () => {
  await signUpAsOwner({
    email: raceEmail,
    password: "correct-horse-battery-staple",
    name: "Reset Race",
  });
  const token = await resetTokenFor(raceEmail);
  expect(token).not.toBe("");

  const answers = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) =>
      auth.api.resetPassword({
        body: { token, newPassword: `a-different-password-${i}` },
      }),
    ),
  );
  expect(answers.filter((a) => a.status === "fulfilled")).toHaveLength(1);
}, 30_000);
