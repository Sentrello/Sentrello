import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, inArray, schema } from "@sentrello/db";
import { registerForTest } from "@sentrello/module-sdk";
import usersModule from "./index";

/**
 * Nothing in this module hands one business another business's data.
 *
 * Every business query is `organizationId` scoped — one organization per self-hosted instance today, and the filter is
 * what keeps a hosted tier possible later. The branch's finishing review
 * mutated all forty-six of those filters in this module one at a time, turning
 * each into a tautology that still reads as a filter: **thirty-four of them
 * could be neutered with the whole suite still green.**
 *
 * That is not thirty-four bugs — the filters are all correct. It is thirty-four
 * places where a wrong one would ship unnoticed, on a single-organization
 * product whose own tests can never notice, because a suite with one business
 * in it cannot tell a scoped query from an unscoped one.
 *
 * So this is one property rather than thirty-four tests: **a caller in one
 * organization never sees, and never changes, anything belonging to another.**
 * Two businesses exist here, the second stuffed with a marker in every table
 * this module reads, and the first's owner goes looking for it.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const aEmail = `tenancy-a-${suffix}@example.test`;
const bEmail = `tenancy-b-${suffix}@example.test`;

/** In every one of B's rows, and in none of A's. */
const MARKER = `zzmarker${suffix}`;

const app = registerForTest(usersModule);

let aOrgId: string;
let bOrgId: string;
let aHeaders: Headers;
let aUserId: string;
let bUserId: string;
let bGroupId: string;

async function makeBusiness(email: string, name: string) {
  const signUp = await signUpAsOwner({
    email,
    password: "correct-horse-battery-staple",
    name,
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  const headers = new Headers({ cookie, "content-type": "application/json" });
  const org = await auth.api.createOrganization({
    body: {
      name: `${name} ${suffix}`,
      slug: `${name.toLowerCase()}-${suffix}`,
    },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  await auth.api.setActiveOrganization({
    body: { organizationId: org.id },
    headers,
  });
  return { headers, orgId: org.id, userId: signUp.response.user.id };
}

beforeAll(async () => {
  const a = await makeBusiness(aEmail, "Alpha");
  aHeaders = a.headers;
  aOrgId = a.orgId;
  aUserId = a.userId;

  const b = await makeBusiness(bEmail, "Beta");
  bOrgId = b.orgId;
  bUserId = b.userId;

  // B's own rows, each carrying the marker, in every table this module reads.
  await db
    .update(schema.user)
    .set({ name: MARKER })
    .where(eq(schema.user.id, bUserId));

  const [group] = await db
    .insert(schema.userGroups)
    .values({
      id: crypto.randomUUID(),
      organizationId: bOrgId,
      name: MARKER,
      description: MARKER,
      roles: ["staff"],
    })
    .returning({ id: schema.userGroups.id });
  if (!group) throw new Error("could not create B's group");
  bGroupId = group.id;

  await db.insert(schema.userGroupMembers).values({
    id: crypto.randomUUID(),
    organizationId: bOrgId,
    groupId: bGroupId,
    userId: bUserId,
  });

  await db.insert(schema.organizationRole).values({
    id: crypto.randomUUID(),
    organizationId: bOrgId,
    role: MARKER,
    permission: JSON.stringify({ crm: ["read"] }),
  });

  await db.insert(schema.securityEvents).values({
    organizationId: bOrgId,
    action: "role.changed",
    actorName: MARKER,
    detail: { email: `${MARKER}@example.test` },
  });
});

afterAll(async () => {
  for (const orgId of [aOrgId, bOrgId]) {
    await db
      .delete(schema.securityEvents)
      .where(eq(schema.securityEvents.organizationId, orgId));
    await db
      .delete(schema.securityPolicy)
      .where(eq(schema.securityPolicy.organizationId, orgId));
    await db
      .delete(schema.organizationRole)
      .where(eq(schema.organizationRole.organizationId, orgId));
    await db
      .delete(schema.userGroupMembers)
      .where(eq(schema.userGroupMembers.organizationId, orgId));
    await db
      .delete(schema.userGroups)
      .where(eq(schema.userGroups.organizationId, orgId));
    await db
      .delete(schema.member)
      .where(eq(schema.member.organizationId, orgId));
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, orgId));
  }
  await db
    .delete(schema.session)
    .where(inArray(schema.session.userId, [aUserId, bUserId]));
  await db
    .delete(schema.account)
    .where(inArray(schema.account.userId, [aUserId, bUserId]));
  await db
    .delete(schema.user)
    .where(inArray(schema.user.id, [aUserId, bUserId]));
});

/** Everything this module will read for a caller who asks nicely. */
const READS = [
  "/api/users",
  "/api/users/roles",
  "/api/users/groups",
  "/api/users/policy",
  "/api/users/diagnostics",
  "/api/users/events",
  "/api/users/events?perPage=200",
  "/api/users/sessions",
  "/api/users/sso",
];

test("no read in this module returns another business's rows", async () => {
  const leaked: string[] = [];

  for (const path of READS) {
    const res = await app.request(`http://localhost${path}`, {
      headers: aHeaders,
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    if (body.includes(MARKER)) leaked.push(path);
  }

  // Named rather than counted, so a regression says which door opened.
  expect(leaked).toEqual([]);
});

/**
 * The other half: a caller who knows an id from another business, which is
 * the case a scoped read cannot cover. A leak here is worse than a listing
 * leak, because these change things.
 */
const REACHES: [string, string][] = [
  ["GET", `/api/users/${"USER"}`],
  ["GET", `/api/users/${"USER"}/access`],
  ["GET", `/api/users/${"USER"}/sessions`],
  ["PATCH", `/api/users/${"USER"}`],
  ["DELETE", `/api/users/${"USER"}`],
  ["POST", `/api/users/${"USER"}/role`],
  ["POST", `/api/users/${"USER"}/password`],
  ["POST", `/api/users/${"USER"}/unlock`],
  ["POST", `/api/users/${"USER"}/two-factor/revoke`],
  ["POST", `/api/users/${"USER"}/sessions/revoke`],
  ["GET", `/api/users/groups/${"GROUP"}/access`],
  ["PATCH", `/api/users/groups/${"GROUP"}`],
  ["DELETE", `/api/users/groups/${"GROUP"}`],
  ["POST", `/api/users/groups/${"GROUP"}/members`],
  ["DELETE", `/api/users/groups/${"GROUP"}/members/${"USER"}`],
];

test("no id from another business can be reached, read or changed", async () => {
  const reached: string[] = [];

  for (const [method, template] of REACHES) {
    const path = template
      .replace("USER", bUserId)
      .replace("USER", bUserId)
      .replace("GROUP", bGroupId);
    const res = await app.request(`http://localhost${path}`, {
      method,
      headers: aHeaders,
      ...(method === "GET" || method === "DELETE"
        ? {}
        : {
            body: JSON.stringify({
              disabled: true,
              role: "staff",
              userId: bUserId,
            }),
          }),
    });
    if (res.status === 200) reached.push(`${method} ${path} → 200`);
  }

  expect(reached).toEqual([]);

  // And B is untouched by all of that, which a 404 alone would not prove.
  const [stillThere] = await db
    .select({ name: schema.userGroups.name })
    .from(schema.userGroups)
    .where(eq(schema.userGroups.id, bGroupId));
  expect(stillThere?.name).toBe(MARKER);
  const [bMember] = await db
    .select({ disabledAt: schema.member.disabledAt })
    .from(schema.member)
    .where(eq(schema.member.userId, bUserId));
  expect(bMember?.disabledAt ?? null).toBeNull();
});
