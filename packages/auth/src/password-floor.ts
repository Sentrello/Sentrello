import { db, desc, schema } from "@sentrello/db";
import { APIError, createAuthMiddleware } from "better-auth/api";

/**
 * The shortest password this business will accept.
 *
 * `security_policy.min_password_length` has been on the screen, validated on
 * write and stored since the Users module shipped, and **nothing ever read
 * it**. The effective floor stayed the twelve characters configured on the
 * auth library, so a business that set sixteen — because its own framework or
 * its insurer asks for sixteen — was told it had sixteen and had twelve.
 *
 * Found 2026-09-28, beside the per-role second factor, which was the same
 * failure: a security control saved, displayed, and applied by no code at all.
 * The pair of them is why a setting that is not read is worse than a setting
 * that does not exist.
 *
 * The library's own twelve stays as the floor under the floor: a business may
 * raise this and never lower it, because twelve is what 800-63B asks of a
 * memorised secret with no other factor and it is not a business's to waive.
 */
const LIBRARY_FLOOR = 12;

/**
 * One organisation per instance, which is what every deployment is today.
 *
 * Where a future hosted tier puts several on one process, the strictest wins.
 * That is the safe direction to be wrong in, and it is written down here
 * rather than discovered: a password rule that relaxes because somebody else
 * signed up would be the worse failure.
 *
 * Cached for ten seconds, like the other policy reads on this path, so a
 * sign-up does not pay for a query every time somebody mistypes.
 */
let cached: { at: number; floor: number } | null = null;
const TTL_MS = 10_000;

export async function passwordFloor(): Promise<number> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.floor;

  const [row] = await db
    .select({ length: schema.securityPolicy.minPasswordLength })
    .from(schema.securityPolicy)
    .orderBy(desc(schema.securityPolicy.minPasswordLength))
    .limit(1);
  const floor = Math.max(LIBRARY_FLOOR, row?.length ?? LIBRARY_FLOOR);
  cached = { at: Date.now(), floor };
  return floor;
}

/** So saving the policy takes effect on the next sign-up rather than in ten seconds. */
export function forgetPasswordFloor(): void {
  cached = null;
}

/**
 * Every way a password is set, not only the form.
 *
 * A rule enforced on one screen is a rule the API does not have. These are
 * the three endpoints that take a new password: creating an account, changing
 * your own, and setting one from a reset link.
 */
const SETS_A_PASSWORD = new Set([
  "/sign-up/email",
  "/change-password",
  "/reset-password",
]);

export const passwordFloorGuard = createAuthMiddleware(async (ctx) => {
  if (!SETS_A_PASSWORD.has(ctx.path)) return;

  const body = ctx.body as
    | { password?: unknown; newPassword?: unknown }
    | undefined;
  // `password` on sign-up, `newPassword` on the other two.
  const chosen = body?.newPassword ?? body?.password;
  if (typeof chosen !== "string") return;

  const floor = await passwordFloor();
  if (chosen.length >= floor) return;

  throw new APIError("BAD_REQUEST", {
    message: `This business asks for at least ${floor} characters.`,
  });
});
