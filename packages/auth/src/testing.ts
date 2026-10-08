import { auth } from "./index";
import { duringBootstrap } from "./signup-policy";

/**
 * Creates an account the way a first-run owner is created, without going near
 * `SENTRELLO_ALLOW_SIGNUP`.
 *
 * Test files run concurrently, so mutating `process.env` in one leaks into the
 * others — a suite that flipped the flag to assert the guard would silently
 * disable it for everything running alongside it. This takes the sanctioned
 * bootstrap path instead, so the guard stays armed everywhere.
 */
export async function signUpAsOwner(body: {
  email: string;
  password: string;
  name: string;
}) {
  return duringBootstrap(() =>
    auth.api.signUpEmail({ body, returnHeaders: true }),
  );
}

/**
 * Somebody who works here and holds exactly the permissions named.
 *
 * Written after the same forty lines appeared in four test files on one day —
 * create a policy, sign somebody up, insert the membership, set their active
 * organization — each time to ask one question: is this route refused to a role
 * that may only read?
 *
 * **The last step is the one that is easy to miss.** The membership is written
 * straight into the table, after this person's session already exists, so the
 * session's own active-organization hook (which runs once, at creation, reading
 * whichever membership existed then) never ran for it. Without
 * `setActiveOrganization` their session has no organization and *every*
 * permission check on it fails for that reason — so a test asserting 403 passes
 * whatever gate the route has, including none.
 */
export async function memberWith(options: {
  organizationId: string;
  /** The owner's headers, which is who may create a policy. */
  ownerHeaders: Headers;
  /** For example `{ dashboard: ["read"], projects: ["read"] }`. */
  permission: Record<string, string[]>;
  email: string;
  name?: string;
  /** A policy name of its own, so parallel files do not collide. */
  role?: string;
}): Promise<{ headers: Headers; userId: string; role: string }> {
  const { db, schema } = await import("@sentrello/db");
  const role = options.role ?? `test policy ${crypto.randomUUID().slice(0, 8)}`;

  await auth.api.createOrgRole({
    body: {
      organizationId: options.organizationId,
      role,
      permission: options.permission,
    },
    headers: options.ownerHeaders,
  });

  const person = await signUpAsOwner({
    email: options.email,
    password: "correct-horse-battery-staple",
    name: options.name ?? "A Colleague",
  });
  const cookie = person.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  const headers = new Headers({ cookie, "content-type": "application/json" });

  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: options.organizationId,
    userId: person.response.user.id,
    role,
    baseRole: role,
    createdAt: new Date(),
  });
  await auth.api.setActiveOrganization({
    body: { organizationId: options.organizationId },
    headers,
  });

  return { headers, userId: person.response.user.id, role };
}
