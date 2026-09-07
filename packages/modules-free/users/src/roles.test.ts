import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { and, db, eq, schema } from "@sentrello/db";
import { registerForTest } from "@sentrello/module-sdk";
import { seedDefaults } from "./defaults";
import usersModule from "./index";

/**
 * One role's own detail: what it grants, and everybody who holds it.
 *
 * `GET /api/users/roles` already lists every role with what each grants;
 * this is the drill-down a screen needs when an administrator clicks one —
 * who holds it, directly or through a group, and which groups carry it.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const ownerEmail = `roles-owner-${suffix}@example.test`;
const directEmail = `roles-direct-${suffix}@example.test`;
const throughGroupEmail = `roles-group-${suffix}@example.test`;

const app = registerForTest(usersModule);

let orgId: string;
let headers: Headers;
let ownerId: string;
let directId: string;
let throughGroupId: string;
let groupId: string;

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email: ownerEmail,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const set = signUp.headers.get("set-cookie");
  if (!set) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie: set, "content-type": "application/json" });
  ownerId = signUp.response.user.id;

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

  // Seeded so "staff" is a role this organization can actually grant to a
  // group — `POST /api/users/groups` refuses a role nobody has defined.
  await seedDefaults(orgId, headers);

  // Holds `staff` directly.
  const direct = await signUpAsOwner({
    email: directEmail,
    password: "correct-horse-battery-staple",
    name: "Direct Holder",
  });
  directId = direct.response.user.id;
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: directId,
    role: "staff",
    baseRole: "staff",
    createdAt: new Date(),
  });

  // A group that carries `staff`, and a second person who holds it only
  // through that group — their own base role is `customer`, which does not
  // grant it on its own.
  const group = await app.request("http://localhost/api/users/groups", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: `Carries Staff ${suffix}`, roles: ["staff"] }),
  });
  const groupBody = (await group.json()) as { group?: { id: string } };
  if (!groupBody.group) throw new Error("could not create the group");
  groupId = groupBody.group.id;

  const throughGroup = await signUpAsOwner({
    email: throughGroupEmail,
    password: "correct-horse-battery-staple",
    name: "Through The Group",
  });
  throughGroupId = throughGroup.response.user.id;
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: throughGroupId,
    role: "customer",
    baseRole: "customer",
    createdAt: new Date(),
  });
  await app.request(`http://localhost/api/users/groups/${groupId}/members`, {
    method: "POST",
    headers,
    body: JSON.stringify({ userId: throughGroupId }),
  });
});

afterAll(async () => {
  await db
    .delete(schema.userGroupMembers)
    .where(eq(schema.userGroupMembers.organizationId, orgId));
  await db
    .delete(schema.userGroups)
    .where(eq(schema.userGroups.organizationId, orgId));
  await db
    .delete(schema.securityPolicy)
    .where(eq(schema.securityPolicy.organizationId, orgId));
  await db
    .delete(schema.securityEvents)
    .where(eq(schema.securityEvents.organizationId, orgId));
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  for (const email of [ownerEmail, directEmail, throughGroupEmail]) {
    const [u] = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, email));
    if (u) {
      await db.delete(schema.session).where(eq(schema.session.userId, u.id));
      await db.delete(schema.account).where(eq(schema.account.userId, u.id));
      await db.delete(schema.user).where(eq(schema.user.id, u.id));
    }
  }
});

test("a policy names everybody who holds it, directly and through a group", async () => {
  const res = await app.request("http://localhost/api/users/roles/staff", {
    headers,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    role: string;
    permission: Record<string, string[]>;
    members: { userId: string }[];
    groups: { id: string; name: string }[];
  };

  expect(body.role).toBe("staff");
  // Positive assertions first: real grants, real members, real groups.
  expect(Object.keys(body.permission).length).toBeGreaterThan(0);
  expect(body.members.length).toBeGreaterThan(0);
  expect(body.groups.length).toBeGreaterThan(0);

  const memberIds = body.members.map((m) => m.userId);
  expect(memberIds).toContain(directId);
  expect(memberIds).toContain(throughGroupId);
  // The owner holds `admin`, not `staff` — not everybody is listed.
  expect(memberIds).not.toContain(ownerId);

  expect(body.groups.map((g) => g.id)).toContain(groupId);
});

test("a role nobody holds still answers, with nobody in it", async () => {
  const res = await app.request("http://localhost/api/users/roles/accounting", {
    headers,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    role: string;
    members: { userId: string }[];
    groups: { id: string; name: string }[];
  };
  expect(body.role).toBe("accounting");
  expect(body.members).toHaveLength(0);
  // The seeded Accounting group carries `accounting` even though nobody has
  // joined it in this fixture — a role and its holders are different
  // questions, and this pins that this route answers the second honestly
  // even when the first is empty.
  expect(body.groups.some((g) => g.name === "Accounting")).toBe(true);
});

/**
 * Ruling 45, on the third route found expressing the rule its own way.
 *
 * `GET /api/users/roles` was corrected to union a stored row into a compiled
 * role rather than let it replace one, and `permissionsForRole` was moved into
 * this very file to hold that answer once. This route — the single-policy half
 * of the same pair, and the source the policy record screen renders — kept the
 * old expression until the branch's finishing review found it. The screen's
 * whole job is answering "what does this role allow", so understating `admin`
 * here is the same defect on the same subject as the one already fixed twice.
 */
test("a stored row under a compiled name adds to it on the single-policy route too", async () => {
  await db.insert(schema.organizationRole).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    role: "admin",
    permission: JSON.stringify({ crm: ["read"], inventory: ["read"] }),
  });

  const res = await app.request("http://localhost/api/users/roles/admin", {
    headers,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    permission: Record<string, string[]>;
  };

  // The compiled floor survives a narrower row...
  expect(body.permission.settings).toContain("update");
  expect(body.permission.bookkeeping).toContain("delete");
  // ...and the row still adds what no built-in mentions.
  expect(body.permission.inventory).toEqual(["read"]);

  await db
    .delete(schema.organizationRole)
    .where(
      and(
        eq(schema.organizationRole.organizationId, orgId),
        eq(schema.organizationRole.role, "admin"),
      ),
    );
});
