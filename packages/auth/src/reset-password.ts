/**
 * Set a password from the host, for when email cannot help.
 *
 * A self-hosted instance may have no mail configured, and its owner is usually
 * the only administrator — so a forgotten password had no route back except
 * editing the database by hand. Anyone who can run this already has shell on
 * the machine holding the database, so it grants nothing they did not have;
 * what it saves is them doing it with a SQL client and a hashing library.
 *
 * `docs/self-hosting.md` documents this as also clearing an account lock, so
 * it writes the same `password.reset` event `POST /api/users/:userId/password`
 * does (`packages/modules-free/users/src/people.ts`) — `lockState`
 * (`packages/db/src/lockout.ts`) reads that event to decide whether the
 * lockout window is cleared. Without it, a locked-out sole administrator
 * would run this command, get a new password, and still be told "too many
 * failed attempts".
 *
 * Run through the CLI: `sentrello reset-password <email>`.
 */
import { db, schema } from "@sentrello/db";
import { asc, eq } from "@sentrello/db/orm";
import { record } from "@sentrello/db/security-events";
import { auth } from "./index";

export async function resetPasswordForEmail(
  email: string,
  newPassword: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (newPassword.length < 8) {
    return { ok: false, reason: "the password must be at least 8 characters" };
  }

  // Trimmed as well as folded, matching `unlock.ts` beside it and `lockState`
  // (`packages/db/src/lockout.ts`), which both do `trim().toLowerCase()`.
  // This is a command somebody types or pastes into a terminal, so a trailing
  // space is a real way to arrive here, and without the trim it answers "no
  // account for you@example.com" about an account that plainly exists.
  const address = email.trim().toLowerCase();
  const [user] = await db
    .select({ id: schema.user.id, name: schema.user.name })
    .from(schema.user)
    .where(eq(schema.user.email, address))
    .limit(1);
  if (!user) return { ok: false, reason: `no account for ${email}` };

  // Better Auth's own hashing, rather than writing the hash here: the format
  // is its business and reimplementing it is how accounts stop opening.
  const ctx = await auth.$context;
  const hash = await ctx.password.hash(newPassword);
  await ctx.internalAdapter.updatePassword(user.id, hash);

  // Every existing session ends. If the password was reset because someone
  // else had it, leaving their session alive would defeat the point.
  await db.delete(schema.session).where(eq(schema.session.userId, user.id));

  // The earliest organization this person belongs to — `security_events` rows
  // are organization-scoped and the CLI has no session to take one from.
  // Same resolution as `organizationFor` in `sign-in-events.ts` and
  // `unlockForEmail` in `./unlock.ts`: a self-hosted instance has exactly one
  // organization, so "the org this person is in" and "the org this instance
  // is" are the same question. A user who belongs to no organization (never
  // joined one, or was removed from every one) has no scope to write the
  // event into — the password is still reset, but nothing is recorded and
  // there is no lock to clear, since a lock is also organization-scoped.
  const [membership] = await db
    .select({ organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, user.id))
    .orderBy(asc(schema.member.createdAt))
    .limit(1);
  if (membership) {
    await record({
      organizationId: membership.organizationId,
      // Run from the host, not by any signed-in account.
      actor: null,
      subject: { id: user.id, name: user.name, email: address },
      action: "password.reset",
      detail: { email: address },
    });
  }

  return { ok: true };
}

if (import.meta.main) {
  const [email, supplied] = process.argv.slice(2);
  if (!email) {
    console.error("usage: reset-password <email> [password]");
    process.exit(1);
  }

  // Generated when not supplied, so a password never has to be invented on the
  // spot or typed into a shell history.
  const password =
    supplied ??
    Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString(
      "base64url",
    );

  const result = await resetPasswordForEmail(email, password);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    process.exit(1);
  }

  console.log(`Password set for ${email}`);
  if (!supplied) console.log(`  ${password}`);
  console.log("All existing sessions for this account have been signed out.");
  process.exit(0);
}
