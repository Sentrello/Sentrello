import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, inArray, schema } from "@sentrello/db";
import { organizationMember } from "@sentrello/db/membership";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { Hono } from "hono";
import crm from "./index";

/**
 * An owner id is a person, and a person belongs to a business.
 *
 * `contacts.owner_id`, `companies.owner_id`, `deals.owner_id` and
 * `tasks.assignee_id` hold platform user ids, and every one of them used to be
 * written exactly as it arrived. The `user` table has no `organization_id` —
 * it cannot have one, since the same person may work at two businesses — so a
 * stranger's id stored on a record is a name from another business waiting for
 * something to resolve it onto this one's screen.
 *
 * Two businesses here, each with its own owner, because a single-business
 * database cannot tell the difference.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const app = new Hono<SentrelloEnv>();

let orgId: string;
let headers: Headers;
/** Somebody at the *other* business, whose name must never appear here. */
let strangerId: string;
const strangerName = `Stranger ${suffix}`;
let theirOrgId: string;

beforeAll(async () => {
  crm.register({
    app,
    entitled: () => true,
    registerNav: () => {},
    registerPermission: () => {},
    registerSummary: () => {},
    registerWidget: () => {},
    registerAccountSection: () => {},
    registerSearch: () => {},
    registerPersonalData: () => {},
    registerOnboarding: () => {},
    registerCrawlable: () => {},
    provide: () => {},
    registerJob: () => {},
  });

  const mine = await signUpAsOwner({
    email: `crm-member-${suffix}@example.test`,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = mine.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });
  const org = await auth.api.createOrganization({
    body: { name: `Member ${suffix}`, slug: `member-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  const theirs = await signUpAsOwner({
    email: `crm-stranger-${suffix}@example.test`,
    password: "correct-horse-battery-staple",
    name: strangerName,
  });
  const theirCookie = theirs.headers.get("set-cookie");
  if (!theirCookie) throw new Error("sign-up returned no session cookie");
  const theirHeaders = new Headers({
    cookie: theirCookie,
    "content-type": "application/json",
  });
  const theirOrg = await auth.api.createOrganization({
    body: { name: `Stranger ${suffix}`, slug: `stranger-${suffix}` },
    headers: theirHeaders,
  });
  if (!theirOrg) throw new Error("could not create the other organization");
  theirOrgId = theirOrg.id;
  const [them] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, `crm-stranger-${suffix}@example.test`));
  if (!them) throw new Error("the other owner has no user row");
  strangerId = them.id;
});

afterAll(async () => {
  for (const [table, column] of [
    [schema.tasks, schema.tasks.organizationId],
    [schema.deals, schema.deals.organizationId],
    [schema.companies, schema.companies.organizationId],
    [schema.contacts, schema.contacts.organizationId],
  ] as const) {
    await db.delete(table).where(eq(column, orgId));
  }
  for (const org of [orgId, theirOrgId]) {
    await db.delete(schema.member).where(eq(schema.member.organizationId, org));
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, org));
  }
  const emails = [
    `crm-member-${suffix}@example.test`,
    `crm-stranger-${suffix}@example.test`,
  ];
  const users = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(inArray(schema.user.email, emails));
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await db.delete(schema.session).where(inArray(schema.session.userId, ids));
    await db.delete(schema.account).where(inArray(schema.account.userId, ids));
    await db.delete(schema.user).where(inArray(schema.user.id, ids));
  }
});

const post = (path: string, body: unknown) =>
  app.request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

test("the helper answers for this business only", async () => {
  const [me] = await db
    .select({ userId: schema.member.userId })
    .from(schema.member)
    .where(eq(schema.member.organizationId, orgId));
  if (!me) throw new Error("the owner is not a member of their own business");

  expect(await organizationMember(orgId, me.userId)).toBe(me.userId);
  // A real person, a real id, and not ours: the whole point.
  expect(await organizationMember(orgId, strangerId)).toBeNull();
  expect(await organizationMember(theirOrgId, strangerId)).toBe(strangerId);
  // And anything that is not an id at all, so a caller can hand it a raw
  // field from a request without checking it first.
  expect(await organizationMember(orgId, "not-a-user")).toBeNull();
  expect(await organizationMember(orgId, undefined)).toBeNull();
  expect(await organizationMember(orgId, "   ")).toBeNull();
  expect(await organizationMember("", me.userId)).toBeNull();
});

test("a suspended member is still a member", async () => {
  const [me] = await db
    .select({ id: schema.member.id, userId: schema.member.userId })
    .from(schema.member)
    .where(eq(schema.member.organizationId, orgId));
  if (!me) throw new Error("the owner is not a member of their own business");

  await db
    .update(schema.member)
    .set({ disabledAt: new Date() })
    .where(eq(schema.member.id, me.id));
  try {
    /*
     * The platform's answer, decided here: `disabledAt` stops somebody signing
     * in, not being ours. The column exists so a person who has left keeps
     * their name on the work they did — and a helper that hid them would make
     * that work unreadable and unassignable to anybody else. Giving new work
     * to somebody suspended for a fortnight is a business mistake to correct
     * on a screen, not a disclosure to refuse at the database.
     */
    expect(await organizationMember(orgId, me.userId)).toBe(me.userId);
  } finally {
    await db
      .update(schema.member)
      .set({ disabledAt: null })
      .where(eq(schema.member.id, me.id));
  }
});

test("a user id from another organization is refused on write", async () => {
  const created = await post("/api/contacts", {
    name: "Acme Ltd",
    ownerId: strangerId,
  });
  // 400, not 404: the id is not a record this caller was reaching for, it is
  // a value in a field they filled in wrongly.
  expect(created.status).toBe(400);
  expect((await created.json()) as { error: string }).toEqual({
    error: "the owner is not a member of this organization",
  });

  // And nothing was written on the way to being refused.
  const [none] = await db
    .select({ id: schema.contacts.id })
    .from(schema.contacts)
    .where(eq(schema.contacts.ownerId, strangerId));
  expect(none).toBeUndefined();
});

test("a task cannot be assigned to somebody we do not employ", async () => {
  const created = await post("/api/tasks", {
    title: "Call Dave",
    assigneeId: strangerId,
  });
  expect(created.status).toBe(400);
  expect(((await created.json()) as { error: string }).error).toContain(
    "assignee",
  );
});

test("an owner cannot be moved to a stranger by a later edit either", async () => {
  const created = await post("/api/contacts", { name: "Halloway" });
  expect(created.status).toBe(201);
  const { contact } = (await created.json()) as { contact: { id: string } };

  const patched = await app.request(
    `http://localhost/api/contacts/${contact.id}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({ ownerId: strangerId }),
    },
  );
  expect(patched.status).toBe(400);

  // Unassigning is still a real thing to do, and must not be refused.
  const cleared = await app.request(
    `http://localhost/api/contacts/${contact.id}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({ ownerId: null }),
    },
  );
  expect(cleared.status).toBe(200);
});

test("a row already holding a foreign id never discloses that person", async () => {
  /*
   * The rows written before today. The check on the way in cannot help them,
   * so nothing that resolves an owner into a name may do it without asking
   * whose name it is — which in this module means the managers list, the only
   * place a user id becomes a person.
   */
  const [planted] = await db
    .insert(schema.contacts)
    .values({ organizationId: orgId, name: "Planted", ownerId: strangerId })
    .returning({ id: schema.contacts.id });
  if (!planted) throw new Error("could not plant the row");

  for (const path of [
    "/api/contacts",
    `/api/contacts/${planted.id}/related`,
    "/api/crm/managers",
  ]) {
    const res = await app.request(`http://localhost${path}`, { headers });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain(strangerName);
    expect(body).not.toContain(`crm-stranger-${suffix}@example.test`);
  }
});
