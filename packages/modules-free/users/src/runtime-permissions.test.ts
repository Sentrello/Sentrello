import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth, statement } from "@sentrello/auth";
import { mayAccess } from "@sentrello/auth/hono";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { and, db, eq, schema } from "@sentrello/db";
import { registerForTest } from "@sentrello/module-sdk";
import { resolveAccess } from "./access";
import { seedDefaults } from "./defaults";
import usersModule from "./index";

/**
 * The fast answer and the enforced one have to agree.
 *
 * `/api/_meta` now hands the browser a grant set so a screen can disable a
 * control the person cannot use. It is built from `resolveAccess`, which
 * unions the person's own policy, the roles they hold unattributed and every
 * group they are in — one pass, because the statement has twenty-one
 * resources with two to five actions apiece and asking the permission check
 * per control is eighty questions to draw a screen.
 *
 * That makes two readings of one rule, which is the exact shape that has gone
 * wrong in this module twice: `GET /api/users/roles` said a stored row
 * *replaced* a compiled role's statements when Better Auth unions them, and
 * the group screen worked the union out in the browser. Both were corrected
 * once and stayed wrong in the other place.
 *
 * So this asks both, for every resource and every action in the statement,
 * and fails on the first disagreement. Not a sample — the whole vocabulary,
 * because the one that drifts will be the one nobody thought to sample.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const email = `runtime-perms-${suffix}@example.test`;
let orgId = "";
let userId = "";
let headers: Headers;

beforeAll(async () => {
  registerForTest(usersModule);
  const signUp = await signUpAsOwner({
    email,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  userId = signUp.response.user.id;
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    headers,
    body: { name: `Runtime perms ${suffix}`, slug: `runtime-perms-${suffix}` },
  });
  orgId = (org as { id: string }).id;
  await auth.api.setActiveOrganization({
    headers,
    body: { organizationId: orgId },
  });
  await seedDefaults(orgId, headers);
});

/**
 * By id, never with an unscoped delete — this database is shared by every
 * suite in the repository and one of those has been run against it already.
 */
afterAll(async () => {
  if (orgId) {
    await db
      .delete(schema.securityPolicy)
      .where(eq(schema.securityPolicy.organizationId, orgId));
    await db
      .delete(schema.userGroups)
      .where(eq(schema.userGroups.organizationId, orgId));
    await db
      .delete(schema.securityEvents)
      .where(eq(schema.securityEvents.organizationId, orgId));
    await db
      .delete(schema.member)
      .where(eq(schema.member.organizationId, orgId));
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, orgId));
  }
  if (userId) {
    await db.delete(schema.session).where(eq(schema.session.userId, userId));
    await db.delete(schema.account).where(eq(schema.account.userId, userId));
    await db.delete(schema.user).where(eq(schema.user.id, userId));
  }
});

/**
 * A member with a narrower policy than the owner, so the comparison has
 * something to disagree about. An owner holds nearly everything, and two
 * implementations that both answer "yes" to every question agree on nothing
 * worth knowing.
 */
test("what the browser is told matches what the routes enforce", async () => {
  // Narrowed to staff, which holds some of the statement and not the rest.
  await db
    .update(schema.member)
    .set({ role: "staff", baseRole: "staff" })
    .where(
      and(
        eq(schema.member.userId, userId),
        eq(schema.member.organizationId, orgId),
      ),
    );

  const { grants } = await resolveAccess(orgId, userId);
  const told = new Set(grants.map((g) => `${g.resource}:${g.action}`));
  // A vacuous pass would be two empty answers agreeing.
  expect(told.size).toBeGreaterThan(0);

  const disagreed: string[] = [];
  let denied = 0;
  let asked = 0;
  for (const [resource, actions] of Object.entries(statement)) {
    for (const action of actions as readonly string[]) {
      asked += 1;
      const enforced = await mayAccess(headers, { [resource]: [action] });
      if (!enforced) denied += 1;
      if (enforced !== told.has(`${resource}:${action}`)) {
        disagreed.push(
          `${resource}:${action} — routes say ${enforced}, the browser is told ${told.has(`${resource}:${action}`)}`,
        );
      }
    }
  }
  expect(disagreed).toEqual([]);
  // Two implementations that both say yes to everything agree on nothing
  // worth knowing. Staff is narrower than the statement, so some of this has
  // to come back refused or the comparison above proved nothing.
  expect(`${denied > 0} of ${asked > 20}`).toBe("true of true");
});
