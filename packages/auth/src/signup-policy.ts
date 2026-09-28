import { and, db, eq, schema } from "@sentrello/db";
import { APIError, createAuthMiddleware } from "better-auth/api";

/**
 * Set only while the bootstrap route is creating the first owner.
 *
 * "This instance has no organization yet" is NOT sufficient on its own: the
 * sign-up endpoint is public, so a stranger who reaches a fresh instance before
 * its operator would claim it. Claiming therefore has to go through
 * /api/bootstrap, which additionally requires the setup token.
 */
let bootstrapping = false;

export function duringBootstrap<T>(fn: () => Promise<T>): Promise<T> {
  bootstrapping = true;
  return fn().finally(() => {
    bootstrapping = false;
  });
}

/**
 * Addresses the server itself is in the middle of creating an account for.
 *
 * Scoped to one address and held for one call rather than opening sign-up
 * globally, which is what a plain flag would do: the window is milliseconds,
 * but on a publicly reachable instance a millisecond of open registration is
 * still open registration. Anyone racing this would additionally have to know
 * the exact address being registered.
 */
const expected = new Set<string>();

export async function allowSignupFor<T>(
  email: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = email.trim().toLowerCase();
  expected.add(key);
  try {
    return await fn();
  } finally {
    expected.delete(key);
  }
}

/**
 * Who may create an account on this instance.
 *
 * Left open, every deployed instance is a public sign-up form. Sign-up is
 * closed by default, with exactly four ways through:
 *
 *  1. **The first-run owner**, and only via `/api/bootstrap` — never by calling
 *     the sign-up endpoint directly.
 *  2. **An invitation.** The address holds a pending invitation from someone
 *     who already has the right to invite.
 *  3. **An explicit opt-in**, for anyone genuinely running open registration.
 *  4. **The server creating one itself**, for a named address, through
 *     {@link allowSignupFor} — how sentrello.com makes a billing account at
 *     checkout. A request that merely arrives at the sign-up endpoint can
 *     never reach this.
 */
export async function signUpAllowed(
  email: string | undefined,
  openRegistration = process.env.SENTRELLO_ALLOW_SIGNUP === "true",
): Promise<
  { allowed: true; reason: string } | { allowed: false; reason: string }
> {
  if (bootstrapping) {
    return { allowed: true, reason: "first-run owner via /api/bootstrap" };
  }
  if (email && expected.has(email.trim().toLowerCase())) {
    return { allowed: true, reason: "created by the server for this address" };
  }
  if (openRegistration) {
    return { allowed: true, reason: "open registration is enabled" };
  }

  if (email) {
    const [invitation] = await db
      .select({ id: schema.invitation.id })
      .from(schema.invitation)
      .where(
        and(
          eq(schema.invitation.email, email.toLowerCase()),
          eq(schema.invitation.status, "pending"),
        ),
      )
      .limit(1);
    if (invitation) return { allowed: true, reason: "invited" };
  }

  return { allowed: false, reason: "sign-up is closed on this instance" };
}

/**
 * Whether the caller holds the setup token, when one is configured.
 *
 * The installer writes a random token into the instance's .env, so claiming a
 * fresh instance requires access to the machine running it rather than merely
 * finding its URL first. Unset means no token is demanded, which suits an
 * instance that is not publicly reachable yet.
 */
export function setupTokenAccepted(
  provided: string | undefined,
  expected = process.env.SENTRELLO_SETUP_TOKEN,
): boolean {
  if (!expected) return true;
  if (!provided || provided.length !== expected.length) return false;

  // constant time: this is a bearer credential
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return mismatch === 0;
}

export function setupTokenRequired(
  expected = process.env.SENTRELLO_SETUP_TOKEN,
): boolean {
  return Boolean(expected);
}

/** Rejects sign-ups that `signUpAllowed` does not permit. */
export const signUpGuard = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== "/sign-up/email") return;

  const email = (ctx.body as { email?: string } | undefined)?.email;
  const decision = await signUpAllowed(email);
  if (!decision.allowed) {
    throw new APIError("FORBIDDEN", {
      message:
        "This Sentrello instance is not accepting new accounts. Ask an administrator for an invitation.",
    });
  }
});
