/**
 * Clear an account lock from the host, for when signing in cannot.
 *
 * `lockState` (`packages/db/src/lockout.ts`) allows anyone who knows an
 * address to keep it locked indefinitely from a single IP — one wrong
 * password every few minutes is three orders of magnitude under the
 * production rate limiter — and on a self-hosted instance that address is
 * usually the owner's, the one person with nobody else to ask for an unlock.
 * This is the way back in: it writes the same `account.unlocked` event the
 * in-app unlock route does, from the host rather than from a session, the
 * same way `resetPasswordForEmail` (`./reset-password.ts`) is the host-side
 * sibling of "issue a new password". Anyone who can run this already has
 * shell on the machine holding the database, so it grants nothing they did
 * not have; what it saves is them writing the row by hand with a SQL client.
 *
 * Run through the CLI: `sentrello unlock <email>`.
 */
import { db, schema } from "@sentrello/db";
import { asc, eq } from "@sentrello/db/orm";
import { record } from "@sentrello/db/security-events";

export async function unlockForEmail(
  email: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const address = email.trim().toLowerCase();

  const [user] = await db
    .select({
      id: schema.user.id,
      name: schema.user.name,
      email: schema.user.email,
    })
    .from(schema.user)
    .where(eq(schema.user.email, address))
    .limit(1);
  if (!user) return { ok: false, reason: `no account for ${email}` };

  // The earliest organization this person belongs to. `lockState` is scoped
  // by `organizationId` and `email` together, so the event this writes has
  // to name one — and a self-hosted instance has exactly one organization by
  // design, so "the org this person is in" and "the org this instance is" are
  // the same question. `sign-in-events.ts`'s
  // `organizationFor` resolves a sign-in the same way, from the same table,
  // for the same reason.
  const [membership] = await db
    .select({ organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, user.id))
    .orderBy(asc(schema.member.createdAt))
    .limit(1);
  if (!membership) {
    return {
      ok: false,
      reason: `${email} is not a member of any organization`,
    };
  }

  await record({
    organizationId: membership.organizationId,
    // Run from the host, not by any signed-in account — there is nobody to
    // attribute this to, the same as a sign-in attempt against a stranger's
    // address.
    actor: null,
    subject: user,
    action: "account.unlocked",
    detail: { email: address },
  });

  return { ok: true };
}

if (import.meta.main) {
  const [email] = process.argv.slice(2);
  if (!email) {
    console.error("usage: unlock <email>");
    process.exit(1);
  }

  const result = await unlockForEmail(email);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    process.exit(1);
  }

  console.log(`Unlocked ${email}`);
  process.exit(0);
}
