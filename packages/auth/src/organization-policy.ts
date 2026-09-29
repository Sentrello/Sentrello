import { db, sql } from "@sentrello/db";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { duringBootstrapNow } from "./signup-policy";

/**
 * How many businesses one instance holds, which is one.
 *
 * Every public page in the product answers for "the organisation on this
 * instance": a storefront, a booking page, a signup form all arrive with no
 * session, so with two businesses there is nothing to tell them apart and each
 * of those pages refuses. That refusal is correct, and it made the accident
 * silent — the admin screens carry on working, and a customer following the
 * link to the shop gets "not found".
 *
 * The accident is easy: `POST /api/auth/organization/create` is better Auth's
 * own endpoint and anybody signed in could call it. It is also not undoable
 * from inside the product, since deleting an organisation is refused.
 *
 * So the second one is refused instead, at the door, with the reason. The first
 * is created by `/api/bootstrap`, which is how an instance is claimed.
 *
 * `SENTRELLO_MULTI_TENANT=true` lifts it, for the hosted tier this product's
 * schema has always been shaped for — every business table carries an
 * `organizationId` precisely so that day needs no migration.
 */
export async function organizationsAllowed(
  multiTenant = process.env.SENTRELLO_MULTI_TENANT === "true",
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  if (multiTenant) return { allowed: true };
  if (duringBootstrapNow()) return { allowed: true };

  try {
    const [row] = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from organizations`,
    );
    if ((row?.count ?? 0) === 0) return { allowed: true };
  } catch {
    // A database that cannot answer is not a reason to refuse the first
    // organisation on an instance somebody is claiming.
    return { allowed: true };
  }

  return {
    allowed: false,
    reason:
      "This Sentrello instance already holds a business, and it is built for one. Every public page — a shop, a booking page, a signup form — arrives without a sign-in and would have no way to tell two apart.",
  };
}

/** Refuses a second organization on an instance that serves one business. */
export const organizationGuard = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== "/organization/create") return;
  /*
   * Only a request from outside.
   *
   * `auth.api.createOrganization(...)` called by this codebase — the bootstrap
   * route, a module's own setup, and every suite that needs a second business
   * to prove an organisation filter with — carries no `request`. Those are ours
   * and they are allowed; what this closes is the endpoint anybody signed in
   * could post to from a browser.
   */
  if (!ctx.request) return;
  const decision = await organizationsAllowed();
  if (!decision.allowed) {
    throw new APIError("FORBIDDEN", { message: decision.reason });
  }
});
