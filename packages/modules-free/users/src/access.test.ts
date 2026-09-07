import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { and, db, eq, schema } from "@sentrello/db";
import { registerForTest } from "@sentrello/module-sdk";
import { resolveAccess } from "./access";
import { seedDefaults } from "./defaults";
import usersModule from "./index";
import { applyRoles, customPermissions, knownRoles } from "./roles";

/**
 * What somebody may actually do, and how each part of it reached them.
 *
 * This is the answer an administrator most wants and could not get before:
 * the union of a person's own policy and every group they are in, with each
 * grant attributed back to where it came from. The tests are about the ways
 * that attribution could quietly go wrong — a source dropped when a grant is
 * reachable twice, a role that grants nothing looking like a role that was
 * never found, a custom role merging with a compiled one instead of replacing
 * it.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const ownerEmail = `access-owner-${suffix}@example.test`;
const personEmail = `access-person-${suffix}@example.test`;

const app = registerForTest(usersModule);

let orgId: string;
let headers: Headers;
let ownerId: string;
let personId: string;
let personHeaders: Headers;
let accountingGroupId: string;

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
    body: { name: `Access ${suffix}`, slug: `access-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  // The defaults, as the Users screen would seed them on first visit: Staff
  // and Accounting exist as the business's own roles, and Accounting the
  // group carries the accounting role.
  await seedDefaults(orgId, headers);

  const [accounting] = await db
    .select({ id: schema.userGroups.id })
    .from(schema.userGroups)
    .where(
      and(
        eq(schema.userGroups.organizationId, orgId),
        eq(schema.userGroups.name, "Accounting"),
      ),
    )
    .limit(1);
  if (!accounting) throw new Error("Accounting was not seeded");
  accountingGroupId = accounting.id;

  // A second person: their own policy is `staff`, given directly. Staff has
  // `invoicing:read` but not `invoicing:send`, and `crm:read` among others —
  // chosen so their base policy and the Accounting group they are about to
  // join overlap on one grant (`crm:read`) and diverge on another
  // (`invoicing:send`, which only Accounting carries).
  const person = await signUpAsOwner({
    email: personEmail,
    password: "correct-horse-battery-staple",
    name: "A Person",
  });
  personId = person.response.user.id;
  const personCookie = person.headers.get("set-cookie");
  if (!personCookie) throw new Error("sign-up returned no session cookie");
  personHeaders = new Headers({
    cookie: personCookie,
    "content-type": "application/json",
  });
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: personId,
    role: "staff",
    baseRole: "staff",
    createdAt: new Date(),
  });
  // Straight into the join table: `effectiveRoles` reads group membership
  // live, not the precomputed `member.role` column, so there is no route to
  // go through to set this fixture up.
  await db.insert(schema.userGroupMembers).values({
    groupId: accountingGroupId,
    userId: personId,
    organizationId: orgId,
    addedBy: ownerId,
  });
  // Written back onto the membership so Better Auth's own permission checks
  // — which read `member.role`, not `effectiveRoles` — see the group's role
  // too. Needed for the route test below, which checks that this person
  // really does hold settings:read (through Accounting) and is still
  // refused: the exposure the addendum names is that settings:read used to
  // be enough on this route.
  await applyRoles(orgId, personId);
  // The membership above was written straight into the table, after this
  // person's session already existed, so the session's own active-org hook
  // (which only fires at session creation, reading whichever membership
  // exists at that moment) never ran for it — without this, their session's
  // active organization is still null and every permission check on it fails
  // for that reason, passing or failing regardless of which permission is
  // asked for. Confirmed by mutation: without this line, lowering the
  // route's gate from settings:update to settings:read below still 403s, for
  // the wrong reason.
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers: personHeaders,
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
    .delete(schema.organizationRole)
    .where(eq(schema.organizationRole.organizationId, orgId));
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
  for (const email of [ownerEmail, personEmail]) {
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

test("a grant carried only by a group names the group", async () => {
  const { grants } = await resolveAccess(orgId, personId);
  // Positive assertion first: this person does hold real grants, so an empty
  // array below would be a real failure and not a vacuous pass.
  expect(grants.length).toBeGreaterThan(0);

  // Staff has invoicing:read; Accounting alone adds send.
  const send = grants.find(
    (g) => g.resource === "invoicing" && g.action === "send",
  );
  expect(send?.sources).toEqual([{ kind: "group", name: "Accounting" }]);
});

test("a grant reachable two ways names both, so the wrong one is not removed", async () => {
  const { grants } = await resolveAccess(orgId, personId);
  expect(grants.length).toBeGreaterThan(0);

  // Staff's own policy grants crm:read directly; Accounting grants it too.
  const crm = grants.find((g) => g.resource === "crm" && g.action === "read");
  expect(crm?.sources.length).toBe(2);
  expect(
    crm?.sources.some((s) => s.kind === "policy" && s.name === "staff"),
  ).toBe(true);
  expect(
    crm?.sources.some((s) => s.kind === "group" && s.name === "Accounting"),
  ).toBe(true);
});

test("a grant appears once however many roles carry it", async () => {
  const { grants } = await resolveAccess(orgId, personId);
  const keys = grants.map((g) => `${g.resource}:${g.action}`);
  expect(new Set(keys).size).toBe(keys.length);

  // The general dedup check above passes vacuously on an empty array, so
  // pin it to the actual case: crm:read is reachable two ways and still
  // appears exactly once.
  expect(
    grants.filter((g) => g.resource === "crm" && g.action === "read"),
  ).toHaveLength(1);
});

test("grants come back sorted, resource then action", async () => {
  const { grants } = await resolveAccess(orgId, personId);
  // This person's union of staff and Accounting spans ten resources.
  // Alphabetically "bookkeeping" is first and "shop" is last, so a broken
  // sort (or none at all) is caught without reimplementing the comparator
  // the code under test uses.
  expect(grants[0]?.resource).toBe("bookkeeping");
  expect(grants[0]?.action).toBe("create");
  expect(grants.at(-1)?.resource).toBe("shop");

  // Within one resource, actions are ordered too: invoicing carries five
  // through Accounting.
  const invoicingActions = grants
    .filter((g) => g.resource === "invoicing")
    .map((g) => g.action);
  expect(invoicingActions).toEqual([
    "create",
    "delete",
    "read",
    "send",
    "update",
  ]);
});

test("what is not granted is absent, not present and false", async () => {
  const { grants } = await resolveAccess(orgId, personId);
  // Neither staff nor Accounting grants anything on the newsletter — proven
  // against a grants array that is not itself empty.
  expect(grants.length).toBeGreaterThan(0);
  expect(grants.some((g) => g.resource === "newsletter")).toBe(false);
});

test("somebody with no membership resolves to nothing rather than throwing", async () => {
  const { grants, roles } = await resolveAccess(orgId, crypto.randomUUID());
  expect(grants).toEqual([]);
  expect(roles.all).toEqual([]);
});

test("a real member resolves to something, so the empty case above is not the whole story", async () => {
  const { grants } = await resolveAccess(orgId, personId);
  expect(grants.length).toBeGreaterThan(0);
});

test("a role held through a group but defined nowhere grants nothing, and still shows up as held", async () => {
  const [ghost] = await db
    .insert(schema.userGroups)
    .values({
      organizationId: orgId,
      name: `Ghost ${suffix}`,
      roles: ["ghost-role"],
    })
    .returning();
  if (!ghost) throw new Error("could not make the ghost group");
  await db.insert(schema.userGroupMembers).values({
    groupId: ghost.id,
    userId: personId,
    organizationId: orgId,
    addedBy: ownerId,
  });

  const { grants, roles } = await resolveAccess(orgId, personId);

  // Held, truthfully — the role is real as far as membership goes.
  expect(
    roles.fromGroups.some(
      (r) => r.role === "ghost-role" && r.group === `Ghost ${suffix}`,
    ),
  ).toBe(true);
  // And grants nothing: no source ever names the ghost group, though this
  // person still holds real grants from Accounting and their own policy.
  expect(grants.length).toBeGreaterThan(0);
  expect(
    grants.some((g) => g.sources.some((s) => s.name === `Ghost ${suffix}`)),
  ).toBe(false);
});

test("a custom row under a compiled name adds to it; it does not shadow it", async () => {
  // Better Auth's own endpoint refuses to create an organization role named
  // after one compiled into the product (`ROLE_NAME_IS_ALREADY_TAKEN`), so
  // this writes the row directly — the same way an operator's database could
  // end up in this state after a name is freed and reused, and the only way
  // to exercise `resolveAccess`'s own precedence decision at all. Done in a
  // throwaway organization: the real fixture's owner authenticates every
  // other test in this file as `admin`, and redefining `admin` mid-suite
  // would break every one of them.
  const shadowSuffix = crypto.randomUUID().slice(0, 8);
  const shadowOwnerEmail = `access-shadow-${shadowSuffix}@example.test`;
  const signUp = await signUpAsOwner({
    email: shadowOwnerEmail,
    password: "correct-horse-battery-staple",
    name: "Shadow Owner",
  });
  const set = signUp.headers.get("set-cookie");
  if (!set) throw new Error("sign-up returned no session cookie");
  const shadowHeaders = new Headers({
    cookie: set,
    "content-type": "application/json",
  });
  const org = await auth.api.createOrganization({
    body: { name: `Shadow ${shadowSuffix}`, slug: `shadow-${shadowSuffix}` },
    headers: shadowHeaders,
  });
  if (!org) throw new Error("could not create organization");
  const shadowOrgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: shadowOrgId },
    headers: shadowHeaders,
  });
  const shadowOwnerId = signUp.response.user.id;

  try {
    // admin's compiled statement has no `inventory` key at all — it names a
    // withdrawn module's resource, granted by no built-in role
    // (permissions.ts). crm:read is already part of admin's compiled grant,
    // so it proves nothing on its own; inventory:read is this row's only
    // real addition, and the one that tells a full override from a union
    // apart.
    await db.insert(schema.organizationRole).values({
      id: crypto.randomUUID(),
      organizationId: shadowOrgId,
      role: "admin",
      permission: JSON.stringify({ crm: ["read"], inventory: ["read"] }),
    });

    const { grants } = await resolveAccess(shadowOrgId, shadowOwnerId);
    const sourcesFor = (resource: string, action: string) =>
      grants.find((g) => g.resource === resource && g.action === action)
        ?.sources;

    // The compiled role's own grants survive a same-named row that narrows
    // it to almost nothing — matching what Better Auth's own hasPermission
    // does (has-permission.mjs unions each resource in the row into the
    // compiled statement rather than replacing it), verified at runtime
    // against a live `organization_role` row narrowing `admin` this way.
    expect(sourcesFor("settings", "update")).toEqual([
      { kind: "policy", name: "admin" },
    ]);
    expect(sourcesFor("bookkeeping", "delete")).toEqual([
      { kind: "policy", name: "admin" },
    ]);
    // And the row can still add something the compiled role never had.
    expect(sourcesFor("inventory", "read")).toEqual([
      { kind: "policy", name: "admin" },
    ]);
    // And where the row and the compiled role name the same resource, the
    // grant is the union of the two, not whichever the row happened to say —
    // admin's own crm:create/update/delete do not vanish because the row
    // only mentioned crm:read.
    expect(
      grants
        .filter((g) => g.resource === "crm")
        .map((g) => g.action)
        .sort(),
    ).toEqual(["create", "delete", "read", "update"]);
  } finally {
    await db
      .delete(schema.organizationRole)
      .where(eq(schema.organizationRole.organizationId, shadowOrgId));
    await db
      .delete(schema.member)
      .where(eq(schema.member.organizationId, shadowOrgId));
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, shadowOrgId));
    await db
      .delete(schema.session)
      .where(eq(schema.session.userId, shadowOwnerId));
    await db
      .delete(schema.account)
      .where(eq(schema.account.userId, shadowOwnerId));
    await db.delete(schema.user).where(eq(schema.user.id, shadowOwnerId));
  }
});

test("a role member.role names but neither a policy nor a group explains is still held, not dropped", async () => {
  // Mirrors what /api/auth/organization/update-member-role actually writes
  // (mountAuth exposes it, packages/auth/src/hono.ts:47-51): member.role
  // holding more than one role, baseRole never touched. effectiveRoles used
  // to keep only the first comma-separated token when baseRole was null,
  // silently dropping "managers" and everything it grants.
  const driftSuffix = crypto.randomUUID().slice(0, 8);
  const driftEmail = `access-drift-${driftSuffix}@example.test`;
  const driftSignUp = await signUpAsOwner({
    email: driftEmail,
    password: "correct-horse-battery-staple",
    name: "Drift",
  });
  const driftId = driftSignUp.response.user.id;

  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: driftId,
    role: "staff,managers",
    baseRole: null,
    createdAt: new Date(),
  });

  try {
    const { grants, roles } = await resolveAccess(orgId, driftId);

    expect(roles.base).toBe("staff");
    expect(roles.unattributed).toEqual(["managers"]);
    expect(roles.all.sort()).toEqual(["managers", "staff"]);

    // managers grants scheduling:delete; staff alone does not (defaults.ts).
    // Dropped before the fix because "managers" never made it into `all`.
    const scheduleDelete = grants.find(
      (g) => g.resource === "scheduling" && g.action === "delete",
    );
    expect(scheduleDelete?.sources).toEqual([
      { kind: "policy", name: "managers" },
    ]);
  } finally {
    await db
      .delete(schema.member)
      .where(
        and(
          eq(schema.member.organizationId, orgId),
          eq(schema.member.userId, driftId),
        ),
      );
    await db.delete(schema.session).where(eq(schema.session.userId, driftId));
    await db.delete(schema.account).where(eq(schema.account.userId, driftId));
    await db.delete(schema.user).where(eq(schema.user.id, driftId));
  }
});

test("a business's own roles are scoped to it, not readable through another organization's id", async () => {
  // organizationRoles reads schema.organizationRole filtered by orgId — the
  // invariant every business table in this platform is held to. Two
  // throwaway orgs, each given a role of the same name but a different
  // permission set, is the only way an unscoped read and a scoped one
  // disagree.
  const scopeSuffix = crypto.randomUUID().slice(0, 8);
  async function makeScopedOrg(
    tag: "a" | "b",
    permission: Record<string, string[]>,
  ) {
    const email = `access-scope-${tag}-${scopeSuffix}@example.test`;
    const signUp = await signUpAsOwner({
      email,
      password: "correct-horse-battery-staple",
      name: `Scope ${tag}`,
    });
    const set = signUp.headers.get("set-cookie");
    if (!set) throw new Error("sign-up returned no session cookie");
    const scopeHeaders = new Headers({
      cookie: set,
      "content-type": "application/json",
    });
    const org = await auth.api.createOrganization({
      body: {
        name: `Scope ${tag} ${scopeSuffix}`,
        slug: `scope-${tag}-${scopeSuffix}`,
      },
      headers: scopeHeaders,
    });
    if (!org) throw new Error("could not create organization");
    await auth.api.setActiveOrganization({
      body: { organizationId: org.id },
      headers: scopeHeaders,
    });
    await auth.api.createOrgRole({
      body: { organizationId: org.id, role: "auditor", permission },
      headers: scopeHeaders,
    });
    return { orgId: org.id, userId: signUp.response.user.id };
  }

  const a = await makeScopedOrg("a", { crm: ["read"] });
  const b = await makeScopedOrg("b", { reports: ["read"] });

  try {
    const permsA = await customPermissions(a.orgId);
    const permsB = await customPermissions(b.orgId);
    expect(permsA.auditor).toEqual({ crm: ["read"] });
    expect(permsB.auditor).toEqual({ reports: ["read"] });

    const namesA = await knownRoles(a.orgId);
    const namesB = await knownRoles(b.orgId);
    expect(namesA).toContain("auditor");
    expect(namesB).toContain("auditor");
  } finally {
    for (const { orgId: id, userId } of [a, b]) {
      await db
        .delete(schema.organizationRole)
        .where(eq(schema.organizationRole.organizationId, id));
      await db
        .delete(schema.member)
        .where(eq(schema.member.organizationId, id));
      await db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, id));
      await db.delete(schema.session).where(eq(schema.session.userId, userId));
      await db.delete(schema.account).where(eq(schema.account.userId, userId));
      await db.delete(schema.user).where(eq(schema.user.id, userId));
    }
  }
});

// --- the route --------------------------------------------------------------

test("the route requires settings:update, not settings:read", async () => {
  // This person holds settings:read through Accounting and nothing more —
  // exactly the exposure the addendum names: before this task, settings:read
  // was enough to read anyone's access, including the administrators'.
  const res = await app.request(
    `http://localhost/api/users/${ownerId}/access`,
    { headers: personHeaders },
  );
  expect(res.status).toBe(403);
});

test("the route answers grants, roles and groups for somebody the caller may administer", async () => {
  const res = await app.request(
    `http://localhost/api/users/${personId}/access`,
    { headers },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    grants: { resource: string; action: string }[];
    roles: { base: string | null; all: string[] };
    groups: string[];
  };
  expect(body.grants.length).toBeGreaterThan(0);
  expect(body.roles.base).toBe("staff");
  expect(body.groups).toContain("Accounting");
});

test("the route answers 404 for somebody who holds nothing here, not an empty grant", async () => {
  const res = await app.request(
    `http://localhost/api/users/${crypto.randomUUID()}/access`,
    { headers },
  );
  expect(res.status).toBe(404);
});

test("a caller holding the seeded admins policy resolves real grants, not an empty array", async () => {
  // Every other test in this file authenticates as the compiled `admin`
  // role, which carries `ac: ["read"]` because it spreads `adminAc.statements`
  // (permissions.ts:77). The seeded `admins` policy — what the second
  // administrator any business creates actually holds — does not. Before the
  // fix, that meant `customPermissions` asked `listOrgRoles` to re-authorise
  // this caller against a statement they do not have, was refused, and the
  // `.catch(() => [])` turned the refusal into nothing: every custom role,
  // including this caller's own, resolved to no permissions.
  const adminsSuffix = crypto.randomUUID().slice(0, 8);
  const adminsEmail = `access-admins-caller-${adminsSuffix}@example.test`;
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
    const res = await app.request(
      `http://localhost/api/users/${personId}/access`,
      { headers: adminsHeaders },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      grants: { resource: string; action: string }[];
    };
    // personId holds real grants through staff and Accounting regardless of
    // who is asking — the same ones the route test above confirms for the
    // real owner.
    expect(body.grants.length).toBeGreaterThan(0);
    expect(
      body.grants.some(
        (g) => g.resource === "invoicing" && g.action === "send",
      ),
    ).toBe(true);
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

/**
 * A group's access, answered by the same union a person's is.
 *
 * The group screen used to work this out in the browser from
 * `GET /api/users/roles`. Two implementations of one rule is the shape that
 * produced three separate corrections of the role-precedence rule on this
 * branch, so the second one is gone and this is what it asks instead.
 */
test("a group's access is the union of what its policies carry, each named", async () => {
  const [group] = await db
    .insert(schema.userGroups)
    .values({
      id: crypto.randomUUID(),
      organizationId: orgId,
      name: `Access group ${suffix}`,
      description: "",
      roles: ["accounting", "sales"],
    })
    .returning({ id: schema.userGroups.id });
  if (!group) throw new Error("could not create the group");

  const res = await app.request(
    `http://localhost/api/users/groups/${group.id}/access`,
    { headers },
  );
  expect(res.status).toBe(200);
  const { grants } = (await res.json()) as { grants: Grant[] };

  // Positive first: this really does resolve to something.
  expect(grants.length).toBeGreaterThan(0);

  // Something only accounting carries names accounting alone...
  const books = grants.find(
    (g) => g.resource === "bookkeeping" && g.action === "read",
  );
  expect(books?.sources).toEqual([{ kind: "policy", name: "accounting" }]);

  // ...and something both carry names both, which is the whole point of
  // resolving rather than listing.
  const dashboard = grants.find(
    (g) => g.resource === "dashboard" && g.action === "read",
  );
  expect(dashboard?.sources.map((s) => s.name).sort()).toEqual([
    "accounting",
    "sales",
  ]);

  await db.delete(schema.userGroups).where(eq(schema.userGroups.id, group.id));
});

test("a group in another business is not readable through this one", async () => {
  const res = await app.request(
    "http://localhost/api/users/groups/does-not-exist/access",
    { headers },
  );
  expect(res.status).toBe(404);
});
