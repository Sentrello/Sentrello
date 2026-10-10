import { AsyncLocalStorage } from "node:async_hooks";
import { and, db, eq, schema } from "@sentrello/db";
import { APIError, createAuthMiddleware } from "better-auth/api";

/**
 * Set only inside the call the bootstrap route makes to create the first owner.
 *
 * "This instance has no organization yet" is NOT sufficient on its own: the
 * sign-up endpoint is public, so a stranger who reaches a fresh instance before
 * its operator would claim it. Claiming therefore has to go through
 * /api/bootstrap, which additionally requires the setup token.
 *
 * Carried by the call, not held by the process. This was a module-level flag,
 * so for as long as the owner's account took to create, sign-up was open to
 * every request the server was answering: a stranger posting to the sign-up
 * endpoint at that moment got an account. The allowance now travels with the
 * async context of the bootstrap call itself, and a request arriving over HTTP
 * runs in its own context, which never holds it.
 */
const allowance = new AsyncLocalStorage<
  { bootstrap: true } | { bootstrap: false; email: string }
>();

/** Whether this very call is the bootstrap route claiming the instance. */
export function duringBootstrapNow(): boolean {
  return allowance.getStore()?.bootstrap === true;
}

export function duringBootstrap<T>(fn: () => Promise<T>): Promise<T> {
  return allowance.run({ bootstrap: true }, fn);
}

/**
 * The server creating an account for one address, inside one call.
 *
 * Scoped to the address and to the call. A process-wide set of addresses was
 * what this held before, so for the milliseconds checkout took to make a
 * billing account, anybody posting to the sign-up endpoint with that same
 * address got the account, with a password they chose. The allowance now
 * lives in the call's own async context, like the bootstrap one above.
 */
export async function allowSignupFor<T>(
  email: string,
  fn: () => Promise<T>,
): Promise<T> {
  return allowance.run(
    { bootstrap: false, email: email.trim().toLowerCase() },
    fn,
  );
}

function allowedAddressNow(email: string | undefined): boolean {
  const held = allowance.getStore();
  return (
    !!email &&
    held?.bootstrap === false &&
    held.email === email.trim().toLowerCase()
  );
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
  if (duringBootstrapNow()) {
    return { allowed: true, reason: "first-run owner via /api/bootstrap" };
  }
  if (allowedAddressNow(email)) {
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

/**
 * The same rule for an account made at the end of a Google sign-in.
 *
 * `signUpGuard` above reads `/sign-up/email`, and the library creates the
 * account for a social sign-in inside its own callback, which that path never
 * names — so with Google switched on, anybody holding a Google account came
 * away with an account and a session on a business that had never invited
 * them. Found 10 October 2026.
 *
 * Only the social paths. An identity provider under `/sso/` was connected by
 * an administrator for their own domain, and provisioning the people it vouches
 * for is the reason it exists.
 */
export async function socialSignUpGuard(
  email: string | undefined,
  path: string | undefined,
): Promise<void> {
  if (!path || !(path.startsWith("/callback") || path === "/sign-in/social")) {
    return;
  }
  const decision = await signUpAllowed(email);
  if (!decision.allowed) {
    throw new APIError("FORBIDDEN", {
      message:
        "This Sentrello instance is not accepting new accounts. Ask an administrator for an invitation.",
    });
  }
}
