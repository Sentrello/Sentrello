import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import { eq } from "@sentrello/db/orm";
import { dropOrganization } from "@sentrello/db/testing";
import { registerForTest } from "@sentrello/module-sdk";
import { seedDefaults } from "./defaults";
import usersModule from "./index";

/**
 * The audit log, searchable rather than only skimmable.
 *
 * `GET /api/users` already shows the 25 most recent administrative changes;
 * this is where the whole log — sign-in traffic included — is read, filtered
 * to one action, one person, or a window of time. The tests are about
 * whether the filters actually narrow, and whether paging still gives an
 * honest total once they do.
 */

const app = registerForTest(usersModule);
const suffix = crypto.randomUUID().slice(0, 8);
const ownerEmail = `events-owner-${suffix}@example.test`;
const managerEmail = `events-manager-${suffix}@example.test`;

let headers: Headers;
let orgId: string;
let ownerId: string;

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email: ownerEmail,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });
  ownerId = signUp.response.user.id;

  const org = await auth.api.createOrganization({
    body: { name: `Events ${suffix}`, slug: `events-${suffix}` },
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
    .delete(schema.securityEvents)
    .where(eq(schema.securityEvents.organizationId, orgId));
  await db
    .delete(schema.securityPolicy)
    .where(eq(schema.securityPolicy.organizationId, orgId));
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await dropOrganization(orgId);
  await db.delete(schema.session).where(eq(schema.session.userId, ownerId));
  await db.delete(schema.account).where(eq(schema.account.userId, ownerId));
  await db.delete(schema.user).where(eq(schema.user.id, ownerId));
  const [manager] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, managerEmail));
  if (manager) {
    await db
      .delete(schema.session)
      .where(eq(schema.session.userId, manager.id));
    await db
      .delete(schema.account)
      .where(eq(schema.account.userId, manager.id));
    await db.delete(schema.user).where(eq(schema.user.id, manager.id));
  }
});

async function insertEvent(
  action: string,
  overrides: Partial<typeof schema.securityEvents.$inferInsert> = {},
) {
  await db.insert(schema.securityEvents).values({
    organizationId: orgId,
    action,
    ...overrides,
  });
}

test("events can be filtered to one action, and paged", async () => {
  const marker = `action-${suffix}`;
  for (let i = 0; i < 5; i += 1) {
    await insertEvent("group.created", {
      subjectName: `${marker}-${i}`,
      at: new Date(Date.now() - (10 - i) * 1000),
    });
  }
  // Noise the filter has to actually exclude, not just happen to skip.
  await insertEvent("policy.changed");
  await insertEvent("sign-in.failed");

  const first = await app.request(
    "http://localhost/api/users/events?action=group.created&perPage=2&page=1",
    { headers },
  );
  expect(first.status).toBe(200);
  const firstBody = (await first.json()) as {
    events: { action: string; subject: string | null }[];
    total: number;
  };
  // Positive assertion first: there really are matching rows, so an empty
  // page below would be a real failure and not a vacuous pass.
  expect(firstBody.events.length).toBeGreaterThan(0);
  expect(firstBody.events).toHaveLength(2);
  expect(firstBody.total).toBe(5);
  expect(firstBody.events.every((e) => e.action === "group.created")).toBe(
    true,
  );
  // Newest first: the last-inserted (`i === 4`) row leads the first page.
  expect(firstBody.events[0]?.subject).toBe(`${marker}-4`);

  const second = await app.request(
    "http://localhost/api/users/events?action=group.created&perPage=2&page=3",
    { headers },
  );
  const secondBody = (await second.json()) as {
    events: { subject: string | null }[];
    total: number;
  };
  // 5 rows, 2 per page: the third page holds the last, oldest one.
  expect(secondBody.events).toHaveLength(1);
  expect(secondBody.events[0]?.subject).toBe(`${marker}-0`);
  expect(secondBody.total).toBe(5);
});

test("events can be filtered to one subject", async () => {
  const targetId = `subject-${suffix}`;
  await insertEvent("role.changed", { subjectId: targetId });
  await insertEvent("role.changed", { subjectId: targetId });
  // Somebody else's row, in the same organization — the filter has to leave
  // this one out, not just happen to return the right count.
  await insertEvent("role.changed", { subjectId: `other-${suffix}` });

  const res = await app.request(
    `http://localhost/api/users/events?subject=${targetId}`,
    { headers },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    events: { subjectId: string | null }[];
    total: number;
  };
  expect(body.events.length).toBeGreaterThan(0);
  expect(body.total).toBe(2);
  expect(body.events.every((e) => e.subjectId === targetId)).toBe(true);
});

test("events can be filtered to a window of time", async () => {
  const marker = `window-${suffix}`;
  await insertEvent("group.changed", {
    subjectName: `${marker}-old`,
    at: new Date(Date.now() - 60_000),
  });
  await insertEvent("group.changed", {
    subjectName: `${marker}-inside`,
    at: new Date(Date.now() - 30_000),
  });
  await insertEvent("group.changed", {
    subjectName: `${marker}-new`,
    at: new Date(),
  });

  const from = new Date(Date.now() - 45_000).toISOString();
  const to = new Date(Date.now() - 15_000).toISOString();
  const res = await app.request(
    `http://localhost/api/users/events?action=group.changed&from=${from}&to=${to}`,
    { headers },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    events: { subject: string | null }[];
  };
  expect(body.events.length).toBeGreaterThan(0);
  expect(body.events.map((e) => e.subject)).toEqual([`${marker}-inside`]);
});

test("unpaged, it still answers with events rather than a person-shaped 404 — the route is not shadowed", async () => {
  const res = await app.request("http://localhost/api/users/events", {
    headers,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { events: unknown[]; error?: string };
  expect(body.error).toBeUndefined();
  expect(Array.isArray(body.events)).toBe(true);
});

/**
 * Ruling 34: dropping the `organizationId` condition at `events.ts:67`
 * currently leaves the whole suite green, because every exact-total
 * assertion above is already narrowed by a subject or action marker unique
 * to this file's own organization — a leak from another organization would
 * never show up in those totals. This test instead reads a second
 * organization's events through the first organization's session, with a
 * marker unique to that second organization, so a leak is the only way the
 * count comes out non-zero.
 */
test("one organization's events are invisible through another organization's session", async () => {
  const otherSuffix = crypto.randomUUID().slice(0, 8);
  const otherEmail = `events-other-${otherSuffix}@example.test`;
  const signUp = await signUpAsOwner({
    email: otherEmail,
    password: "correct-horse-battery-staple",
    name: "Other Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  const otherHeaders = new Headers({
    cookie,
    "content-type": "application/json",
  });
  const otherOwnerId = signUp.response.user.id;
  const otherOrg = await auth.api.createOrganization({
    body: { name: `Other ${otherSuffix}`, slug: `other-${otherSuffix}` },
    headers: otherHeaders,
  });
  if (!otherOrg) throw new Error("could not create organization");
  await auth.api.setActiveOrganization({
    body: { organizationId: otherOrg.id },
    headers: otherHeaders,
  });

  const marker = `cross-org-${otherSuffix}`;
  await db.insert(schema.securityEvents).values({
    organizationId: otherOrg.id,
    action: marker,
  });

  try {
    // Positive check first, so a broken filter query is not what makes the
    // count below zero: the row is really there, for the organization it
    // belongs to.
    const own = await app.request(
      `http://localhost/api/users/events?action=${marker}`,
      { headers: otherHeaders },
    );
    expect(((await own.json()) as { total: number }).total).toBe(1);

    const leaked = await app.request(
      `http://localhost/api/users/events?action=${marker}`,
      { headers },
    );
    expect(leaked.status).toBe(200);
    const body = (await leaked.json()) as {
      events: unknown[];
      total: number;
    };
    expect(body.total).toBe(0);
    expect(body.events).toHaveLength(0);
  } finally {
    await db
      .delete(schema.securityEvents)
      .where(eq(schema.securityEvents.organizationId, otherOrg.id));
    await db
      .delete(schema.securityPolicy)
      .where(eq(schema.securityPolicy.organizationId, otherOrg.id));
    await db
      .delete(schema.member)
      .where(eq(schema.member.organizationId, otherOrg.id));
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, otherOrg.id));
    await db
      .delete(schema.session)
      .where(eq(schema.session.userId, otherOwnerId));
    await db
      .delete(schema.account)
      .where(eq(schema.account.userId, otherOwnerId));
    await db.delete(schema.user).where(eq(schema.user.id, otherOwnerId));
  }
});

/**
 * Ruling 33. This route shipped at `settings:["read"]`, which `defaults.ts`
 * grants to executives, managers and accounting — so a manager who gets 403
 * from `GET /api/users` could read the owner's failed sign-in addresses,
 * every password reset and every role change. The gate is now
 * `settings:["update"]`, and this is what holds it there: changing it back
 * left the whole suite green.
 */
test("a manager — settings:read, not settings:update — cannot read the audit log", async () => {
  await seedDefaults(orgId, headers);

  const manager = await signUpAsOwner({
    email: managerEmail,
    password: "correct-horse-battery-staple",
    name: "A Manager",
  });
  const managerCookie = manager.headers.get("set-cookie");
  if (!managerCookie) throw new Error("sign-up returned no session cookie");
  const managerHeaders = new Headers({
    cookie: managerCookie,
    "content-type": "application/json",
  });
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: manager.response.user.id,
    role: "managers",
    baseRole: "managers",
    createdAt: new Date(),
  });
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers: managerHeaders,
  });

  const res = await app.request("http://localhost/api/users/events", {
    headers: managerHeaders,
  });
  expect(res.status).toBe(403);
});

/**
 * A group's own history is split across two shapes of event, and `?group=`
 * is what puts it back together: `group.created`/`changed`/`deleted` name the
 * group as their subject, while `group.joined`/`left` name the person who
 * joined. Filtering on subject alone returns half of it while looking whole,
 * which is the failure mode worth a test — an administrator reading a group's
 * Activity would conclude nobody had ever been added to it.
 */
test("everything about one group includes who joined it, not only what was done to it", async () => {
  const groupId = crypto.randomUUID();

  await db.insert(schema.securityEvents).values([
    {
      organizationId: orgId,
      action: "group.created",
      subjectId: groupId,
      subjectName: `Group ${suffix}`,
      detail: { roles: ["staff"] },
    },
    {
      organizationId: orgId,
      action: "group.joined",
      subjectId: ownerId,
      subjectName: "Owner",
      detail: { groupId, group: `Group ${suffix}`, roles: ["staff"] },
    },
    {
      organizationId: orgId,
      action: "group.left",
      subjectId: ownerId,
      subjectName: "Owner",
      detail: { groupId, group: `Group ${suffix}`, roles: [] },
    },
  ]);

  const res = await app.request(
    `http://localhost/api/users/events?group=${groupId}`,
    { headers },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { events: { action: string }[] };
  const actions = body.events.map((e) => e.action).sort();
  expect(actions).toEqual(["group.created", "group.joined", "group.left"]);

  // And `subject=` still means subject: the half that filtering that way
  // returns, which is what the tab used to show.
  const narrow = await app.request(
    `http://localhost/api/users/events?subject=${groupId}`,
    { headers },
  );
  const only = (await narrow.json()) as { events: { action: string }[] };
  expect(only.events.map((e) => e.action)).toEqual(["group.created"]);
});
