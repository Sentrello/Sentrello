import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, schema } from "@sentrello/db";
import { dropOrganization } from "@sentrello/db/testing";
import { registerForTest } from "@sentrello/module-sdk";
import usersModule from "./index";

/**
 * Every administrative route in this module, refused to somebody who may not
 * administer.
 *
 * One table rather than twenty-nine tests, because the thing worth holding is
 * the property — *no route in this module answers a caller without
 * `settings`* — and a property is what a future route should have to satisfy
 * without anybody remembering to write a test for it.
 *
 * Written after the branch's finishing review mutated all twenty-nine gates
 * one at a time: **twenty-one of them could be deleted with the whole suite
 * still green.** Three separate gates had already shipped unheld and been
 * caught individually by mutation, which is what made the sweep worth running;
 * this is what stops the next one.
 *
 * The caller is a real member of the organization holding the compiled
 * `member` role, which carries no `settings` statement at all — the shape of
 * an ordinary employee, or a customer with a portal account. `requireSession`
 * passes for them and `requirePermission` is the only thing between them and
 * the route, which is exactly what is being pinned.
 *
 * Ids in the paths are deliberately fictional. The permission guard runs
 * before any handler, so a refusal must not depend on the record existing —
 * and if one of these ever answers 404 instead of 403, that is the guard
 * having moved behind the lookup, which is its own bug.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const ownerEmail = `gates-owner-${suffix}@example.test`;
const memberEmail = `gates-member-${suffix}@example.test`;

const app = registerForTest(usersModule);

let orgId: string;
let memberHeaders: Headers;
let ownerId: string;
let memberId: string;

beforeAll(async () => {
  const owner = await signUpAsOwner({
    email: ownerEmail,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const ownerCookie = owner.headers.get("set-cookie");
  if (!ownerCookie) throw new Error("sign-up returned no session cookie");
  ownerId = owner.response.user.id;

  const org = await auth.api.createOrganization({
    body: { name: `Gates ${suffix}`, slug: `gates-${suffix}` },
    headers: new Headers({
      cookie: ownerCookie,
      "content-type": "application/json",
    }),
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;

  const member = await signUpAsOwner({
    email: memberEmail,
    password: "correct-horse-battery-staple",
    name: "An Employee",
  });
  const memberCookie = member.headers.get("set-cookie");
  if (!memberCookie) throw new Error("sign-up returned no session cookie");
  memberId = member.response.user.id;
  memberHeaders = new Headers({
    cookie: memberCookie,
    "content-type": "application/json",
  });
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: memberId,
    role: "member",
    baseRole: "member",
    createdAt: new Date(),
  });
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers: memberHeaders,
  });
});

afterAll(async () => {
  await db
    .delete(schema.securityEvents)
    .where(eq(schema.securityEvents.organizationId, orgId));
  await db
    .delete(schema.securityPolicy)
    .where(eq(schema.securityPolicy.organizationId, orgId));
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await dropOrganization(orgId);
  for (const id of [ownerId, memberId]) {
    await db.delete(schema.session).where(eq(schema.session.userId, id));
    await db.delete(schema.account).where(eq(schema.account.userId, id));
    await db.delete(schema.user).where(eq(schema.user.id, id));
  }
});

/** Every route this module gates, as method and path. */
const ROUTES: [string, string][] = [
  ["GET", "/api/users"],
  ["PATCH", "/api/users/nobody"],
  ["DELETE", "/api/users/nobody"],
  ["POST", "/api/users/nobody/role"],
  ["POST", "/api/users/nobody/password"],
  ["POST", "/api/users/nobody/two-factor/revoke"],
  ["POST", "/api/users/nobody/sessions/revoke"],
  ["POST", "/api/users/nobody/unlock"],
  ["DELETE", "/api/users/invitations/nothing"],
  ["GET", "/api/users/nobody/access"],
  ["GET", "/api/users/roles"],
  ["GET", "/api/users/roles/staff"],
  ["GET", "/api/users/groups"],
  ["POST", "/api/users/groups"],
  ["PATCH", "/api/users/groups/nothing"],
  ["DELETE", "/api/users/groups/nothing"],
  ["GET", "/api/users/groups/nothing/access"],
  ["POST", "/api/users/groups/nothing/members"],
  ["DELETE", "/api/users/groups/nothing/members/nobody"],
  ["GET", "/api/users/policy"],
  ["PUT", "/api/users/policy"],
  ["GET", "/api/users/diagnostics"],
  ["GET", "/api/users/events"],
  ["GET", "/api/users/sessions"],
  ["GET", "/api/users/nobody/sessions"],
  ["DELETE", "/api/users/nobody/sessions/nothing"],
  ["GET", "/api/users/sso"],
  ["POST", "/api/users/sso"],
  ["DELETE", "/api/users/sso/nothing"],
];

test("no administrative route in this module answers somebody without settings", async () => {
  const answered: string[] = [];

  for (const [method, path] of ROUTES) {
    const res = await app.request(`http://localhost${path}`, {
      method,
      headers: memberHeaders,
      ...(method === "GET" || method === "DELETE"
        ? {}
        : { body: JSON.stringify({}) }),
    });
    if (res.status !== 403) answered.push(`${method} ${path} → ${res.status}`);
  }

  // Named rather than counted: a failure here should say which door opened.
  expect(answered).toEqual([]);
});

test("the same caller is refused before the record is looked up, not after", async () => {
  // Every path above names something fictional. If a route ever answers 404
  // rather than 403, its guard has moved behind the lookup — which leaks
  // whether a record exists to somebody with no business asking.
  const res = await app.request("http://localhost/api/users/nobody", {
    method: "PATCH",
    headers: memberHeaders,
    body: JSON.stringify({ disabled: true }),
  });
  expect(res.status).toBe(403);
});
