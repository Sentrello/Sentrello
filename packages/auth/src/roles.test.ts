import { afterAll, beforeAll, expect, test } from "bun:test";
import { db, schema } from "@sentrello/db";
import { eq } from "drizzle-orm";
import { auth } from "./index";
import { signUpAsOwner } from "./testing";

/**
 * Roles a business defines for itself.
 *
 * The five built in cover a handyman with three staff. They do not cover a
 * workshop manager who may see jobs and stock but not the books — and the
 * previous answer to that was "use Staff and hope", which grants more than
 * intended rather than less.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const email = `roles-${suffix}@x.test`;
let headers: Headers;
let orgId: string;

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Roles ${suffix}`, slug: `roles-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });
});

afterAll(async () => {
  await db
    .delete(schema.organizationRole)
    .where(eq(schema.organizationRole.organizationId, orgId));
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  const [u] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email));
  if (u) {
    await db.delete(schema.session).where(eq(schema.session.userId, u.id));
    await db.delete(schema.account).where(eq(schema.account.userId, u.id));
    await db.delete(schema.user).where(eq(schema.user.id, u.id));
  }
});

test("a business can define a role the product did not ship", async () => {
  const created = await auth.api.createOrgRole({
    body: {
      organizationId: orgId,
      role: "workshop-manager",
      /**
       * Deliberately a Free resource that ships with every instance.
       *
       * This test has twice been broken by naming an optional module here —
       * first `inventory`, then `projects` — because an admin can only
       * delegate permissions it holds, and a withdrawn module is granted to
       * nobody. What is under test is that a business can define a role at
       * all, not which resource it names.
       */
      permission: {
        crm: ["read"],
        invoicing: ["read", "create", "update"],
        dashboard: ["read"],
      },
    },
    headers,
  });
  expect(created).toBeTruthy();

  const roles = await auth.api.listOrgRoles({
    query: { organizationId: orgId },
    headers,
  });
  const names = (roles as { role: string }[]).map((r) => r.role);
  expect(names).toContain("workshop-manager");
});

test("the custom role is stored where permission checks will find it", async () => {
  // hasPermission reads this table and merges it with the compiled-in roles,
  // which is what lets requirePermission stay exactly as it was.
  const rows = await db
    .select()
    .from(schema.organizationRole)
    .where(eq(schema.organizationRole.organizationId, orgId));
  const row = rows.find((r) => r.role === "workshop-manager");
  expect(row).toBeTruthy();
  const permission = JSON.parse(row?.permission ?? "{}") as Record<
    string,
    string[]
  >;
  expect(permission.invoicing).toContain("update");
  // Not granted, and therefore absent — a role is what it says, not a
  // superset of somebody else's.
  expect(permission.bookkeeping).toBeUndefined();
});

/**
 * A role nobody can be given is decorative. This is the half that makes the
 * feature real.
 */
test("a custom role can actually be given to somebody", async () => {
  const second = `member-${suffix}@x.test`;
  // The instance refuses new accounts by design, so this takes the same
  // sanctioned path the owner helper does rather than flipping the guard —
  // test files run concurrently and the flag is process-wide.
  const signUp = await signUpAsOwner({
    email: second,
    password: "correct-horse-battery-staple",
    name: "Staffer",
  });
  expect(signUp).toBeTruthy();

  const [user] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, second));
  if (!user) throw new Error("no second user");

  // Started on one of the two roles still compiled in, because the point of
  // this test is moving somebody onto a role the business made for itself.
  // It used to start on `staff`, which is now one of those business-owned
  // roles and would have to be created before it could be given.
  const added = await auth.api.addMember({
    body: { userId: user.id, role: "customer", organizationId: orgId },
    headers,
  });
  expect(added).toBeTruthy();

  const updated = await auth.api.updateMemberRole({
    body: {
      memberId: (added as { id: string }).id,
      role: "workshop-manager",
      organizationId: orgId,
    },
    headers,
  });
  expect((updated as { role: string }).role).toBe("workshop-manager");

  // Cleanup: this user is outside the org teardown above.
  await db.delete(schema.member).where(eq(schema.member.userId, user.id));
  await db.delete(schema.session).where(eq(schema.session.userId, user.id));
  await db.delete(schema.account).where(eq(schema.account.userId, user.id));
  await db.delete(schema.user).where(eq(schema.user.id, user.id));
});
