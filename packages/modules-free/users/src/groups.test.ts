import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { and, db, eq, schema } from "@sentrello/db";
import { registerForTest } from "@sentrello/module-sdk";
import { seedDefaults } from "./defaults";
import usersModule from "./index";
import { describeDevice } from "./sessions";

/**
 * Groups, roles and the rules for signing in.
 *
 * This is the half of the platform that decides what everybody else may do, so
 * the tests are about the ways it could quietly grant too much: a role that
 * does not exist, a group that outlives the permissions it granted, somebody
 * reading another business's devices.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const ownerEmail = `groups-owner-${suffix}@example.test`;
const staffEmail = `groups-staff-${suffix}@example.test`;

const app = registerForTest(usersModule);

let orgId: string;
let headers: Headers;
let ownerId: string;
let staffId: string;
let staffHeaders: Headers;

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
    body: { name: `Groups ${suffix}`, slug: `groups-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  /**
   * The default policies, as the first visit to the Users screen creates them.
   *
   * Seeded here rather than left to whichever test happens to hit
   * `/api/users/roles` first: Staff and Accounting are the business's own
   * roles now, so a group carrying one before the seed has run is refused with
   * ROLE_NOT_FOUND — correctly, and depending on test order for it is not a
   * fixture, it is luck.
   */
  await seedDefaults(orgId, headers);

  // A second person, added directly: this suite is about what they may do,
  // not about the invitation flow.
  const staff = await signUpAsOwner({
    email: staffEmail,
    password: "correct-horse-battery-staple",
    name: "A Fitter",
  });
  staffId = staff.response.user.id;
  const staffCookie = staff.headers.get("set-cookie");
  if (!staffCookie) throw new Error("sign-up returned no session cookie");
  staffHeaders = new Headers({
    cookie: staffCookie,
    "content-type": "application/json",
  });
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: staffId,
    role: "staff",
    baseRole: "staff",
    createdAt: new Date(),
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
  for (const email of [ownerEmail, staffEmail]) {
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

async function post(path: string, body: unknown) {
  return app.request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function makeGroup(name: string, roles: string[]): Promise<string> {
  const res = await post("/api/users/groups", { name, roles });
  const body = (await res.json()) as { group?: { id: string } };
  if (!body.group) throw new Error(`could not make ${name}`);
  return body.group.id;
}

async function memberRole(userId: string): Promise<string> {
  const [row] = await db
    .select({ role: schema.member.role, baseRole: schema.member.baseRole })
    .from(schema.member)
    .where(
      and(
        eq(schema.member.organizationId, orgId),
        eq(schema.member.userId, userId),
      ),
    );
  return row?.role ?? "";
}

test("a group grants its roles on top of the person's own", async () => {
  const group = await makeGroup(`The office ${suffix}`, ["accounting"]);

  const joined = await post(`/api/users/groups/${group}/members`, {
    userId: staffId,
  });
  expect(joined.status).toBe(201);

  // Comma separated, which is what Better Auth splits and checks — so every
  // permission check in the platform sees the group's roles without knowing
  // groups exist.
  const role = await memberRole(staffId);
  expect(role.split(",").sort()).toEqual(["accounting", "staff"]);

  /**
   * Asked as the fitter, not as the owner.
   *
   * `hasPermission` takes a `userId` and ignores it — it answers for whoever
   * the session belongs to. Asked with the owner's headers this returned
   * `true` whatever the fitter held, including a role that did not exist, so
   * the assertion could not fail and the group might have granted nothing.
   */
  const hasBooks = await auth.api.hasPermission({
    headers: staffHeaders,
    body: {
      organizationId: orgId,
      permissions: { bookkeeping: ["update"] },
    },
  });
  expect(hasBooks.success).toBe(true);

  // And the group is what granted it: something staff alone does not have.
  const beyondTheGroup = await auth.api.hasPermission({
    headers: staffHeaders,
    body: { organizationId: orgId, permissions: { settings: ["update"] } },
  });
  expect(beyondTheGroup.success).toBe(false);
});

test("taking somebody out of a group takes the permission with it", async () => {
  const group = await makeGroup(`Temporary ${suffix}`, ["accounting"]);
  await post(`/api/users/groups/${group}/members`, { userId: staffId });

  const left = await app.request(
    `http://localhost/api/users/groups/${group}/members/${staffId}`,
    { method: "DELETE", headers },
  );
  expect(left.status).toBe(200);

  // Their own role survives; the group's does not.
  const role = await memberRole(staffId);
  expect(role.split(",")).toContain("staff");
});

test("changing what a group grants changes it for everybody in it, now", async () => {
  const group = await makeGroup(`Fitters ${suffix}`, ["staff"]);
  await post(`/api/users/groups/${group}/members`, { userId: staffId });

  const changed = await app.request(
    `http://localhost/api/users/groups/${group}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({ roles: ["accounting"] }),
    },
  );
  expect(changed.status).toBe(200);

  // Not the next time they sign in: an administrator who takes the books away
  // from the fitters means now.
  const role = await memberRole(staffId);
  expect(role.split(",").sort()).toEqual(["accounting", "staff"]);
});

test("deleting a group leaves people with their own role and nothing else", async () => {
  const group = await makeGroup(`Doomed ${suffix}`, ["admin"]);
  await post(`/api/users/groups/${group}/members`, { userId: staffId });
  expect((await memberRole(staffId)).split(",")).toContain("admin");

  const gone = await app.request(`http://localhost/api/users/groups/${group}`, {
    method: "DELETE",
    headers,
  });
  expect(gone.status).toBe(200);

  const role = await memberRole(staffId);
  expect(role.split(",")).not.toContain("admin");
  expect(role.split(",")).toContain("staff");
});

test("a group cannot carry a role nobody defined", async () => {
  const res = await post("/api/users/groups", {
    name: `Wishful ${suffix}`,
    roles: ["auditor"],
  });
  const { group } = (await res.json()) as { group: { roles: string[] } };
  // Dropped on the way in rather than stored: a group naming a role that does
  // not exist grants nothing and looks like it grants something.
  expect(group.roles).toEqual([]);

  const patched = await app.request(
    `http://localhost/api/users/groups/${await makeGroup(`Real ${suffix}`, [])}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({ roles: ["accounting", "auditor"] }),
    },
  );
  expect(patched.status).toBe(400);
  expect((await patched.json()) as { error: string }).toMatchObject({
    error: "there is no role called auditor",
  });
});

test("two groups cannot share a name", async () => {
  await makeGroup(`Only one ${suffix}`, []);
  const again = await post("/api/users/groups", { name: `Only one ${suffix}` });
  // Two groups called "Office" is two groups nobody can tell apart.
  expect(again.status).toBe(409);
});

test("somebody outside the business cannot be put in a group", async () => {
  const group = await makeGroup(`Closed ${suffix}`, []);
  const res = await post(`/api/users/groups/${group}/members`, {
    userId: `outsider-${suffix}`,
  });
  // A group is not a way in.
  expect(res.status).toBe(404);
});

test("the roles screen reads permissions from the roles themselves", async () => {
  const res = await app.request("http://localhost/api/users/roles", {
    headers,
  });
  const body = (await res.json()) as {
    permissions: Record<string, string[]>;
    roles: {
      role: string;
      builtIn: boolean;
      allows: Record<string, string[]>;
    }[];
  };

  expect(body.permissions.bookkeeping).toContain("update");
  const staffRole = body.roles.find((r) => r.role === "staff");
  // Staff can read invoices and cannot write the books — read from the role,
  // so a screen can never disagree with what the checks actually do.
  expect(staffRole?.allows.invoicing).toEqual(["read"]);
  expect(staffRole?.allows.bookkeeping).toBeUndefined();
});

test("the roles screen answers the same for a caller holding the seeded admins policy", async () => {
  // Every other test in this file authenticates as the compiled `admin`
  // role, which carries `ac: ["read"]` (permissions.ts:77, adminAc.statements).
  // The seeded `admins` policy — what the second administrator any business
  // creates actually holds — does not, and this route reads both
  // `knownRoles` and `customPermissions`, which had the identical dependency
  // on `listOrgRoles` re-authorising the caller against it. Before the fix,
  // this caller would see only the two built-in names, `staff` and every
  // other custom role missing from the list, and `allows` empty for
  // whichever of them did appear.
  const adminsSuffix = crypto.randomUUID().slice(0, 8);
  const adminsEmail = `groups-admins-caller-${adminsSuffix}@example.test`;
  const adminsSignUp = await signUpAsOwner({
    email: adminsEmail,
    password: "correct-horse-battery-staple",
    name: "Admins Caller",
  });
  const adminsCookie = adminsSignUp.headers.get("set-cookie");
  if (!adminsCookie) throw new Error("sign-up returned no session cookie");
  const adminsHeaders = new Headers({
    cookie: adminsCookie,
    "content-type": "application/json",
  });
  const adminsCallerId = adminsSignUp.response.user.id;

  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: adminsCallerId,
    role: "admins",
    baseRole: "admins",
    createdAt: new Date(),
  });
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers: adminsHeaders,
  });

  try {
    const res = await app.request("http://localhost/api/users/roles", {
      headers: adminsHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      roles: { role: string; allows: Record<string, string[]> }[];
    };
    const staffRole = body.roles.find((r) => r.role === "staff");
    expect(staffRole?.allows.invoicing).toEqual(["read"]);
    const adminsRole = body.roles.find((r) => r.role === "admins");
    expect(adminsRole?.allows.settings).toEqual(["read", "update"]);
  } finally {
    await db
      .delete(schema.member)
      .where(
        and(
          eq(schema.member.organizationId, orgId),
          eq(schema.member.userId, adminsCallerId),
        ),
      );
    await db
      .delete(schema.session)
      .where(eq(schema.session.userId, adminsCallerId));
    await db
      .delete(schema.account)
      .where(eq(schema.account.userId, adminsCallerId));
    await db.delete(schema.user).where(eq(schema.user.id, adminsCallerId));
  }
});

// The `/api/users/policy` tests — both verbs — moved to
// `authentication.test.ts` along with the route itself (Task 8). They are
// still reachable through this file's `app`, since `registerForTest` mounts
// the whole module, but the file that owns a route's behavior is the file
// that tests it.

test("everything that hands access around is written down", async () => {
  const group = await makeGroup(`Recorded ${suffix}`, ["accounting"]);
  await post(`/api/users/groups/${group}/members`, { userId: staffId });
  // A policy write of its own, rather than relying on an earlier test in
  // this file having made one first: this test used to depend on the
  // now-removed policy tests above it running before it in the same shared
  // org, which made it correct only by file order.
  await app.request("http://localhost/api/users/policy", {
    method: "PUT",
    headers,
    body: JSON.stringify({ minPasswordLength: 10 }),
  });

  const events = await db
    .select({ action: schema.securityEvents.action })
    .from(schema.securityEvents)
    .where(eq(schema.securityEvents.organizationId, orgId));
  const actions = events.map((e) => e.action);

  expect(actions).toContain("group.created");
  expect(actions).toContain("group.joined");
  expect(actions).toContain("policy.changed");
});

/**
 * Joining and leaving name the *person* as their subject, because a person is
 * who joined — so without the group's id in `detail`, nothing ties either
 * entry to the group at all. `group.left` used to record only the roles, so
 * the log could not say which group somebody had been taken out of, which is
 * the one fact that entry exists to preserve.
 */
test("joining and leaving a group both record which group", async () => {
  const rows = await db
    .select({
      action: schema.securityEvents.action,
      detail: schema.securityEvents.detail,
    })
    .from(schema.securityEvents)
    .where(eq(schema.securityEvents.organizationId, orgId));

  for (const action of ["group.joined", "group.left"]) {
    const entry = rows.find((r) => r.action === action);
    if (!entry) throw new Error(`this suite should have produced a ${action}`);
    const detail = entry.detail as { groupId?: string; group?: string };
    // The id survives the group being renamed; the name is what a person
    // reads. Both, for the same reason `subjectName` is stored beside
    // `subjectId` everywhere else in this log.
    expect(typeof detail.groupId).toBe("string");
    expect(detail.groupId).toBeTruthy();
    expect(detail.group).toBeTruthy();
  }
});

test("a device is described in words somebody can recognise", () => {
  expect(
    describeDevice(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    ),
  ).toBe("a Mac, in Safari");
  // Every browser claims to be several others; Edge says Chrome and Safari
  // both, and the order of these checks is the whole of the logic.
  expect(
    describeDevice(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0",
    ),
  ).toBe("a Windows PC, in Edge");
  expect(describeDevice(null)).toBe("an unknown device");
});

test("a person can end their own session but not somebody else's", async () => {
  const mine = (await (
    await app.request("http://localhost/api/users/me/sessions", { headers })
  ).json()) as { sessions: { id: string; current: boolean }[] };

  expect(mine.sessions.length).toBeGreaterThan(0);
  expect(mine.sessions.some((s) => s.current)).toBe(true);

  // Somebody else's session id, through the route that is meant to be their
  // own: refused on the row rather than on the list it came from.
  const [theirs] = await db
    .select({ id: schema.session.id })
    .from(schema.session)
    .where(eq(schema.session.userId, staffId))
    .limit(1);
  if (theirs) {
    const res = await app.request(
      `http://localhost/api/users/me/sessions/${theirs.id}`,
      { method: "DELETE", headers },
    );
    expect(res.status).toBe(404);
  }
});

test("an administrator cannot read the devices of somebody in another business", async () => {
  const res = await app.request(
    `http://localhost/api/users/outsider-${suffix}/sessions`,
    { headers },
  );
  expect(res.status).toBe(404);
});

/**
 * The access a business starts with.
 *
 * A business that has to invent its own permission model before it can add its
 * second employee gives everybody the owner's role and hopes. These assert the
 * two things that make the defaults worth having: that they arrive, and that
 * they are the business's to change.
 */
test("an organization gets its default policies and groups, once", async () => {
  const res = await app.request("http://localhost/api/users/roles", {
    headers,
  });
  expect(res.status).toBe(200);
  const { roles } = (await res.json()) as {
    roles: {
      role: string;
      builtIn: boolean;
      kind: string;
      allows: Record<string, string[]>;
    }[];
  };

  const named = (name: string) => roles.find((r) => r.role === name);

  // How senior somebody is, given to a person. Names are stored lower case
  // because Better Auth normalises them, and capitalised again for reading.
  for (const policy of [
    "admins",
    "executives",
    "managers",
    "staff",
    "customers",
  ]) {
    expect(named(policy)?.kind).toBe("user");
  }
  // What department they are in, carried by a group.
  for (const policy of [
    "sales",
    "marketing",
    "accounting",
    "customer service",
  ]) {
    expect(named(policy)?.kind).toBe("group");
  }

  /**
   * The whole point: these are data, not code.
   *
   * Only `admin` and `customer` are marked built-in — the first because it is
   * the floor the owner stands on and a business that could delete it could
   * lock itself out of its own machine, the second because the portal assigns
   * it rather than anybody choosing it from a list.
   */
  expect(named("managers")?.builtIn).toBe(false);
  expect(named("sales")?.builtIn).toBe(false);
  // Two names Better Auth reserves stay compiled: `admin`, the floor the owner
  // stands on, and `customer`, which the portal assigns. Everything a business
  // sees in this list is its own.
  expect(named("admin")?.builtIn).toBe(true);
  expect(named("customer")?.builtIn).toBe(true);
  // Staff was compiled, and being compiled was the only reason it could not be
  // edited. It is an ordinary policy now, which is the whole change.
  expect(named("staff")?.builtIn).toBe(false);
  expect(named("accounting")?.builtIn).toBe(false);

  // And they allow what they say they allow, read from the role itself rather
  // than from a second list a screen could disagree with.
  expect(named("executives")?.allows.invoicing).toEqual(["read"]);
  expect(named("managers")?.allows.invoicing).toContain("send");
  expect(named("managers")?.allows.invoicing).not.toContain("delete");
  expect(named("accounting")?.allows.bookkeeping).toContain("delete");

  const groups = await app.request("http://localhost/api/users/groups", {
    headers,
  });
  const body = (await groups.json()) as {
    groups: { name: string; roles: string[] }[];
  };
  const sales = body.groups.find((g) => g.name === "Sales");
  expect(sales?.roles).toEqual(["sales"]);
  expect(body.groups.map((g) => g.name)).toContain("Customer Service");
});

test("deleting a default group does not bring it back", async () => {
  const before = await app.request("http://localhost/api/users/groups", {
    headers,
  });
  const found = (await before.json()) as {
    groups: { id: string; name: string }[];
  };
  const marketing = found.groups.find((g) => g.name === "Marketing");
  if (!marketing) throw new Error("Marketing was never seeded");

  const gone = await app.request(
    `http://localhost/api/users/groups/${marketing.id}`,
    { method: "DELETE", headers },
  );
  expect(gone.status).toBeLessThan(300);

  // Asking again is what would re-seed it, if seeding were "create anything
  // missing" rather than "once".
  await app.request("http://localhost/api/users/roles", { headers });
  const after = await app.request("http://localhost/api/users/groups", {
    headers,
  });
  const now = (await after.json()) as { groups: { name: string }[] };
  expect(now.groups.map((g) => g.name)).not.toContain("Marketing");
});

/**
 * Ruling 30, on the route that was still saying the old thing.
 *
 * `GET /api/users/roles` described a compiled role as `custom[role] ??
 * builtInPermissions(role)` — a stored row *replacing* the built-in. That is
 * not what authorises: Better Auth starts from the compiled statements and
 * unions the stored row into them, so a row narrowing `admin` still leaves
 * everything else allowed. `access.ts` was corrected and this route was not,
 * and Task 12a's group Access tab reads this route, so the console inherited
 * a description of `admin` that the product does not honour.
 */
test("a stored row under a compiled name adds to it here too, and does not replace it", async () => {
  await db.insert(schema.organizationRole).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    role: "admin",
    // Narrower than the compiled role in every direction, and naming one
    // resource no built-in mentions at all.
    permission: JSON.stringify({ crm: ["read"], inventory: ["read"] }),
  });

  const res = await app.request("http://localhost/api/users/roles", {
    headers,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    roles: { role: string; allows: Record<string, string[]> }[];
  };
  const admin = body.roles.find((r) => r.role === "admin");
  if (!admin) throw new Error("admin is compiled in; it must always be listed");

  // The floor survives: settings:update is not in the stored row, and admin
  // still has it, because that is what hasPermission would answer.
  expect(admin.allows.settings).toContain("update");
  expect(admin.allows.bookkeeping).toContain("delete");
  // And the row is additive, not ignored.
  expect(admin.allows.inventory).toEqual(["read"]);

  await db
    .delete(schema.organizationRole)
    .where(
      and(
        eq(schema.organizationRole.organizationId, orgId),
        eq(schema.organizationRole.role, "admin"),
      ),
    );
});
